# Configuration

The runtime supports two config formats: `agents.yaml` (declarative) and `agent.config.ts` (code-driven). `agent.config.ts` takes priority over `agents.yaml`.

For the YAML format and field reference, see the README.

## TypeScript Mode (`agent.config.ts`)

```ts
import { defineConfig } from "@zerone-agent/agent-runtime"
import { defineTool, tool } from "@zerone-agent/agent-sdk"
import { z } from "zod"

const weatherTool = defineTool({
  name: "GetWeather",
  description: "Get weather for a city",
  inputSchema: {
    type: "object" as const,
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input: { city: string }) {
    return `${input.city}: 22°C, partly cloudy`
  },
})

const calcTool = tool("Calculator", "Evaluate math expression (^ = power)", { expression: z.string() }, async ({ expression }) => {
  const safe = expression.replace(/\^/g, "**")
  const result = Function(`'use strict'; return (${safe})`)()
  return { content: [{ type: "text" as const, text: `${expression} = ${result}` }] }
})

export default defineConfig({
  server: { port: 3000 },
  agents: [
    {
      id: "smart",
      description: "智能助手，可读写文件、执行命令、查询天气和计算",
      model: "claude-sonnet-4-6",
      systemPrompt: "You are a smart assistant with weather and calculator tools.",
      maxTurns: 15,
      allowedTools: ["Bash", "Read", "Write", "Edit"],
    },
  ],
})
```

## Subagents (Reference Mounting)

Subagents are not defined separately — every agent lives in the flat `agents` list (with a required `description`). Mount agents by id under `subagents`:

```yaml
agents:
  - id: "coordinator"
    description: "Delegates to specialists"
    subagents: ["coder", "researcher"]
  - id: "coder"
    description: "Writes code"
    systemPrompt: "You are an expert programmer."
  - id: "researcher"
    description: "Researches topics"
```

Rules:

- `description` is required on every agent — it drives Task routing and the detail endpoint.
- Mounting maps only `description`, `systemPrompt`/`systemPromptFile` (resolved, including `datasets` concatenation), `allowedTools`, `disallowedTools`, `maxTurns`.
- Unknown or duplicate ids in `subagents` fail at config load (the error lists available agent ids). Self/cyclic references are allowed.
- Delegation depth is 1 — a mounted agent's own `subagents` apply only when that agent is run directly, never in the mounted context.

## Provider Credentials

Each agent accepts optional `apiKey`, `baseURL`, and `apiType` fields, so different agents can use different providers:

```yaml
agents:
  - id: assistant
    description: "General-purpose assistant"
    model: claude-sonnet-4-6
    apiKey: sk-ant-...
  - id: coder
    description: "Writes code"
    model: deepseek-v3
    apiType: openai
    baseURL: https://api.deepseek.com
    apiKey: sk-ds-...
```

Environment variables `ZERONE_AGENT_API_KEY` / `ZERONE_AGENT_BASE_URL` / `ZERONE_AGENT_API_TYPE` take precedence over config values when set (they apply to all agents). Credentials are never exposed via the agent detail endpoint.

## Custom File Tools

Each agent can load custom tools from script files listed under `customTools` (relative paths resolve against the config directory). See [tools.md](tools.md).

## hub（聊天记录回传，可选）

把每次成功完成的 run 的会话快照回传到 agent-hub。默认关闭。

```yaml
hub:
  enabled: true            # 显式开启；缺省 false
  baseUrl: "https://hub.example.com"   # enabled 时必填，缺失启动报错
  chatPushKey: "..."                    # enabled 时必填，与 hub 侧 CHAT_PUSH_API_KEY 相同
```

- 触发时机：run 终态为 completed 时异步推送该 session 全量快照（hub 幂等 upsert，可安全重试）
- 归属：请求头 `X-User-Name` / `X-Org` 映射为 session 的 `user_name` / `org`；未传 `X-User-Name` 时 runtime 跳过该次推送（hub 要求 user_name 必填），`X-Org` 未传则省略 org 字段、hub 按部署模式解析默认租户
- 信任模型：身份头 `X-User-Name`/`X-Org` 由 runtime 直接信任、无法校验——开启 hub 回传时，runtime 应部署在 deployer/网关之后（或配置 HTTP API key），否则身份可被伪造
- 失败处理：推送永不阻塞 run；网络错误/5xx 指数退避重试 2 次（1s、2s），4xx 不重试；失败仅记日志

## Config Discovery

Search order:

1. `--config <path>` CLI argument
2. `agent.config.ts` in config directory
3. `agents.yaml` in config directory
4. Current working directory
5. `~/.openagent/`
