import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { AgentRegistry } from "../registry.js"
import { RunRegistry } from "../runs.js"
import { MetricsCollector } from "../metrics.js"
import { createAgentRouter } from "../router/agent.js"
import { rmRetryAsync } from "./helpers/fs.js"

/**
 * issue #95 验收 1 的全链路端到端钉子（评审重要 3）：证明 caller 的
 * X-User-Id / runId 真正到达 **MCP 线上请求头**——
 *
 *   run（HTTP）→ AsyncLocalStorage 上下文 → McpHeaderProvider（动态 headers）
 *   → 真实 StreamableHTTPClientTransport → stub MCP 服务端记录的请求头
 *
 * 三个场景同时钉死验收 2 的语义读法（评审重要 4）：
 *  1. 带 X-User-Id 的 run（SSE 路径——生成器级 ALS 包裹）：tools/call 携带
 *     x-user-id + x-run-id（与响应头 X-Run-ID **精确相等**）+ 静态头叠加
 *  2. 未绑定会话 + 仅 X-User-Name（JSON 路径）：tools/call 无任何身份头
 *     （验收 2 字面 = 未绑定会话）
 *  3. 已绑定会话的后续 run 不带头（JSON 路径，resume）：tools/call 携带
 *     **恢复的** x-user-id + 新 run 的 x-run-id（需求 2「随会话生命周期
 *     存续」优先于验收 2 字面——已在 docs/configuration.md 明示该读法）
 *
 * 无 vi.mock：真实 AgentRegistry（FileSessionStore + 身份 sidecar + 真实
 * connectMCPServer 连 identityPassthrough 的 stub HTTP MCP 端点）+ 真实
 * router。LLM 为本地 stub OpenAI 兼容服务（任何会话形态的首个模型轮都
 * 调用 MCP 工具，驱动一次真实 transport 请求）。
 */

const MCP_SERVER_KEY = "hub-mem"
/** MCP 工具的引擎侧名称：SDK 连接工具按 `mcp__<serverKey>__<toolName>` 暴露。 */
const MCP_TOOL_WIRE_NAME = `mcp__${MCP_SERVER_KEY}__echo_tool`
const STATIC_CAPABILITY = "cap-e2e"

interface McpRequestRecord {
  jsonrpcMethod?: string
  headers: Record<string, string | string[] | undefined>
}

/**
 * Stateless streamable-HTTP MCP stub：POST JSON-RPC（initialize /
 * notifications → 202 / tools/list / tools/call），GET/DELETE → 405（规范
 * 允许 stateless 服务器不支持服务器主动流与会话终止）。记录每个请求的
 * 完整请求头（Node 将头名小写化）。
 */
function startStubMcpServer(): Promise<{ server: Server; url: string; requests: McpRequestRecord[] }> {
  const requests: McpRequestRecord[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      const record: McpRequestRecord = { headers: { ...req.headers } }
      let body: { id?: unknown; method?: string; params?: { protocolVersion?: string; arguments?: { text?: string } } } | null = null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = null
        }
        if (body !== null && typeof body === "object" && typeof body.method === "string") {
          record.jsonrpcMethod = body.method
        }
      }
      requests.push(record)

      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(405, { Allow: "POST" }).end()
        return
      }
      if (req.method !== "POST" || body === null || typeof body !== "object") {
        res.writeHead(400).end()
        return
      }
      // JSON-RPC notification（无 id）→ 202 无体
      if (body.id === undefined) {
        res.writeHead(202).end()
        return
      }
      let result: unknown
      switch (body.method) {
        case "initialize":
          result = {
            // 回显客户端请求的协议版本（版本协商的最小安全应答）
            protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "stub-mcp", version: "1.0.0" },
          }
          break
        case "tools/list":
          result = {
            tools: [{
              name: "echo_tool",
              description: "echoes its input",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            }],
          }
          break
        case "tools/call":
          result = {
            content: [{ type: "text", text: `echoed: ${String(body.params?.arguments?.text ?? "")}` }],
            isError: false,
          }
          break
        default:
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }))
          return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, requests })
    })
  })
}

/**
 * Stub OpenAI 兼容 LLM：三轮协议驱动每个 run 的真实 MCP transport 请求——
 * MCP 连接工具为 deferred（SDK 延迟加载设计），轮 1 FindTool 装载 schema、
 * 轮 2 真实工具调用、轮 3 文本收尾。轮数按「最后一条 user 消息之后的
 * assistant tool_calls 数」计——resume 场景的历史轮不计，每个 run 重新
 * 走完整三轮（FindTool 幂等，重复装载无害）。
 */
function startStubLlm(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end()
      return
    }
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      let body: { messages?: Array<{ role: string; tool_calls?: unknown }>; stream?: boolean } = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const messages = Array.isArray(body.messages) ? body.messages : []
      let lastUserIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") {
          lastUserIdx = i
          break
        }
      }
      const rounds = messages
        .slice(lastUserIdx + 1)
        .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
        .length
      const stream = Boolean(body.stream)
      const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
      const sse = (chunks: Array<Record<string, unknown>>) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      }
      const json = (message: unknown, finish: string) => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          id: "stub", object: "chat.completion", created: 0, model: "stub-model",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        }))
      }
      const toolCall = (id: string, name: string, args: string) => {
        if (!stream) {
          json(
            { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] },
            "tool_calls",
          )
          return
        }
        sse([
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
          },
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }],
          },
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage,
          },
        ])
      }
      const plainText = (text: string) => {
        if (!stream) {
          json({ role: "assistant", content: text }, "stop")
          return
        }
        sse([
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
          },
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage,
          },
        ])
      }

      if (rounds === 0) {
        // 轮 1：FindTool 装载 deferred 工具的 schema（直接调用未装载的
        // 工具会被引擎拒绝——"calling an unloaded tool will fail"）
        toolCall("call_ft_1", "FindTool", JSON.stringify({ query: `select:${MCP_TOOL_WIRE_NAME}` }))
      } else if (rounds === 1) {
        // 轮 2：真实 MCP 工具调用（本次 run 的 transport 请求在此发生）
        toolCall("call_mcp_1", MCP_TOOL_WIRE_NAME, JSON.stringify({ text: "identity-probe" }))
      } else {
        plainText("identity run complete")
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` })
    })
  })
}

describe("session identity → MCP wire headers (issue #95 acceptance 1, real transport e2e)", () => {
  let mcpServer: Server
  let mcpUrl: string
  let mcpRequests: McpRequestRecord[]
  let llmServer: Server
  let llmBaseUrl: string
  let configDir: string
  let homeBackup: string | undefined
  let homeDir: string
  let app: Hono
  /** 场景 1 绑定的会话 id（场景 3 resume 用）。 */
  let boundSessionId: string

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "identity-e2e-home-"))
    homeBackup = process.env.HOME
    process.env.HOME = homeDir
    configDir = mkdtempSync(join(tmpdir(), "identity-e2e-cfg-"))

    const mcp = await startStubMcpServer()
    mcpServer = mcp.server
    mcpUrl = mcp.url
    mcpRequests = mcp.requests
    const llm = await startStubLlm()
    llmServer = llm.server
    llmBaseUrl = llm.baseUrl

    const registry = new AgentRegistry()
    await registry.loadFromConfig(
      {
        server: { host: "127.0.0.1", port: 3000 },
        agents: [
          {
            id: "identity-agent",
            description: "e2e identity passthrough agent",
            model: "stub-model",
            apiType: "openai-completions",
            apiKey: "integration-test-key",
            baseURL: llmBaseUrl,
            maxTurns: 5,
            mcpServers: {
              [MCP_SERVER_KEY]: {
                transport: "http",
                url: mcpUrl,
                headers: { "X-Agent-Capability": STATIC_CAPABILITY },
                identityPassthrough: true,
              },
            },
          },
        ],
      },
      configDir,
    )
    expect(registry.getStatus("identity-agent")).toBe("ready")

    app = new Hono()
    app.route("/v1/agents", createAgentRouter(registry, new RunRegistry(), new MetricsCollector()))
  })

  afterAll(async () => {
    if (homeBackup === undefined) delete process.env.HOME
    else process.env.HOME = homeBackup
    await rmRetryAsync(homeDir)
    await rmRetryAsync(configDir)
    await Promise.all([
      new Promise<void>((resolve) => mcpServer.close(() => resolve())),
      new Promise<void>((resolve) => llmServer.close(() => resolve())),
    ])
  })

  /** 本次 run 的 tools/call 请求（每个场景恰好一次）。 */
  function toolCallHeaders(): Record<string, string | string[] | undefined> {
    const calls = mcpRequests.filter((r) => r.jsonrpcMethod === "tools/call")
    expect(calls).toHaveLength(1)
    return calls[0]!.headers
  }

  it("run with X-User-Id (SSE path): tools/call carries x-user-id + x-run-id === response runId + static headers merge", async () => {
    mcpRequests.length = 0
    const res = await app.request("/v1/agents/identity-agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-User-Id": "user-e2e" },
      body: JSON.stringify({ message: "probe identity over sse" }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("event: done")
    boundSessionId = text.match(/"session_id":"([0-9a-f-]{36})"/)![1]!

    const headers = toolCallHeaders()
    expect(headers["x-user-id"]).toBe("user-e2e")
    // 评审重要 3 的核心断言：出站 x-run-id 与该次 run 的 runId（响应头
    // X-Run-ID，caller 可见的同一 id）**精确相等**。
    expect(headers["x-run-id"]).toBe(res.headers.get("X-Run-ID"))
    // 静态部署头叠加保留（merge 不替换）
    expect(headers["x-agent-capability"]).toBe(STATIC_CAPABILITY)
  }, 30_000)

  it("unbound session + X-User-Name only (JSON path): tools/call carries NO identity headers (acceptance 2 literal)", async () => {
    mcpRequests.length = 0
    const res = await app.request("/v1/agents/identity-agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-User-Name": "alice" },
      body: JSON.stringify({ message: "probe without identity" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body as { text: string }).text).toContain("identity run complete")

    const headers = toolCallHeaders()
    expect(headers["x-user-id"]).toBeUndefined()
    expect(headers["x-run-id"]).toBeUndefined()
    expect(headers["x-agent-capability"]).toBe(STATIC_CAPABILITY)
  }, 30_000)

  it("resumed bound session without the header: tools/call carries the RESTORED x-user-id + the new run's x-run-id (需求 2 semantics)", async () => {
    mcpRequests.length = 0
    const res = await app.request("/v1/agents/identity-agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "resume identity probe", sessionId: boundSessionId }),
    })
    expect(res.status).toBe(200)

    const headers = toolCallHeaders()
    // 恢复的会话身份（issue #95 需求 2：随会话生命周期存续——docs 已明示
    // 该读法优先于验收 2 的字面）
    expect(headers["x-user-id"]).toBe("user-e2e")
    // runId 为**本次** run 的新值（非场景 1 的旧 runId）
    expect(headers["x-run-id"]).toBe(res.headers.get("X-Run-ID"))
    expect(headers["x-run-id"]).not.toBe(boundSessionId)
  }, 30_000)
})
