import { createApp, AgentRegistry, MetricsCollector } from "../../src/index.js"
import { defineTool, tool, sdkToolToToolDefinition } from "@zerone-agent/agent-sdk"
import { z } from "zod"
import { serve } from "@hono/node-server"

const weatherTool = defineTool({
  name: "GetWeather",
  description: "获取指定城市的天气信息",
  inputSchema: {
    type: "object" as const,
    properties: {
      city: { type: "string", description: "城市名称" },
    },
    required: ["city"],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input: { city: string }) {
    const cnToEn: Record<string, string> = { "北京": "beijing", "上海": "shanghai", "东京": "tokyo", "伦敦": "london", "纽约": "new york" }
    const temps: Record<string, { temp: number; desc: string }> = {
      beijing: { temp: 28, desc: "晴" },
      shanghai: { temp: 25, desc: "多云" },
      tokyo: { temp: 22, desc: "小雨" },
      london: { temp: 14, desc: "阴" },
      "new york": { temp: 18, desc: "晴转多云" },
    }
    const key = (cnToEn[input.city] ?? input.city).toLowerCase()
    const w = temps[key] ?? { temp: 20, desc: "晴" }
    return `${input.city}：${w.temp}°C，${w.desc}`
  },
})

const calcTool = tool("Calculator", "计算数学表达式（支持 ^ 表示幂运算）", { expression: z.string() }, async ({ expression }) => {
  try {
    const safe = expression.replace(/\^/g, "**")
    const result = Function(`'use strict'; return (${safe})`)()
    return { content: [{ type: "text" as const, text: `${expression} = ${result}` }] }
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }
  }
})

async function main() {
  const registry = new AgentRegistry()
  registry.register(
    "smart",
    { id: "smart", model: "claude-sonnet-4-6", maxTurns: 15 },
    {
      // SDK 1.0 reads ZERONE_AGENT_* env vars natively — only override when set.
      model: process.env.ZERONE_AGENT_MODEL ?? "claude-sonnet-4-6",
      apiType: (process.env.ZERONE_AGENT_API_TYPE as any) ?? undefined,
      apiKey: process.env.ZERONE_AGENT_API_KEY ?? undefined,
      baseURL: process.env.ZERONE_AGENT_BASE_URL ?? undefined,
      // SDK 1.0: prompt/allowedTools/disallowedTools/maxTurns moved into `agent`.
      agent: {
        description: "smart assistant",
        prompt: "你是一个智能助手，可以查天气、做数学计算、读写文件、执行命令。",
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "GetWeather", "Calculator"],
        maxTurns: 15,
      },
      customTools: [weatherTool, sdkToolToToolDefinition(calcTool)],
      thinking: { type: "enabled", budgetTokens: 4000 },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              async (input) => {
                console.log(`[Hook] 即将执行 Bash: ${input.toolInput}`)
                return {}
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                console.log(`[Hook] 工具执行完成: ${input.toolName}`)
                return {}
              },
            ],
          },
        ],
      },
    },
  )

  const metrics = new MetricsCollector()

  const PORT = Number(process.env.PORT ?? 3100)
  const HOST = process.env.HOST ?? "0.0.0.0"
  const app = createApp(
    {
      server: { host: HOST, port: PORT },
      cors: { origins: ["*"] },
      agents: [{ id: "smart", model: "claude-sonnet-4-6" }],
    },
    registry,
    metrics,
  )

  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`Code-driven agent running on http://${info.address}:${info.port}`)
    console.log("Agent: smart")
    console.log("Custom tools: GetWeather, Calculator")
    console.log("Hooks: PreToolUse(Bash), PostToolUse(all)")
  })
}

main().catch((err) => {
  console.error("Failed to start:", err)
  process.exit(1)
})
