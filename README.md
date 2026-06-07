# open-agent-runtime

HTTP Server runtime for [open-agent-sdk](https://github.com/zerone-agent/open-agent-sdk) agents.

Multi-agent runtime with SSE streaming. Define agents in YAML or TypeScript, start the server, call the API.

## Quick Start

```bash
npm install

# Create config
cat > agents.yaml << 'EOF'
agents:
  - id: "assistant"
    model: "claude-sonnet-4-6"
    systemPrompt: "You are a helpful assistant."
    maxTurns: 10
EOF

npm start
```

Or use TypeScript config:

```ts
// agent.config.ts
import { defineConfig } from "@zerone-agent/open-agent-runtime"

export default defineConfig({
  server: { port: 3000 },
  agents: [{ id: "assistant", model: "claude-sonnet-4-6", systemPrompt: "You are a helpful assistant." }],
})
```

## API

All routes prefixed with `/v1`.

### Run Agent (SSE)

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","stream":true}'
```

SSE response — each event is a JSON `SDKMessage`:

```
event: system
data: {"type":"system","subtype":"init","session_id":"...","tools":[...],"model":"..."}

event: assistant
data: {"type":"assistant","message":{"role":"assistant","content":[...]}}

event: result
data: {"type":"result","subtype":"success","total_cost_usd":0.05,...}

event: done
data: {}
```

### Run Agent (blocking)

```bash
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","stream":false}'
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | Health check |
| `GET` | `/v1/metrics` | Token usage, request counts, costs |
| `GET` | `/v1/agents` | List registered agents |
| `GET` | `/v1/agents/:id` | Agent detail |
| `POST` | `/v1/agents/:id/runs` | Run agent (SSE or blocking) |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/:id` | Session detail with messages |
| `DELETE` | `/v1/sessions/:id` | Delete session |

## Configuration

### YAML Mode (`agents.yaml`)

```yaml
agents:
  - id: "researcher"
    name: "Research Assistant"
    model: "claude-sonnet-4-6"
    systemPromptFile: "./prompts/researcher.md"
    maxTurns: 10
    allowedTools:
      - WebFetch
      - WebSearch
      - Read

  - id: "coder"
    model: "claude-sonnet-4-6"
    systemPromptFile: "./prompts/coder.md"
    maxTurns: 20
    allowedTools:
      - Bash
      - Read
      - Write
      - Edit
    mcpServers:
      github:
        transport: "stdio"
        command: "mcp-server-github"
        args: ["--owner", "myorg"]
```

**Fields:**

| Field | Required | Default | Description |
|---|---|---|---|
| `id` | Yes | — | Unique identifier, used in API routes |
| `model` | No | `claude-sonnet-4-6` | LLM model name |
| `systemPrompt` | No | — | Inline system prompt |
| `systemPromptFile` | No | — | Path to `.md` file (relative to config dir) |
| `maxTurns` | No | `10` | Max agentic loop turns |
| `allowedTools` | No | all tools | Whitelist of tool names |
| `disallowedTools` | No | — | Blacklist of tool names |
| `skills` | No | — | Skill names to enable |
| `mcpServers` | No | — | MCP server configurations |
| `permissionMode` | No | `default` | `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto` |

`systemPrompt` and `systemPromptFile` are mutually exclusive.

### TypeScript Mode (`agent.config.ts`)

```ts
import { defineConfig } from "@zerone-agent/open-agent-runtime"
import { defineTool, tool } from "@zerone-agent/open-agent-sdk"
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

const calcTool = tool("Calculator", "Evaluate math expression", { expression: z.string() }, async ({ expression }) => {
  const result = Function(`'use strict'; return (${expression})`)()
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

`agent.config.ts` takes priority over `agents.yaml`.

### Config Discovery

Search order:

1. `--config <path>` CLI argument
2. `agent.config.ts` in config directory
3. `agents.yaml` in config directory
4. Current working directory
5. `~/.openagent/`

## SDK Usage

Use as a library instead of CLI:

```ts
import { createApp, AgentRegistry, MetricsCollector } from "@zerone-agent/open-agent-runtime"
import { createAgent, defineTool } from "@zerone-agent/open-agent-sdk"
import { serve } from "@hono/node-server"

const agent = createAgent({
  model: "claude-sonnet-4-6",
  systemPrompt: "You are a helpful assistant.",
  maxTurns: 10,
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [async (input) => {
      console.log(`Running: ${input.toolInput}`)
      return {}
    }]}],
  },
})

const registry = new AgentRegistry()
registry.register("my-agent", agent)

const metrics = new MetricsCollector()
const app = createApp(
  { server: { host: "0.0.0.0", port: 3000 }, agents: [{ id: "my-agent", model: "claude-sonnet-4-6" }] },
  registry,
  metrics,
)

serve({ fetch: app.fetch, port: 3000 })
```

## CLI

```bash
# Start with default config (looks for agents.yaml in cwd)
node --import tsx src/index.ts

# Specify config directory
node --import tsx src/index.ts --config ./my-agents/

# Override port
node --import tsx src/index.ts --port 8080
```

## Examples

| Directory | Description |
|---|---|
| `examples/simple/` | Single agent with YAML config |
| `examples/complex/` | Multiple specialized agents (researcher, coder, writer) |
| `examples/code-driven/` | TypeScript config with custom tools (`agent.config.ts`) |
| `examples/programmatic/` | Full SDK+Runtime programmatic: custom tools, hooks, multi-agent, custom routes |

## Architecture

```
Client → Hono HTTP Server → AgentRegistry → open-agent-sdk Agent
                                ↓
                         AsyncGenerator<SDKMessage>
                                ↓
                          SSE Bridge → Client
```

- **AgentRegistry** creates Agent instances from config at startup, caches them in-process
- **SSE Bridge** directly forwards SDK streaming events to HTTP clients
- **Session** management delegates to SDK's filesystem storage

## License

MIT
