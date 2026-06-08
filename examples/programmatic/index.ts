/**
 * Programmatic Agent — 基于 SDK + Runtime 组件构建
 *
 * 展示如何用代码驱动方式组合 SDK 和 Runtime 的全部能力：
 * - 自定义工具（defineTool + tool）
 * - Hook 系统（PreToolUse / PostToolUse）
 * - 动态 system prompt
 * - 多 Agent 注册 + 工具隔离
 * - Runtime createApp / AgentRegistry / MetricsCollector
 * - 自定义路由扩展
 *
 * Run: npx tsx examples/programmatic/index.ts
 */

import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { z } from "zod"

import { createAgent, defineTool, tool, sdkToolToToolDefinition, type Agent } from "@zerone-agent/open-agent-sdk"
import {
  createApp,
  AgentRegistry,
  MetricsCollector,
  type RuntimeConfig,
} from "../../src/index.js"

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
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
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

// ─── 创建 Agent ────────────────────────────────────────────

const envOverrides = {
  model: process.env.OPENAGENT_MODEL ?? "claude-sonnet-4-6",
  apiType: (process.env.OPENAGENT_API_TYPE as any) ?? undefined,
  apiKey: process.env.OPENAGENT_API_KEY ?? undefined,
  baseURL: process.env.OPENAGENT_BASE_URL ?? undefined,
}

function createAnalystAgent(): Agent {
  return createAgent({
    ...envOverrides,
    systemPrompt: [
      "你是一个金融分析助手。",
      "你可以查询股票价格（使用 GetStockPrice 工具）、搜索新闻、读写文件。",
      "回答要简洁，关键数据用列表呈现。",
    ].join("\n"),
    maxTurns: 10,
    tools: [stockTool, "WebSearch", "Read", "Glob", "Grep"],
    thinking: { type: "enabled", budgetTokens: 4000 },
    hooks: createLoggingHooks("analyst"),
  })
}

function createOpsAgent(): Agent {
  return createAgent({
    ...envOverrides,
    systemPrompt: [
      "你是一个运维助手。",
      "你可以执行命令、读写文件、编辑代码、保存笔记（使用 SaveNote 工具）。",
      "执行危险操作前先确认。",
    ].join("\n"),
    maxTurns: 15,
    tools: [sdkToolToToolDefinition(noteTool), "Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    permissionMode: "acceptEdits",
    thinking: { type: "enabled", budgetTokens: 4000 },
    hooks: createLoggingHooks("ops"),
  })
}

// ─── 组装 Runtime ──────────────────────────────────────────

async function main() {
  const analyst = createAnalystAgent()
  const ops = createOpsAgent()

  const registry = new AgentRegistry()
  registry.register("analyst", analyst, { id: "analyst", model: "claude-sonnet-4-6", maxTurns: 10 })
  registry.register("ops", ops, { id: "ops", model: "claude-sonnet-4-6", maxTurns: 15 })

  const metrics = new MetricsCollector()

  const config: RuntimeConfig = {
    server: { host: "0.0.0.0", port: 3000 },
    cors: { origins: ["*"] },
    agents: [
      { id: "analyst", model: "claude-sonnet-4-6" },
      { id: "ops", model: "claude-sonnet-4-6" },
    ],
  }

  const app = createApp(config, registry, metrics)

  // 自定义扩展路由
  const extension = new Hono()
  extension.get("/status", (c) => {
    return c.json({
      agents: registry.list().map((a) => ({ id: a.id, status: a.status })),
      metrics: metrics.getSnapshot(),
    })
  })
  app.route("/custom", extension)

  serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, (info) => {
    console.log(`\n  Programmatic Agent Server`)
    console.log(`  http://${info.address}:${info.port}`)
    console.log(`\n  Agents:`)
    console.log(`    analyst  — 金融分析（WebSearch, 文件读取）`)
    console.log(`    ops      — 运维操作（Bash, 文件读写编辑）`)
    console.log(`\n  Custom routes:`)
    console.log(`    GET /custom/status — 运行状态概览`)
    console.log()
  })
}

main().catch((err) => {
  console.error("Failed to start:", err)
  process.exit(1)
})
