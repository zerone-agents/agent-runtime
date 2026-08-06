# agent-runtime

HTTP Server runtime for [agent-sdk](https://github.com/zerone-agents/agent-sdk) agents.

English | [中文](README.zh-CN.md)

Multi-agent runtime with Streamable HTTP (SSE + JSON content negotiation). Define agents in YAML or TypeScript, start the server, call the API.

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

TypeScript config (`agent.config.ts`) is also supported — see [`docs/configuration.md`](docs/configuration.md).

## API

All routes prefixed with `/v1`. The run endpoint uses Streamable HTTP — response mode is negotiated via the `Accept` header:

| `Accept` header | Body | Response |
|---|---|---|
| `text/event-stream` | — | SSE, token-level `partial_message` events |
| `text/event-stream` | `stream: "block"` | SSE, complete messages only |
| `application/json` | — | Blocking JSON response |

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"Hello"}'
```

See [`docs/api/runs.md`](docs/api/runs.md) for the SSE event sequence, block mode, and legacy `stream` field compatibility.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (unauthenticated) |
| `GET` | `/v1/metrics` | Token usage, request counts, costs |
| `GET` | `/v1/agents` | List registered agents |
| `GET` | `/v1/agents/:id` | Agent detail |
| `POST` | `/v1/agents/:id/runs` | Run agent (Streamable HTTP) |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/:id` | Session detail with messages |
| `DELETE` | `/v1/sessions/:id` | Delete session |
| `GET` | `/v1/files` | List files in cwd (`?path`、`?recursive`、`?depth`) |
| `GET` | `/v1/files/content` | Download a file (`?path=`) |
| `HEAD` | `/v1/files/content` | File headers only (`?path=`) |

## Configuration

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

`systemPrompt` and `systemPromptFile` are mutually exclusive.

### AIGC labeling (GB 45438-2025)

Optional top-level `aigc` config: when enabled, every response carries an implicit-label `aigc` field per the China national standard, plus a per-run audit record. Supports env overrides (`ZERONE_AGENT_AIGC_*`). See [`docs/compliance.md`](docs/compliance.md) for full config, design rationale, and a compliance checklist.

### Skill loading

Skills are **fully filesystem-driven** — no whitelist. Set `settingSources` to choose which directories to scan (`~/.openagent/skills/`, `<cwd>/.openagent/skills/`, plus `extraUserSkillDirs` / `extraProjectSkillDirs`); every discovered `SKILL.md` is exposed to the agent. Skills are scanned once at startup; restart to pick up changes. `GET /v1/agents/:id` surfaces the resolved list as `availableSkills`.

### Subagents

Define subagents under an agent's `subagents` key; the parent delegates via the `Task` tool:

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

Field reference and TypeScript mode: [`docs/configuration.md`](docs/configuration.md).

## Authentication

Opt-in: when no API key is configured, all routes are open. Set the `ZERONE_AGENT_HTTP_API_KEY` env var (takes priority) or `auth.apiKey` in config, then send the key in the `x-api-key` header for all `/v1/*` requests:

```bash
ZERONE_AGENT_HTTP_API_KEY="your-secret-key" npm start

curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"message":"Hello"}'
```

`/health` remains unauthenticated for load balancers and probes. Missing/invalid keys get a `401` with a JSON error body.

## CLI

```bash
open-agent                          # start with config from cwd
open-agent --config ./my-agents/    # specify config directory
open-agent --port 8080              # override port
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
Client → Hono HTTP Server → AgentRegistry → agent-sdk Agent
         (Accept header)         ↓                ↓
              ↓          AsyncGenerator<SDKMessage>
     ┌────────┴────────┐           ↓
     │                 │    Streamable HTTP Bridge
  SSE stream      JSON response    → Client
```

- **AgentRegistry** creates Agent instances from config at startup, caches them in-process
- **Streamable HTTP Bridge** routes SDK streaming events to SSE or aggregates into JSON, negotiated via `Accept` header
- **Session** management delegates to SDK's filesystem storage

## File Browsing

`/v1/files` exposes the runtime's working directory over HTTP (list, download, range requests) — useful for debugging and observation by external consoles.

**Trust model:** any caller with a valid API key has full read access to everything under cwd — including `agents.yaml`, `.env`, and any secrets. Configure `ZERONE_AGENT_HTTP_API_KEY` before deploying to production.

See [`docs/api/files.md`](docs/api/files.md) for the full API reference.

## Library Usage

The runtime can also be embedded as a library (`createApp`, `AgentRegistry`, `MetricsCollector`) — see [`docs/sdk-usage.md`](docs/sdk-usage.md).

## License

MIT
