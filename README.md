# agent-runtime

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
import { defineConfig } from "@zerone-agent/agent-runtime"

export default defineConfig({
  server: { port: 3000 },
  agents: [{ id: "assistant", model: "claude-sonnet-4-6", systemPrompt: "You are a helpful assistant." }],
})
```

## API

All routes prefixed with `/v1`.

### Run Agent (SSE — raw / default)

`stream: true` (default). Token-level streaming — includes `partial_message` events with text deltas, thinking chunks, tool_use progress.

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

```
event: system
data: {"type":"system","subtype":"init",...}

event: partial_message
data: {"type":"partial_message","partial":{"type":"thinking","text":"Let me..."}}

event: partial_message
data: {"type":"partial_message","partial":{"type":"text","text":"Hello!"}}

event: partial_message
data: {"type":"partial_message","partial":{"type":"tool_use","tool_name":"Read",...}}

event: assistant
data: {"type":"assistant","message":{"role":"assistant","content":[...]}}

event: tool_result
data: {"type":"tool_result","result":{...}}

event: result
data: {"type":"result","subtype":"success",...}

event: done
data: {}
```

### Run Agent (SSE — block)

`stream: "block"`. Complete messages only — system init, assistant turns, tool results, final result. No `partial_message` events.

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","stream":"block"}'
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
| `GET` | `/health` | Health check (unauthenticated) |
| `GET` | `/v1/metrics` | Token usage, request counts, costs |
| `GET` | `/v1/agents` | List registered agents |
| `GET` | `/v1/agents/:id` | Agent detail |
| `POST` | `/v1/agents/:id/runs` | Run agent (SSE or blocking) |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/:id` | Session detail with messages |
| `DELETE` | `/v1/sessions/:id` | Delete session |
| `GET` | `/v1/files` | List files in cwd (`?path`、`?recursive`、`?depth`) |
| `GET` | `/v1/files/content` | Download a file (`?path=`) |
| `HEAD` | `/v1/files/content` | File headers only (`?path=`) |

## Configuration

### YAML Mode (`agents.yaml`)

```yaml
agents:
  - id: "researcher"
    name: "Research Assistant"
    model: "claude-sonnet-4-6"
    systemPromptFile: "./prompts/researcher.md"
    maxTurns: 10
    maxSessionTurns: 50
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
    datasets:
      docs: "Internal knowledge base for the project"
```

**Fields:**

| Field | Required | Default | Description |
|---|---|---|---|
| `id` | Yes | — | Unique identifier, used in API routes |
| `model` | No | `claude-sonnet-4-6` | LLM model name |
| `systemPrompt` | No | — | Inline system prompt |
| `systemPromptFile` | No | — | Path to `.md` file (relative to config dir) |
| `maxTurns` | No | `10` | Max agentic loop turns |
| `maxSessionTurns` | No | unlimited | Max conversation rounds sent to LLM (context window) |
| `allowedTools` | No | all tools | Whitelist of tool names |
| `disallowedTools` | No | — | Blacklist of tool names |
| `settingSources` | No | — | Which skill dirs to scan: `user` (~/.openagent/skills/), `project` (<cwd>/.openagent/skills/), `local` (no-op). All scanned skills are exposed — no whitelist |
| `extraUserSkillDirs` | No | — | Additional user-level skill dirs (scanned after default) |
| `extraProjectSkillDirs` | No | — | Additional project-level skill dirs (scanned after default) |
| `mcpServers` | No | — | MCP server configurations |
| `permissionMode` | No | `default` | `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto` |
| `subagents` | No | — | Subagent definitions for the `Task` tool |
| `datasets` | No | — | Map of dataset-id to description, injected into the system prompt as a `<datasets>` block |

### Top-level AIGC labeling (GB 45438-2025)

Optional. When enabled, every response (SSE events and blocking JSON) carries an implicit-label `aigc` field per the China national standard, plus a per-run audit record for traceability.

```yaml
aigc:
  enabled: true
  # 27-char provider code of THIS runtime's operator (not the upstream model vendor).
  # Bits 1-23 identify the operator; bits 24-27 are the model/app code slot.
  contentProducer: "001191320118MAK93FC72D10001"
  # label: "1"            # 1 = AI-generated, 2 = possibly, 3 = suspected (default "1")
  # signingKey: ""        # SHA-256 signature of the label, written into ReservedCode1
  # explicitHint: true    # also emit aigcExplicitHint: true in responses
  # produceIdPrefix: ""   # optional prefix for ProduceID generation
  modelCodes:             # optional: model name -> 4-char model code (overrides bits 24-27)
    "glm-4.5": "0001"
    "qwen-max": "0002"
    "deepseek-chat": "0003"
    "claude-sonnet-4-6": "0004"
```

Env overrides (take priority over YAML values): `OPENAGENT_AIGC_ENABLED`, `OPENAGENT_AIGC_CONTENT_PRODUCER`, `OPENAGENT_AIGC_LABEL`, `OPENAGENT_AIGC_SIGNING_KEY`, `OPENAGENT_AIGC_EXPLICIT_HINT`.

When enabled, responses gain:

```jsonc
{
  "sessionId": "...",
  "text": "...",
  "aigc": {
    "Label": "1",
    "ContentProducer": "001191320118MAK93FC72D10001",
    "ProduceID": "20260723103000-a1b2c3d4e5f6",
    "ReservedCode1": ""           // when signingKey is set, holds SHA-256 HMAC
  },
  "aigcExplicitHint": true        // when explicitHint is true
}
```

For SSE, the `aigc` field is injected into both the leading `system` event and the trailing `result` event (dual-anchor, resilient to stream drops). Per-run audit records are kept in memory for traceability; attach a persistence hook via `createApp(..., { onAigcRecord: ... })` for DB/log-pipeline storage (regulation-typical retention: 6+ months).

See [`docs/compliance.md`](docs/compliance.md) for the full design rationale, role assignments, and a compliance materials checklist.

`systemPrompt` and `systemPromptFile` are mutually exclusive.

#### Skill loading

Skills are **fully filesystem-driven** — there is no whitelist. Configure `settingSources` to choose which directories to scan; every `SKILL.md` discovered is exposed to the agent.

```yaml
agents:
  - id: "my-agent"
    settingSources: ["user", "project"]   # scans both ~/.openagent/skills/ and <cwd>/.openagent/skills/
```

Scan order (later entries override earlier ones on name collisions):

1. `~/.openagent/skills/`                    (when `settingSources` includes `user`)
2. `extraUserSkillDirs[0]`, `[1]`, ...       (additional user-level dirs)
3. `<cwd>/.openagent/skills/`                (when `settingSources` includes `project`)
4. `extraProjectSkillDirs[0]`, `[1]`, ...    (additional project-level dirs)

The runtime scans once at startup and caches the result per agent. The detail endpoint (`GET /v1/agents/:id`) surfaces the resolved list as `availableSkills` — useful for checking what's actually loaded. Restart the runtime to pick up filesystem changes.

### Subagents (YAML)

Define subagents under an agent's `subagents` key. The parent agent can delegate work to them via the `Task` tool. Each subagent needs `description` and `prompt`; other fields are optional.

```yaml
agents:
  - id: "coordinator"
    model: "claude-sonnet-4-6"
    systemPrompt: "Delegate complex tasks to the appropriate subagent using the Task tool."
    allowedTools:
      - Task
      - Read
    subagents:
      coder:
        description: "Write and edit code"
        prompt: "You are an expert programmer. Write clean, working code."
        tools:
          - Read
          - Write
          - Edit
          - Bash
        maxTurns: 30
      researcher:
        description: "Research topics on the web"
        prompt: "You are a research assistant. Search and summarize information."
        tools:
          - WebSearch
          - WebFetch
        maxTurns: 15
```

**Subagent fields:**

| Field | Required | Default | Description |
|---|---|---|---|
| `description` | Yes | — | Short description shown to the parent agent |
| `prompt` | Yes | — | System prompt for the subagent |
| `tools` | No | all tools | Whitelist of tool names |
| `disallowedTools` | No | — | Blacklist of tool names |
| `model` | No | inherits parent | LLM model name |
| `mcpServers` | No | — | MCP server names or `{ name, tools? }` objects |
| `maxTurns` | No | `10` | Max agentic loop turns |

### TypeScript Mode (`agent.config.ts`)

```ts
import { defineConfig } from "@zerone-agent/agent-runtime"
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

`agent.config.ts` takes priority over `agents.yaml`.

## Authentication

Authentication is opt-in. When no API key is configured, all routes are open (convenient for local development).

To enable authentication, set either the `OPENAGENT_HTTP_API_KEY` environment variable or the `auth.apiKey` field in your config. The environment variable takes priority.

### YAML config

```yaml
auth:
  apiKey: "your-secret-key"

agents:
  - id: "assistant"
    model: "claude-sonnet-4-6"
```

### Environment variable

```bash
OPENAGENT_HTTP_API_KEY="your-secret-key" npm start
```

### Using the key

Include the key in the `x-api-key` header for all `/v1/*` requests:

```bash
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"message":"Hello"}'
```

The `/health` endpoint remains unauthenticated so load balancers and monitoring probes can use it without credentials.

### 401 Response

If a request to a protected route is missing or has an invalid `x-api-key`, the server returns:

```json
{
  "error": "Unauthorized",
  "reason": "missing x-api-key header"
}
```

or, for an invalid key:

```json
{
  "error": "Unauthorized",
  "reason": "invalid api key"
}
```

## Config Discovery

Search order:

1. `--config <path>` CLI argument
2. `agent.config.ts` in config directory
3. `agents.yaml` in config directory
4. Current working directory
5. `~/.openagent/`

## SDK Usage

Use as a library instead of CLI:

```ts
import { createApp, AgentRegistry, MetricsCollector } from "@zerone-agent/agent-runtime"
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

## File Browsing

`/v1/files` exposes the runtime's working directory over HTTP. Useful for debugging and observation by external clients (frontend consoles, ops dashboards).

**Trust model:** any caller with a valid API key has full read access to everything under cwd — including `agents.yaml`, `.env`, and any secrets. Configure `OPENAGENT_HTTP_API_KEY` before deploying to production.

### List files

```bash
# Top-level entries
curl http://localhost:3000/v1/files

# Subdirectory
curl "http://localhost:3000/v1/files?path=src"

# Recursive tree (limit depth to 2 levels)
curl "http://localhost:3000/v1/files?recursive=true&depth=2"
```

### Download a file

```bash
# Full file
curl "http://localhost:3000/v1/files/content?path=outputs/report.json" -o report.json

# Range request (first 100 bytes)
curl -H "Range: bytes=0-99" \
     "http://localhost:3000/v1/files/content?path=logs/app.log" -o partial.log

# HEAD to inspect size/type without downloading body
curl -I "http://localhost:3000/v1/files/content?path=outputs/report.json"
```

See [`docs/api/files.md`](docs/api/files.md) for full API reference.

## License

MIT
