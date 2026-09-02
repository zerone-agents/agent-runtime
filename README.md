<div align="center">

# Zerone Agent Runtime

**HTTP server runtime for AI agents.**<br/>
Define agents in YAML or TypeScript, expose them via Streamable HTTP (SSE + JSON).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/zerone-agents/agent-runtime?style=flat)](https://github.com/zerone-agents/agent-runtime/stargazers)
[![Node](https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Quick Start](#quick-start) · [Documentation](#documentation) · [Ecosystem](#ecosystem) · [License](#license)

**English | [简体中文](README.zh-CN.md)**

</div>

---

## What is Zerone Agent Runtime?

Zerone Agent Runtime is the execution layer for AI agents — a lightweight HTTP server that turns agent definitions (YAML or TypeScript) into REST/SSE endpoints. Built on [`@zerone-agent/agent-sdk`](https://github.com/zerone-agents/agent-sdk), it handles Streamable HTTP transport (SSE token streaming, SSE block mode, or blocking JSON), session management, subagent spawning, and the File Browsing API — so any client (agent-hub chat UI, CLI, or your own app) can talk to agents over a uniform HTTP contract.

**Three response modes:** SSE raw · SSE block · JSON

## Quick Start

```bash
npm install

# Create config
cat > agents.yaml << 'EOF'
agents:
  - id: "assistant"
    description: "A helpful general-purpose assistant."
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
| `GET` | `/health` | Health check with runtime version (unauthenticated) |
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
| `POST` | `/v1/files/uploads` | Upload chat attachments (multipart; ≤10 files, ≤20MB each, ≤50MB per request) |

## Run lifecycle & cancellation

Every `POST /v1/agents/:agentId/runs` execution is assigned a unique
`runId` (UUID) for transport-level identification. The ID is exposed in:

- Response header `X-Run-ID` (SSE and JSON)
- SSE initial `system` event's `runId` field
- JSON response body's `runId` field

### Cancelling a run

```http
POST /v1/runs/:runId/cancel
```

Aborts the addressed active run. Response codes:

| State | Code | Body |
|---|---|---|
| Triggered cancellation | 202 | `{ runId, state: "cancelling" }` |
| Repeated cancel (idempotent) | 202 | `{ runId, state: "cancelling" \| "cancelled", reason }` |
| Run already in non-cancel terminal | 409 | `{ runId, state: "completed" \| "failed" }` |
| Unknown / expired runId | 404 | `{ error: "Run not found" }` |

Terminal-state cache TTL: **5 minutes**. After expiry, repeat cancel
returns 404.

### SSE cancellation semantics

When a run is cancelled (explicit API call or client disconnect), the
SSE stream emits:

```
event: cancelled
data: {"runId":"...","reason":"client_request|disconnect"}

event: done
data: {}
```

- `reason=client_request`: explicit `POST /v1/runs/:runId/cancel`.
- `reason=disconnect`: SSE client disconnected.

**Client disconnect = silent cancellation**: closing the SSE connection
aborts the underlying agent execution. The runtime does not distinguish
"intentional cancel" from "network drop" — both stop the run to avoid
wasting tokens.

### Non-goals

This API is transport-level. agent-runtime does **not** provide:

- Persistent run history (use external orchestrator)
- Retry / failover policy
- Durable event replay (reconnect mid-stream is not supported)
- GET status endpoint (terminal state is conveyed via the response itself)

### Shutdown semantics

`RunRegistry.closeAll()` is provided for orchestrators that wrap the
runtime process (e.g. agent-deployer) and need to drain in-flight runs
on SIGTERM. The runtime itself does not install signal handlers —
container-level SIGTERM/KILL is the orchestrator's responsibility.

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
| `description` | Yes | — | One-line description; drives the detail endpoint and `Task` routing |
| `model` | No | `claude-sonnet-4-6` | LLM model name |
| `systemPrompt` | No | — | Inline system prompt |
| `systemPromptFile` | No | — | Path to `.md` file (relative to config dir) |
| `maxTurns` | No | `10` | Max agentic loop turns |
| `maxSessionTurns` | No | unlimited | Max conversation rounds sent to LLM (context window) |
| `allowedTools` | No | all tools | Whitelist of tool names |
| `disallowedTools` | No | — | Blacklist of tool names |
| `settingSources` | No | — | Which skill dirs to scan: `user` (~/.openagent/skills/), `project` (<cwd>/.openagent/skills/), `local` (no-op). All scanned skills are exposed — no whitelist |
| `extraUserSkillDirs` | No | — | Additional user-level skill dirs (scanned after default) |
| `mcpServers` | No | — | MCP server configurations |
| `permissionMode` | No | `default` | `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto` |
| `subagents` | No | — | Agent ids to mount as subagents for the `Task` tool |
| `datasets` | No | — | Map of dataset-id to description, injected into the system prompt as a `<datasets>` block |

`systemPrompt` and `systemPromptFile` are mutually exclusive.

### AIGC labeling (GB 45438-2025)

Optional top-level `aigc` config: when enabled, every response carries an implicit-label `aigc` field per the China national standard, plus a per-run audit record. Supports env overrides (`ZERONE_AGENT_AIGC_*`). See [`docs/compliance.md`](docs/compliance.md) for full config, design rationale, and a compliance checklist.

### Hub chat push (optional)

Optional top-level `hub` config: when enabled, every successfully completed run asynchronously pushes the full session snapshot to agent-hub (idempotent upsert on the hub side). The `X-User-Name` request header maps to session ownership and is required — when absent, the push is skipped for that run. Tenant ownership comes from the deployment-level `hub.org` config (delivered via agent-hub/agent-deployer); the `X-Org` request header is no longer read. When `hub.org` is not configured, the `org` field is omitted and the hub resolves its default tenant by deployment mode. The push never blocks a run — network errors and 5xx are retried twice with 1s→2s backoff, 4xx is not retried. See the [`hub` section in `docs/configuration.md`](docs/configuration.md#hub-聊天记录回传可选) for full config.

### Cron (scheduled agents, optional)

Optional top-level `cron` config: when enabled, the runtime starts the cron scheduler before HTTP listens and exposes scheduled-task management via `/v1/cron/*` routes and the `zerone-agent cron` CLI subcommands (online mode; `--offline` is not supported yet). Opt-in — scheduled runs incur model calls and tool execution.

```yaml
cron:
  enabled: true
  dataRoot: .zerone
  executionTimeoutMs: 600000
  drainMs: 5000

agents:
  - id: assistant
    description: General assistant used by scheduled prompts
    model: claude-sonnet-4-6
```

Task state and execution history persist under `<dataRoot>/cron/` (single-writer lock). See [`docs/api/cron.md`](docs/api/cron.md) for the HTTP API and the [`cron` section in `docs/configuration.md`](docs/configuration.md#cron) for full config. Runnable example: [`examples/cron-runtime/`](examples/cron-runtime/).

### Skill loading

Skills are **fully filesystem-driven** — no whitelist. Set `settingSources` to choose which directories to scan (`~/.openagent/skills/`, `<cwd>/.openagent/skills/`, plus `extraUserSkillDirs`); every discovered `SKILL.md` is exposed to the agent. Skills are scanned once at startup; restart to pick up changes. `GET /v1/agents/:id` surfaces the resolved list as `availableSkills`.

### Subagents

Every agent is defined flat in the `agents` list and is a full citizen — it shows up in `GET /v1/agents` and can be run directly. Mount other agents as subagents by listing their ids; the parent delegates via the `Task` tool:

```yaml
agents:
  - id: "coder"
    description: "Write and edit code"
    model: "claude-sonnet-4-6"
    systemPrompt: "You are an expert programmer. Write clean, working code."
    allowedTools: ["Read", "Write", "Edit", "Bash"]
    maxTurns: 30

  - id: "researcher"
    description: "Research topics on the web"
    model: "claude-sonnet-4-6"
    systemPrompt: "You are a research assistant. Search and summarize information."
    allowedTools: ["WebSearch", "WebFetch"]
    maxTurns: 15

  - id: "coordinator"
    description: "Coordinates work by delegating to specialists"
    model: "claude-sonnet-4-6"
    systemPrompt: "Delegate complex tasks to the appropriate subagent using the Task tool."
    allowedTools: ["Task", "Read"]
    subagents: ["coder", "researcher"]
```

Mounting maps only `description`, `systemPrompt` (resolved), `allowedTools`, `disallowedTools` and `maxTurns` — credentials, skills, custom tools and datasets do not apply in the mounted context. Delegation depth is 1: a subagent cannot mount further subagents. Unknown or duplicate ids in `subagents` fail at startup.

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
zerone-agent                          # start with config from cwd
zerone-agent --config ./my-agents/    # specify config directory
zerone-agent --port 8080              # override port
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

## Chat attachments

Upload files to the runtime (they land in `<cwd>/.zerone-uploads`, flat, container-lifetime), then reference them in a run:

```bash
# 1. Upload (protected by the same x-api-key as other /v1 routes)
curl -X POST http://localhost:3000/v1/files/uploads \
  -H "x-api-key: $KEY" -F "files=@report.pdf"
# → 201 { "files": [{ "id", "name", "mime", "size", "path": ".zerone-uploads/report.pdf" }] }

# 2. Reference in a run (message stays required; attachments optional)
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" -H "x-api-key: $KEY" \
  -d '{"message":"Summarize this report","attachments":[{"id":"…","name":"report.pdf","mime":"application/pdf","size":123,"path":".zerone-uploads/report.pdf"}]}'
```

Decodeable JPEG/PNG/GIF/WebP become model image blocks (long edge scaled to ≤1536px, JPEG q85 when transcoded; the original file is never modified). SVG, broken images, and all other formats are handed to the agent as safe workspace-relative paths to read with the `Read` tool. Attachment descriptors are re-validated on every run (flat path, regular file, real size, count/size limits checked before any content is read) and never trusted from the caller; the paths given to the agent are per-run snapshot copies (`.zerone-uploads/snap-…`) materialized from the validated bytes, so post-validation filesystem swaps cannot change what a run reads.

## Library Usage

The runtime can also be embedded as a library (`createRuntime`, `AgentRuntimeHost`) — see [`docs/sdk-usage.md`](docs/sdk-usage.md).

## License

MIT
