# open-agent-runtime

HTTP Server runtime for [open-agent-sdk](https://github.com/zerone-agent/open-agent-sdk) agents.

Wraps SDK's Agent into a multi-agent HTTP runtime with SSE streaming. Load agent definitions from YAML, start the server, call the API.

## Quick Start

```bash
npm install
npm start
```

Create `agents.yaml` in the project root:

```yaml
agents:
  - id: "assistant"
    model: "claude-sonnet-4-6"
    systemPrompt: "You are a helpful assistant."
    maxTurns: 10
```

Optionally create `runtime.yaml`:

```yaml
server:
  host: "0.0.0.0"
  port: 3000
cors:
  origins: ["*"]
```

## API

All routes prefixed with `/v1`.

### Run Agent (SSE)

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","stream":true}'
```

Response is an SSE stream. Each event is a JSON `SDKMessage` from the SDK:

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

## Agent Configuration

### agents.yaml

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
    skills: []

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

### Config Discovery

The runtime searches for config in this order:

1. `--config <path>` CLI argument
2. `agent.config.ts` in config directory (programmatic mode, Phase 2)
3. `agents.yaml` in config directory
4. Current working directory
5. `~/.openagent/`

## CLI

```bash
# Start with default config
open-agent start

# Specify config directory
open-agent start --config ./my-agents/

# Override port
open-agent start --port 8080
```

## Docker

```bash
docker build -t open-agent-runtime .
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=... \
  open-agent-runtime
```

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
