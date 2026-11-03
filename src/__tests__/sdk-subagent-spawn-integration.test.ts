import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { AgentRegistry } from "../registry.js"
import { RunRegistry } from "../runs.js"
import { MetricsCollector } from "../metrics.js"
import { createAgentRouter } from "../router/agent.js"
import { createSessionRouter } from "../router/session.js"
import { rmRetryAsync } from "./helpers/fs.js"

/**
 * Production spawn-path regression (issue #80 acceptance #3): the registry's
 * create() path — FileSessionStore + plain WriteCoordinator — must carry a
 * REAL Task/MultiTask spawn end-to-end, and the session surface must behave:
 *
 *  1. subagent events flow (spawn succeeded through the production path —
 *     without the store+coordinator injection, 4.x refuses the spawn;
 *     fresh-session spawn registration is the SDK's own since 4.1.2 —
 *     see the history note in src/session-store.ts)
 *  2. the registry's SessionManagerV2 anchors at
 *     <configDir>/.zerone/sessions (sessions.json exists there)
 *  3. the spawn's persisted rows (child transcript + 'main' pseudo-session)
 *     exist in the store but are HIDDEN from GET /v1/sessions (self-root
 *     filter) — v3 never persisted them
 *  4. DELETE cascades: deleting the root session tombstones the child row
 *     too (no orphans)
 *
 * No vi.mock: real SDK, real registry, real router wiring (same as
 * router/index.ts), local stub OpenAI-compatible server.
 */

const CHILD_NAME = "worker"

function startStubProvider(): Promise<{ server: Server; baseUrl: string }> {
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
      let body: any = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const sawToolResult = Array.isArray(body.messages)
        && body.messages.some((m: any) => m.role === "tool")
      // 根/子区分是语义性的：只有根请求的 tools 列表广播 Task（子代理深度 1
      // 隔离，无 Task/MultiTask）。按 tools 广播判定而非消息启发式——子请求
      // 永远拿纯文本，不会烧掉子代理的 turns（曾因此偶发 maxTurnsHit）。
      const isRootRequest = Array.isArray(body.tools)
        && body.tools.some((t: any) => t.function?.name === "Task")
      const stream = Boolean(body.stream)
      const sse = (chunks: Array<Record<string, unknown>>) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      }
      const json = (payload: Record<string, unknown>) => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(payload))
      }
      const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
      if (isRootRequest && !sawToolResult) {
        // Root turn 1: emit a Task tool_use spawning the mounted child.
        const taskArgs = JSON.stringify({
          subagent_type: "General",
          subagent_name: CHILD_NAME,
          prompt: "do the thing",
          description: "spawn-path test",
        })
        const toolCallMessage = {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_task_1", type: "function", function: { name: "Task", arguments: taskArgs } }],
        }
        if (!stream) {
          json({
            id: "stub", object: "chat.completion", created: 0, model: "stub-model",
            choices: [{ index: 0, message: toolCallMessage, finish_reason: "tool_calls" }],
            usage,
          })
          return
        }
        sse([
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{
              index: 0,
              delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_task_1", type: "function", function: { name: "Task", arguments: "" } }] },
              finish_reason: null,
            }],
          },
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: taskArgs } }] }, finish_reason: null }],
          },
          {
            id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage,
          },
        ])
        return
      }
      // Turn ≥2 (root after tool result, and the child): plain text.
      if (!stream) {
        json({
          id: "stub", object: "chat.completion", created: 0, model: "stub-model",
          choices: [{ index: 0, message: { role: "assistant", content: "stub answer" }, finish_reason: "stop" }],
          usage,
        })
        return
      }
      sse([
        {
          id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "stub answer" }, finish_reason: null }],
        },
        {
          id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        },
      ])
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` })
    })
  })
}

describe("subagent spawn through the production registry path (issue #80 acceptance #3, real SDK integration)", () => {
  let stubServer: Server
  let stubBaseUrl: string
  let homeBackup: string | undefined
  let homeDir: string
  let configDir: string

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "spawn-path-home-"))
    homeBackup = process.env.HOME
    process.env.HOME = homeDir
    configDir = mkdtempSync(join(tmpdir(), "spawn-path-cfg-"))
    ;({ server: stubServer, baseUrl: stubBaseUrl } = await startStubProvider())
  })

  afterAll(async () => {
    if (homeBackup === undefined) delete process.env.HOME
    else process.env.HOME = homeBackup
    await rmRetryAsync(homeDir)
    await rmRetryAsync(configDir)
    await new Promise<void>((resolve) => stubServer.close(() => resolve()))
  })

  it(
    "spawns a real subagent via create(); manager anchors <configDir>/.zerone/sessions; ghosts hidden; DELETE cascades",
    async () => {
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        {
          server: { host: "127.0.0.1", port: 3000 },
          agents: [
            {
              id: "coordinator",
              description: "delegates to the worker",
              model: "stub-model",
              apiType: "openai-completions",
              apiKey: "integration-test-key",
              baseURL: stubBaseUrl,
              maxTurns: 3,
              subagents: [CHILD_NAME],
            },
            {
              id: CHILD_NAME,
              description: "does the thing",
              model: "stub-model",
              maxTurns: 2,
            },
          ],
        },
        configDir,
      )

      // App wired exactly like router/index.ts (lazy session-manager getter).
      const runsRegistry = new RunRegistry()
      const app = new Hono()
      app.route("/v1/agents", createAgentRouter(registry, runsRegistry, new MetricsCollector()))
      app.route("/v1/sessions", createSessionRouter(() => registry.getSessionManager()))

      const res = await app.request("/v1/agents/coordinator/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: "delegate this" }),
      })
      expect(res.status).toBe(200)
      const text = await res.text()

      // 1. Spawn succeeded through the production path: subagent events flow
      // and the Task tool result is not an error. (On SDK <4.1.2 the tool
      // result carried the ownership-target WriteNotAuthorizedError — fixed
      // upstream in agent-sdk#161; this test now pins the fixed behavior.)
      expect(text).toContain("event: subagent")
      expect(text).toContain('"tool_name":"Task","is_error":false')
      expect(text).not.toContain("ownership target")
      expect(text).toContain("event: done")

      const rootSid = text.match(/"session_id":"([0-9a-f-]{36})"/)![1]
      const childSid = text.match(/"type":"subagent","parent_tool_use_id":"[^"]*","session_id":"([0-9a-f-]{36})"/)![1]
      expect(childSid).not.toBe(rootSid)

      // 2. Manager anchors at <configDir>/.zerone/sessions.
      const sessionsFile = join(configDir, ".zerone", "sessions", "sessions.json")
      expect(existsSync(sessionsFile)).toBe(true)
      const manager = registry.getSessionManager()!

      // 3. Spawn rows persisted in the store (child transcript + 'main'
      // pseudo-session) but hidden from the user-facing list.
      expect(await manager.get(childSid)).not.toBeNull()
      expect(await manager.get("main")).not.toBeNull()
      const listRes = await app.request("http://localhost/v1/sessions")
      expect(listRes.status).toBe(200)
      const listed = (await listRes.json()) as Array<{ id: string }>
      expect(listed.map((s) => s.id)).toEqual([rootSid])

      // 幽灵行经显式 id 同样不可读（与列表过滤一致）
      const ghostRes = await app.request(`http://localhost/v1/sessions/${childSid}`)
      expect(ghostRes.status).toBe(404)

      // Detail + messages readable for the root session.
      const detailRes = await app.request(`http://localhost/v1/sessions/${rootSid}`)
      expect(detailRes.status).toBe(200)
      const detail = await detailRes.json()
      expect(detail.metadata.id).toBe(rootSid)
      expect(Array.isArray(detail.messages)).toBe(true)

      // 4. DELETE cascades: the child row is tombstoned with the root.
      const delRes = await app.request(`http://localhost/v1/sessions/${rootSid}`, { method: "DELETE" })
      expect(delRes.status).toBe(200)
      expect(await delRes.json()).toEqual({ ok: true })
      expect(await manager.get(rootSid)).toBeNull()
      expect(await manager.get(childSid)).toBeNull()
    },
    30_000,
  )
})
