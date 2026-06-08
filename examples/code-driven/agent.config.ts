import { defineConfig } from "../../src/index.js"

export default defineConfig({
  server: { host: "0.0.0.0", port: 3000 },
  cors: { origins: ["*"] },
  agents: [
    {
      id: "smart",
      model: "claude-sonnet-4-6",
      systemPrompt: "你是一个智能助手，可以读写文件、执行命令、搜索网页。",
      maxTurns: 15,
      allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"],
    },
  ],
})
