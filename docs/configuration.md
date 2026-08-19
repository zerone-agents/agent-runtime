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
    model: deepseek-v3
    apiType: openai
    baseURL: https://api.deepseek.com
    apiKey: sk-ds-...
```

Environment variables `ZERONE_AGENT_API_KEY` / `ZERONE_AGENT_BASE_URL` / `ZERONE_AGENT_API_TYPE` take precedence over config values when set (they apply to all agents). Credentials are never exposed via the agent detail endpoint.

## Custom File Tools

Each agent can load custom tools from script files listed under `customTools` (relative paths resolve against the config directory). See [tools.md](tools.md).

## Config Discovery

Search order:

1. `--config <path>` CLI argument
2. `agent.config.ts` in config directory
3. `agents.yaml` in config directory
4. Current working directory
5. `~/.openagent/`
