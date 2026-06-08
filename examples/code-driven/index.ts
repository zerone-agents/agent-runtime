import { createApp, AgentRegistry, MetricsCollector } from "../../src/index.js"
import { createAgent, defineTool, tool, sdkToolToToolDefinition } from "@zerone-agent/open-agent-sdk"
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
    const temps: Record<string, { temp: number; desc: string }> = {
      beijing: { temp: 28, desc: "晴" },
      shanghai: { temp: 25, desc: "多云" },
      tokyo: { temp: 22, desc: "小雨" },
      london: { temp: 14, desc: "阴" },
      "new york": { temp: 18, desc: "晴转多云" },
    }
    const w = temps[input.city.toLowerCase()] ?? { temp: 20, desc: "晴" }
    return `${input.city}：${w.temp}°C，${w.desc}`
  },
})

const calcTool = tool("Calculator", "计算数学表达式", { expression: z.string() }, async ({ expression }) => {
  try {
    const result = Function(`'use strict'; return (${expression})`)()
    return { content: [{ type: "text" as const, text: `${expression} = ${result}` }] }
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }
  }
})

async function main() {
  const agent = createAgent({
    model: process.env.OPENAGENT_MODEL ?? "claude-sonnet-4-6",
    apiType: (process.env.OPENAGENT_API_TYPE as any) ?? undefined,
    apiKey: process.env.OPENAGENT_API_KEY ?? undefined,
    baseURL: process.env.OPENAGENT_BASE_URL ?? undefined,
    systemPrompt: "你是一个智能助手，可以查天气、做数学计算、读写文件、执行命令。",
    maxTurns: 15,
    tools: [weatherTool, sdkToolToToolDefinition(calcTool), "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"],
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
  })

  const registry = new AgentRegistry()
  registry.register("smart", agent, { id: "smart", model: "claude-sonnet-4-6", maxTurns: 15 })

  const metrics = new MetricsCollector()

  const app = createApp(
    {
      server: { host: "0.0.0.0", port: 3000 },
      cors: { origins: ["*"] },
      agents: [{ id: "smart", model: "claude-sonnet-4-6" }],
    },
    registry,
    metrics,
  )

  serve({ fetch: app.fetch, port: 3000, hostname: "0.0.0.0" }, (info) => {
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
