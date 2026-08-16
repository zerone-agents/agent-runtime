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
      model: "claude-sonnet-4-6",
      systemPrompt: "You are a smart assistant with weather and calculator tools.",
      maxTurns: 15,
      allowedTools: ["Bash", "Read", "Write", "Edit"],
    },
  ],
})
```

## Subagent Fields

Subagents are defined under an agent's `subagents` key (see the README for a YAML example).

| Field | Required | Default | Description |
|---|---|---|---|
| `description` | Yes | — | Short description shown to the parent agent |
| `prompt` | Yes | — | System prompt for the subagent |
| `tools` | No | all tools | Whitelist of tool names |
| `disallowedTools` | No | — | Blacklist of tool names |
| `model` | No | inherits parent | LLM model name |
| `mcpServers` | No | — | MCP server names or `{ name, tools? }` objects |
| `maxTurns` | No | `10` | Max agentic loop turns |

## Provider Credentials

Each agent accepts optional `apiKey`, `baseURL`, and `apiType` fields, so different agents can use different providers:

```yaml
agents:
  - id: assistant
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
