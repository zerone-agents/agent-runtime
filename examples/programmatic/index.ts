/**
 * Programmatic Agent — 基于 SDK + Runtime 组件构建
 *
 * 展示如何用代码驱动方式组合 SDK 和 Runtime 的全部能力：
 * - 自定义工具（defineTool + tool）
 * - Hook 系统（PreToolUse / PostToolUse）
 * - 多 Agent 注册 + 工具隔离
 * - Runtime createRuntime（AgentRuntimeHost 生命周期：start 先于 listen，stop 优雅排水）
 * - 自定义路由扩展
 * - 优雅停机（SIGINT/SIGTERM：先停止接流，再排水 runs/cron、关闭 agents）
 *
 * Run: npx tsx examples/programmatic/index.ts
 */

import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { z } from "zod"

import { defineTool, tool, sdkToolToToolDefinition } from "@zerone-agent/agent-sdk"
import { buildShutdown, closeHttpServer, createRuntime, type RuntimeConfig } from "../../src/index.js"

// ─── 自定义工具 ────────────────────────────────────────────

const stockTool = defineTool({
  name: "GetStockPrice",
  description: "查询股票价格。返回当前价格和涨跌幅。",
  inputSchema: {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "股票代码，如 AAPL、TSLA" },
    },
    required: ["symbol"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input: { symbol: string }) {
    const prices: Record<string, { price: number; change: string }> = {
      AAPL: { price: 198.5, change: "+1.2%" },
      TSLA: { price: 342.8, change: "-0.5%" },
      GOOGL: { price: 178.3, change: "+2.1%" },
      MSFT: { price: 442.1, change: "+0.8%" },
    }
    const stock = prices[input.symbol.toUpperCase()] ?? { price: 100, change: "0%" }
    return `${input.symbol}: $${stock.price} (${stock.change})`
  },
})

const noteTool = tool(
  "SaveNote",
  "保存一条笔记到内存",
  { title: z.string(), content: z.string() },
  async ({ title, content }) => {
    console.log(`[Note] ${title}: ${content}`)
    return { content: [{ type: "text" as const, text: `已保存笔记「${title}」` }] }
  },
)

// ─── Hook ──────────────────────────────────────────────────

function createLoggingHooks(label: string) {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: any) => {
            console.log(`[${label}] ▶ ${input.toolName}(${JSON.stringify(input.toolInput).slice(0, 100)})`)
            return {}
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input: any) => {
            const output = typeof input.toolOutput === "string"
              ? input.toolOutput.slice(0, 80)
              : JSON.stringify(input.toolOutput).slice(0, 80)
            console.log(`[${label}] ✔ ${input.toolName} → ${output}`)
            return {}
          },
        ],
      },
    ],
  }
}

// ─── 组装 Runtime（createRuntime / AgentRuntimeHost） ───────

async function main() {
  const envOverrides = {
    // SDK 1.0 reads ZERONE_AGENT_* env vars natively.
    model: process.env.ZERONE_AGENT_MODEL ?? "claude-sonnet-4-6",
    apiType: (process.env.ZERONE_AGENT_API_TYPE as any) ?? undefined,
    apiKey: process.env.ZERONE_AGENT_API_KEY ?? undefined,
    baseURL: process.env.ZERONE_AGENT_BASE_URL ?? undefined,
  }

  const PORT = Number(process.env.PORT ?? 3100)
  const HOST = process.env.HOST ?? "0.0.0.0"

  // 本示例无 agents.yaml：configDir 仅用于锚定相对路径与 cron dataRoot（本示例未启用 cron）
  const configDir = process.cwd()

  const config: RuntimeConfig = {
    server: { host: HOST, port: PORT },
    cors: { origins: ["*"] },
    // agents 声明会被下方 host.agents.register 的代码构建版本覆盖
    // （hooks / 自定义工具实例无法来自配置文件）
    agents: [
      { id: "analyst", description: "financial analyst", model: "claude-sonnet-4-6", maxTurns: 10 },
      { id: "ops", description: "ops assistant", model: "claude-sonnet-4-6", maxTurns: 15 },
    ],
  }

  // createRuntime 组装 AgentRegistry + RunRegistry + MetricsCollector（+ cron，若启用）
  const host = await createRuntime(config, { configDir })

  host.agents.register(
    "analyst",
    { id: "analyst", description: "financial analyst", model: "claude-sonnet-4-6", maxTurns: 10 },
    {
      ...envOverrides,
      agent: {
        description: "financial analyst",
        prompt: [
          "你是一个金融分析助手。",
          "你可以查询股票价格（使用 GetStockPrice 工具）、搜索新闻、读写文件。",
          "回答要简洁，关键数据用列表呈现。",
        ].join("\n"),
        allowedTools: ["WebSearch", "Read", "Glob", "Grep", "GetStockPrice"],
        maxTurns: 10,
      },
      customTools: [stockTool],
      thinking: { type: "enabled", budgetTokens: 4000 },
      hooks: createLoggingHooks("analyst"),
    },
  )
  host.agents.register(
    "ops",
    { id: "ops", description: "ops assistant", model: "claude-sonnet-4-6", maxTurns: 15 },
    {
      ...envOverrides,
      agent: {
        description: "ops assistant",
        prompt: [
          "你是一个运维助手。",
          "你可以执行命令、读写文件、编辑代码、保存笔记（使用 SaveNote 工具）。",
          "执行危险操作前先确认。",
        ].join("\n"),
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "SaveNote"],
        maxTurns: 15,
      },
      customTools: [sdkToolToToolDefinition(noteTool)],
      permissionMode: "acceptEdits",
      thinking: { type: "enabled", budgetTokens: 4000 },
      hooks: createLoggingHooks("ops"),
    },
  )

  // cron 锁 + 执行恢复 + 调度器在 listen 之前启动；cron 未启用时为 no-op
  await host.start()

  // 自定义扩展路由（host.app 是标准 Hono 实例，可自由挂载）
  const extension = new Hono()
  extension.get("/status", (c) => {
    return c.json({
      agents: host.agents.list().map((a) => ({ id: a.id, status: a.status })),
      cron: { enabled: Boolean(host.cron) },
    })
  })
  host.app.route("/custom", extension)

  const server = serve({ fetch: host.app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`\n  Programmatic Agent Server`)
    console.log(`  http://${info.address}:${info.port}`)
    console.log(`\n  Agents:`)
    console.log(`    analyst  — 金融分析（WebSearch, 文件读取）`)
    console.log(`    ops      — 运维操作（Bash, 文件读写编辑）`)
    console.log(`\n  Custom routes:`)
    console.log(`    GET /custom/status — 运行状态概览（agents + cron）`)
    console.log()
  })

  // 优雅停机：先拒绝新变更请求（quiesce），再停接流、排水 runs/cron、关闭 agents
  const shutdown = buildShutdown({
    closeServer: () => { host.quiesce(); return closeHttpServer(server) },
    stopHost: () => host.stop(),
    exit: (code) => process.exit(code),
  })
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("Failed to start:", err)
  process.exit(1)
})
