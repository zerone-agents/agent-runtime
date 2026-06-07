import { defineConfig } from "../../src/index.js"
import { defineTool, tool } from "@zerone-agent/open-agent-sdk"
import { z } from "zod"

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

const calcTool = tool(
  "Calculator",
  "计算数学表达式",
  { expression: z.string() },
  async ({ expression }) => {
    try {
      const result = Function(`'use strict'; return (${expression})`)()
      return { content: [{ type: "text" as const, text: `${expression} = ${result}` }] }
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }
    }
  },
)

export default defineConfig({
  server: { host: "0.0.0.0", port: 3000 },
  cors: { origins: ["*"] },
  agents: [
    {
      id: "smart",
      model: "claude-sonnet-4-6",
      systemPrompt: "你是一个智能助手，可以查天气、做数学计算、读写文件、执行命令。",
      maxTurns: 15,
      allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"],
    },
  ],
})
