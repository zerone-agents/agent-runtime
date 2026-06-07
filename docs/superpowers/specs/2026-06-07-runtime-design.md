# open-agent-runtime Phase 1 Design

**Date**: 2026-06-07
**Status**: Approved

---

## Overview

open-agent-runtime is a pure HTTP Server that wraps open-agent-sdk's Agent into a multi-agent runtime. It loads Agent definitions from YAML or TypeScript config, exposes a RESTful API with SSE streaming, and manages session lifecycle.

**Positioning**: Lightweight, standalone, no dependency on Dashboard or Deployer. Direct client connection.

---

## Architecture

Monolithic Router approach — all routes in a single Hono app, AgentRegistry manages multiple Agent instances in-process.

```
Client
  │
  ▼
┌──────────────────────────────┐
│  Hono HTTP Server (:3000)    │
│  ┌────────────────────────┐  │
│  │ Router                 │  │
│  │  /v1/agents/:id/runs   │  │
│  │  /v1/sessions          │  │
│  │  /v1/health            │  │
│  └────────┬───────────────┘  │
│           ▼                  │
│  ┌────────────────────────┐  │
│  │ AgentRegistry          │  │
│  │  Map<id, Agent>        │  │
│  │  - researcher          │  │
│  │  - coder               │  │
│  │  - general             │  │
│  └────────┬───────────────┘  │
│           ▼                  │
│  ┌────────────────────────┐  │
│  │ open-agent-sdk         │  │
│  │  Agent.query()         │  │
│  │  AsyncGenerator<Msg>   │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

---

## Project Structure

```
open-agent-runtime/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry: createRuntime() + CLI
│   ├── config.ts             # YAML / TS config loading + validation
│   ├── registry.ts           # AgentRegistry: manages Agent instances
│   ├── router/
│   │   ├── index.ts          # Hono app, assembles all routes
│   │   ├── agent.ts          # Agent run routes (SSE streaming)
│   │   ├── session.ts        # Session CRUD routes
│   │   └── health.ts         # Health + Metrics routes
│   └── sse.ts                # AsyncGenerator<SDKMessage> -> SSE bridge
├── agents.yaml               # Agent definitions (declarative mode)
├── runtime.yaml              # Runtime config (port, CORS, etc.)
└── Dockerfile                # Phase 2 pre-built image
```

---

## Dependencies

| Dependency | Purpose |
|---|---|
| `hono` | HTTP framework (~14KB, ESM-native, edge-compatible) |
| `@zerone-agent/open-agent-sdk` | Agent, Session, Tools, Skills, MCP |
| `yaml` | YAML config parsing |
| `zod` | Config validation (already a SDK dependency) |

No other runtime dependencies.

---

## Configuration

### Dual Mode: YAML + TypeScript

| Mode | File | Use Case |
|---|---|---|
| Declarative | `agents.yaml` + `runtime.yaml` | Standard agents, no custom logic |
| Programmatic | `agent.config.ts` | Custom tools, hooks, dynamic prompts |

**Priority**: `agent.config.ts` > `agents.yaml`

### runtime.yaml

```yaml
server:
  host: "0.0.0.0"
  port: 3000

cors:
  origins: ["*"]

logging:
  level: "info"
```

### agents.yaml

```yaml
agents:
  - id: "researcher"
    name: "研究助手"
    model: "claude-sonnet-4-6"
    systemPromptFile: "./prompts/researcher.md"
    maxTurns: 10
    allowedTools:
      - WebFetch
      - WebSearch
      - Read
      - Glob
      - Grep
    skills: []
    mcpServers: {}

  - id: "coder"
    name: "编程助手"
    model: "claude-sonnet-4-6"
    systemPromptFile: "./prompts/coder.md"
    maxTurns: 20
    allowedTools:
      - Bash
      - Read
      - Write
      - Edit
      - Glob
      - Grep
    mcpServers:
      github:
        transport: "stdio"
        command: "mcp-server-github"
        args: ["--owner", "myorg"]

  - id: "general"
    name: "通用助手"
    model: "claude-sonnet-4-6"
    systemPrompt: "你是一个通用 AI 助手。"
    maxTurns: 15
```

**Prompt file resolution**:
- `systemPrompt` and `systemPromptFile` are mutually exclusive
- Short prompts (< 200 chars): inline `systemPrompt`
- Long prompts: external `systemPromptFile` referencing `.md` files
- Paths are relative to the config file location

### agent.config.ts (programmatic mode)

```ts
import { defineConfig, defineAgent } from "@zerone-agent/open-agent-runtime"
import { tool } from "@zerone-agent/open-agent-sdk"
import { z } from "zod"

const weatherTool = tool("get_weather", "获取天气", { city: z.string() }, async ({ city }) => ({
  content: [{ type: "text", text: `${city}今天晴，25°C` }]
}))

export default defineConfig({
  server: { port: 3000 },

  agents: [
    defineAgent({
      id: "researcher",
      model: "claude-sonnet-4-6",
      systemPromptFile: "./prompts/researcher.md",

      tools: [weatherTool],

      hooks: {
        PreToolUse: async (ctx) => {
          console.log(`即将执行工具: ${ctx.tool_name}`)
          return { decision: "approve" }
        },
        PostToolUse: async (ctx) => {
          console.log(`工具执行完成: ${ctx.tool_name}`)
        }
      },

      dynamicSystemPrompt: async (ctx) => {
        return `当前时间: ${new Date().toISOString()}`
      },

      createAgent: async (options) => {
        return await createAgent({ ...options, maxTurns: 20 })
      }
    })
  ]
})
```

### Config File Discovery

Search order:
1. `--config <path>` CLI argument (explicit)
2. `agent.config.ts` in config directory (programmatic mode)
3. `agents.yaml` + `runtime.yaml` in config directory (declarative mode)
4. Current working directory
5. `~/.openagent/`

---

## API Design

All routes prefixed with `/v1`.

### Agent Management

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/agents` | List all registered agents |
| `GET` | `/v1/agents/:agentId` | Get agent details (config, status) |

### Agent Execution

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/agents/:agentId/runs` | Run agent (SSE streaming or blocking) |
| `POST` | `/v1/agents/:agentId/runs/:runId/cancel` | Cancel a running agent |

**Request body**:
```json
{
  "message": "帮我搜索最新的 AI 论文",
  "sessionId": "optional, reuse existing session",
  "userId": "optional, user identifier",
  "stream": true
}
```

**SSE response** (`stream: true`):

Direct passthrough of SDK's `SDKMessage` events:

```
event: assistant
data: {"type":"assistant","content":[...]}

event: tool_result
data: {"type":"tool_result","toolName":"WebSearch",...}

event: result
data: {"type":"result","cost":0.05,...}

event: done
data: {}
```

**Blocking response** (`stream: false`):
```json
{
  "sessionId": "abc-123",
  "messages": [...],
  "usage": { "inputTokens": 1500, "outputTokens": 800 },
  "cost": 0.05
}
```

### Session Management

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/sessions` | List all sessions |
| `POST` | `/v1/sessions` | Create new session |
| `GET` | `/v1/sessions/:sessionId` | Get session details (with message history) |
| `DELETE` | `/v1/sessions/:sessionId` | Delete session |

Reuses SDK's filesystem-based session storage (`~/.openagent/sessions/`).

### Health & Metrics

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | Health check (returns agent statuses) |
| `GET` | `/v1/metrics` | Token stats, request counts, costs |

---

## Core Modules

### AgentRegistry

```ts
class AgentRegistry {
  private agents: Map<string, Agent>

  async loadFromConfig(configPath: string): Promise<void>
  get(agentId: string): Agent
  list(): AgentInfo[]
  getStatus(agentId: string): AgentStatus
  async closeAll(): Promise<void>
}
```

**Lifecycle**:
- Startup: create all Agent instances from config (connect MCP, load Skills)
- Runtime: reuse cached instances across requests
- Session isolation: same Agent instance, different `sessionId` per conversation
- Shutdown: `closeAll()` gracefully disconnects MCP and cleans up

### SSE Bridge

```ts
async function streamToSSE(
  stream: AsyncGenerator<SDKMessage>,
  writable: WritableStream
): Promise<void> {
  for await (const event of stream) {
    writeSSE(writable, event.type, JSON.stringify(event))
  }
  writeSSE(writable, "done", "{}")
}
```

Directly serializes SDK's `SDKMessage` to SSE events. No transformation layer.

### Metrics Collector

In-memory counters, extracted from SDK `result` events:

```ts
interface RuntimeMetrics {
  totalRequests: number
  totalTokens: { input: number; output: number }
  totalCost: number
  agentMetrics: Record<string, {
    requests: number
    tokens: { input: number; output: number }
    cost: number
  }>
}
```

---

## Startup Flow

```
1. Parse CLI args (--config, --port)
2. Load runtime config (runtime.yaml or agent.config.ts)
3. Discover config files (see Config File Discovery)
4. AgentRegistry.loadFromConfig()
   - For each agent definition:
     - Resolve systemPromptFile -> read .md file
     - Create Agent instance via createAgent()
     - Connect MCP servers, load Skills
     - Cache in Map<id, Agent>
5. Create Hono app, register routes
6. Start HTTP server on configured host:port
7. Log registered agents and endpoints
```

---

## CLI

Phase 1 implements `start` only:

```bash
# Default config
open-agent start

# Specify config directory
open-agent start --config ./my-agents/

# Override port
open-agent start --port 8080
```

Entry point: `src/index.ts` exposes both `createRuntime()` (programmatic API) and CLI.

---

## Error Handling

| Scenario | Response |
|---|---|
| Agent ID not found | `404 { error: "Agent not found" }` |
| Config file missing / malformed | Startup failure, print error to stderr |
| SDK throws (invalid API key, model unavailable) | SSE `error` event then close, or `500` |
| Request body validation failure | `400 { error: "Invalid request body" }` |
| Run cancelled | SSE `done` event then close |
| Agent creation fails (MCP connection error) | Mark agent as `unavailable` at startup, return `503` on request |

---

## TypeScript Interface Summary

```ts
// config.ts
interface RuntimeConfig {
  server: { host?: string; port?: number }
  cors?: { origins: string[] }
  logging?: { level: "debug" | "info" | "warn" | "error" }
  agents: AgentDefinition[]
}

interface AgentDefinition {
  id: string
  name?: string
  model: string
  systemPrompt?: string
  systemPromptFile?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  tools?: ToolDefinition[]              // programmatic only
  hooks?: Partial<HookHandlers>         // programmatic only
  dynamicSystemPrompt?: (ctx: RunContext) => Promise<string>  // programmatic only
  createAgent?: (options: AgentOptions) => Promise<Agent>     // programmatic only
  mcpServers?: Record<string, McpServerConfig>
  skills?: string[]
  maxTurns?: number
  permissionMode?: PermissionMode
}

// Helper functions (typed identity functions, like Vite's defineConfig)
function defineConfig(config: RuntimeConfig): RuntimeConfig
function defineAgent(agent: AgentDefinition): AgentDefinition

// registry.ts
interface AgentInfo {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  toolCount: number
}

// sse.ts
function streamToSSE(stream: AsyncGenerator<SDKMessage>, writable: WritableStream): Promise<void>

// index.ts
function createRuntime(config: RuntimeConfig): Promise<{ app: Hono; start: () => Promise<void> }>
```

---

## What Phase 1 Does NOT Include

- Daemon process management (Phase 2)
- Redis/Postgres session adapters (Phase 2)
- Dashboard integration (Phase 3)
- Authentication / authorization (Phase 2)
- OpenTelemetry tracing (Phase 2)
- Deployer integration (Phase 2)
- A2A protocol (Phase 3)
- Rate limiting
- Request queuing / concurrency control

These are explicitly deferred to later phases per the product roadmap.
