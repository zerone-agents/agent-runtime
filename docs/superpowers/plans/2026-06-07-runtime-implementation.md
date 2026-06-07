# open-agent-runtime Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-agent HTTP Server runtime that wraps open-agent-sdk's Agent into a RESTful + SSE API, configurable via YAML or TypeScript.

**Architecture:** Monolithic Hono router. AgentRegistry loads Agent definitions from config at startup, caches Agent instances in-process. SSE bridge directly forwards SDK's `AsyncGenerator<SDKMessage>` events to HTTP clients. Session management delegates to SDK's filesystem storage.

**Tech Stack:** TypeScript (ESM), Hono, open-agent-sdk, yaml, zod

---

## File Structure

```
open-agent-runtime/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # createRuntime() + CLI entry
│   ├── config.ts             # Config loading (YAML + TS), validation
│   ├── registry.ts           # AgentRegistry class
│   ├── router/
│   │   ├── index.ts          # Hono app assembly
│   │   ├── agent.ts          # POST /v1/agents/:agentId/runs, GET /v1/agents
│   │   ├── session.ts        # Session CRUD
│   │   └── health.ts         # Health + Metrics
│   └── sse.ts                # AsyncGenerator<SDKMessage> → SSE bridge
├── agents.yaml
├── runtime.yaml
└── Dockerfile
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@zerone-agent/open-agent-runtime",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "open-agent": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node --import tsx src/index.ts",
    "test": "vitest"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@zerone-agent/open-agent-sdk": "^0.4.9",
    "hono": "^4.7.0",
    "yaml": "^2.7.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.1.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create minimal src/index.ts**

```ts
#!/usr/bin/env node
export async function createRuntime() {
  console.log("open-agent-runtime")
}

createRuntime()
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: dependencies installed, no errors

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 6: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold project with package.json, tsconfig, minimal entry"
```

---

### Task 2: Config Loading (YAML + TS) + Validation

**Files:**
- Create: `src/config.ts`

This module defines all config types, validates them with zod, loads from YAML files, and resolves `systemPromptFile` paths.

- [ ] **Step 1: Write config types and loader**

```ts
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

const ServerConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(3000),
})

const CorsConfigSchema = z.object({
  origins: z.array(z.string()).default(["*"]),
})

const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
})

const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("stdio"), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional() }),
  z.object({ transport: z.literal("sse"), url: z.string(), headers: z.record(z.string()).optional() }),
  z.object({ transport: z.literal("http"), url: z.string(), headers: z.record(z.string()).optional() }),
])

const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  model: z.string().default("claude-sonnet-4-6"),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
  maxTurns: z.number().default(10),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional(),
}).refine(
  (data) => !(data.systemPrompt && data.systemPromptFile),
  { message: "systemPrompt and systemPromptFile are mutually exclusive" },
)

export const RuntimeConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  cors: CorsConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  agents: z.array(AgentDefinitionSchema).min(1),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

export function resolveSystemPrompt(agent: AgentDefinition, configDir: string): string | undefined {
  if (agent.systemPrompt) return agent.systemPrompt
  if (agent.systemPromptFile) {
    const filePath = resolve(configDir, agent.systemPromptFile)
    return readFileSync(filePath, "utf-8")
  }
  return undefined
}

export function loadYamlConfig(configPath: string): RuntimeConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }
  const raw = readFileSync(configPath, "utf-8")
  const parsed = parseYaml(raw)
  return RuntimeConfigSchema.parse(parsed)
}

export function findConfigDir(explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath)

  const cwd = process.cwd()
  if (existsSync(resolve(cwd, "agents.yaml"))) return cwd
  if (existsSync(resolve(cwd, "agent.config.ts"))) return cwd

  const home = process.env.HOME || process.env.USERPROFILE || ""
  const homeConfig = resolve(home, ".openagent")
  if (existsSync(resolve(homeConfig, "agents.yaml"))) return homeConfig
  if (existsSync(resolve(homeConfig, "agent.config.ts"))) return homeConfig

  throw new Error("No config found. Create agents.yaml or agent.config.ts in current directory or ~/.openagent/")
}

export function discoverConfig(configDir: string): RuntimeConfig {
  const tsPath = resolve(configDir, "agent.config.ts")
  if (existsSync(tsPath)) {
    throw new Error("agent.config.ts programmatic mode is not yet supported in Phase 1. Use agents.yaml.")
  }

  const yamlPath = resolve(configDir, "agents.yaml")
  return loadYamlConfig(yamlPath)
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/config.ts && git commit -m "feat: add config loading with YAML parsing and zod validation"
```

---

### Task 3: AgentRegistry

**Files:**
- Create: `src/registry.ts`

This module manages Agent instances: creates them from config, caches them, provides lookup.

- [ ] **Step 1: Write AgentRegistry**

```ts
import { createAgent, type Agent } from "@zerone-agent/open-agent-sdk"
import type { AgentDefinition, RuntimeConfig } from "./config.js"
import { resolveSystemPrompt } from "./config.js"

export interface AgentInfo {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  toolCount: number
}

export class AgentRegistry {
  private agents = new Map<string, Agent>()
  private statuses = new Map<string, "ready" | "unavailable">()

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
    for (const def of config.agents) {
      try {
        const systemPrompt = resolveSystemPrompt(def, configDir)
        const agent = createAgent({
          model: def.model,
          systemPrompt,
          allowedTools: def.allowedTools,
          disallowedTools: def.disallowedTools,
          maxTurns: def.maxTurns,
          permissionMode: def.permissionMode,
          allowedSkills: def.skills,
          mcpServers: def.mcpServers as any,
        })

        this.agents.set(def.id, agent)
        this.statuses.set(def.id, "ready")
      } catch (err) {
        console.error(`Failed to create agent "${def.id}":`, err)
        this.statuses.set(def.id, "unavailable")
      }
    }
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId)
  }

  getStatus(agentId: string): "ready" | "unavailable" | "not_found" {
    return this.statuses.get(agentId) ?? "not_found"
  }

  list(): AgentInfo[] {
    const result: AgentInfo[] = []
    for (const [id] of this.agents) {
      result.push({
        id,
        name: id,
        model: "",
        status: this.statuses.get(id) ?? "unavailable",
        toolCount: 0,
      })
    }
    return result
  }

  async closeAll(): Promise<void> {
    for (const [id, agent] of this.agents) {
      try {
        await agent.close()
      } catch (err) {
        console.error(`Error closing agent "${id}":`, err)
      }
    }
    this.agents.clear()
    this.statuses.clear()
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/registry.ts && git commit -m "feat: add AgentRegistry for multi-agent instance management"
```

---

### Task 4: SSE Bridge

**Files:**
- Create: `src/sse.ts`

This module bridges SDK's `AsyncGenerator<SDKMessage>` to HTTP SSE response using Hono's streaming API.

- [ ] **Step 1: Write SSE bridge**

```ts
import type { SDKMessage } from "@zerone-agent/open-agent-sdk"
import { streamSSE } from "hono/streaming"
import type { Context } from "hono"

export function streamAgentResponse(
  c: Context,
  agentStream: AsyncGenerator<SDKMessage, void>,
) {
  return streamSSE(c, async (stream) => {
    try {
      for await (const event of agentStream) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
      await stream.writeSSE({ event: "done", data: "{}" })
    } catch (err: any) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: err.message ?? "Unknown error" }),
      })
      await stream.writeSSE({ event: "done", data: "{}" })
    }
  })
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/sse.ts && git commit -m "feat: add SSE bridge from SDK AsyncGenerator to HTTP"
```

---

### Task 5: Metrics Collector

**Files:**
- Create: `src/metrics.ts`

In-memory metrics, updated from SDK result events.

- [ ] **Step 1: Write metrics module**

```ts
export interface AgentMetrics {
  requests: number
  tokens: { input: number; output: number }
  cost: number
}

export interface RuntimeMetrics {
  totalRequests: number
  totalTokens: { input: number; output: number }
  totalCost: number
  agentMetrics: Record<string, AgentMetrics>
  uptime: number
}

export class MetricsCollector {
  private startTime = Date.now()
  private agents: Record<string, AgentMetrics> = {}

  recordRun(agentId: string, usage?: { input_tokens: number; output_tokens: number }, cost?: number) {
    if (!this.agents[agentId]) {
      this.agents[agentId] = { requests: 0, tokens: { input: 0, output: 0 }, cost: 0 }
    }
    const m = this.agents[agentId]
    m.requests++
    if (usage) {
      m.tokens.input += usage.input_tokens
      m.tokens.output += usage.output_tokens
    }
    if (cost != null) {
      m.cost += cost
    }
  }

  getSnapshot(): RuntimeMetrics {
    let totalRequests = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0
    for (const m of Object.values(this.agents)) {
      totalRequests += m.requests
      totalInput += m.tokens.input
      totalOutput += m.tokens.output
      totalCost += m.cost
    }
    return {
      totalRequests,
      totalTokens: { input: totalInput, output: totalOutput },
      totalCost,
      agentMetrics: { ...this.agents },
      uptime: Date.now() - this.startTime,
    }
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/metrics.ts && git commit -m "feat: add in-memory metrics collector"
```

---

### Task 6: Router — Health & Agent List

**Files:**
- Create: `src/router/health.ts`
- Create: `src/router/agent.ts` (agent list + run routes)
- Create: `src/router/session.ts` (session CRUD)
- Create: `src/router/index.ts` (assemble all routes)

- [ ] **Step 1: Write health router**

```ts
import { Hono } from "hono"
import type { AgentRegistry } from "../registry.js"
import type { MetricsCollector } from "../metrics.js"

export function createHealthRouter(registry: AgentRegistry, metrics: MetricsCollector) {
  const router = new Hono()

  router.get("/health", (c) => {
    const agents = registry.list()
    const allReady = agents.every((a) => a.status === "ready")
    return c.json({
      status: allReady ? "ok" : "degraded",
      agents: agents.length,
      uptime: Date.now(),
    })
  })

  router.get("/metrics", (c) => {
    return c.json(metrics.getSnapshot())
  })

  return router
}
```

- [ ] **Step 2: Write agent router**

```ts
import { Hono } from "hono"
import type { AgentRegistry } from "../registry.js"
import type { MetricsCollector } from "../metrics.js"
import { streamAgentResponse } from "../sse.js"

export function createAgentRouter(registry: AgentRegistry, metrics: MetricsCollector) {
  const router = new Hono()

  router.get("/", (c) => {
    return c.json(registry.list())
  })

  router.get("/:agentId", (c) => {
    const { agentId } = c.req.param()
    const status = registry.getStatus(agentId)
    if (status === "not_found") {
      return c.json({ error: "Agent not found" }, 404)
    }
    return c.json({
      id: agentId,
      status,
    })
  })

  router.post("/:agentId/runs", async (c) => {
    const { agentId } = c.req.param()
    const agent = registry.get(agentId)

    if (!agent) {
      return c.json({ error: "Agent not found" }, 404)
    }

    const status = registry.getStatus(agentId)
    if (status === "unavailable") {
      return c.json({ error: "Agent unavailable" }, 503)
    }

    const body = await c.req.json().catch(() => null)
    if (!body?.message) {
      return c.json({ error: "Invalid request: message is required" }, 400)
    }

    const { message, sessionId, stream = true } = body

    const overrides: Record<string, any> = {}
    if (sessionId) overrides.sessionId = sessionId

    if (stream) {
      const agentStream = agent.query(message, overrides)
      return streamAgentResponse(c, agentStream)
    }

    const result = await agent.prompt(message, overrides)

    metrics.recordRun(agentId, result.usage, undefined)
    return c.json({
      sessionId: agent.getSessionId(),
      text: result.text,
      usage: result.usage,
      numTurns: result.num_turns,
      durationMs: result.duration_ms,
    })
  })

  return router
}
```

- [ ] **Step 3: Write session router**

```ts
import { Hono } from "hono"
import {
  listSessions, getSessionInfo, getSessionMessages,
  deleteSession, type SessionMetadata,
} from "@zerone-agent/open-agent-sdk"

export function createSessionRouter() {
  const router = new Hono()

  router.get("/", async (c) => {
    const sessions = await listSessions()
    return c.json(sessions)
  })

  router.get("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const info = await getSessionInfo(sessionId)
    if (!info) {
      return c.json({ error: "Session not found" }, 404)
    }
    const messages = await getSessionMessages(sessionId)
    return c.json({ metadata: info, messages })
  })

  router.delete("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const deleted = await deleteSession(sessionId)
    if (!deleted) {
      return c.json({ error: "Session not found" }, 404)
    }
    return c.json({ ok: true })
  })

  return router
}
```

- [ ] **Step 4: Write router index (assemble Hono app)**

```ts
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { RuntimeConfig } from "../config.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import { createHealthRouter } from "./health.js"
import { createAgentRouter } from "./agent.js"
import { createSessionRouter } from "./session.js"

export function createApp(config: RuntimeConfig, registry: AgentRegistry, metrics: MetricsCollector) {
  const app = new Hono()

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  const healthRouter = createHealthRouter(registry, metrics)
  const agentRouter = createAgentRouter(registry, metrics)
  const sessionRouter = createSessionRouter()

  app.route("/v1/health", healthRouter)
  app.route("/v1/agents", agentRouter)
  app.route("/v1/sessions", sessionRouter)

  return app
}
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/router/ && git commit -m "feat: add Hono routers for agents, sessions, health, metrics"
```

---

### Task 7: Main Entry + CLI

**Files:**
- Modify: `src/index.ts`

Wire everything together: parse CLI args, load config, create registry, start server.

- [ ] **Step 1: Rewrite src/index.ts**

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util"
import { discoverConfig, findConfigDir } from "./config.js"
import { AgentRegistry } from "./registry.js"
import { MetricsCollector } from "./metrics.js"
import { createApp } from "./router/index.js"

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
    },
    strict: false,
  })

  const configDir = findConfigDir(values.config)
  const config = discoverConfig(configDir)

  if (values.port) {
    config.server.port = parseInt(values.port, 10)
  }

  console.log(`Loading config from: ${configDir}`)
  console.log(`Agents: ${config.agents.map((a) => a.id).join(", ")}`)

  const registry = new AgentRegistry()
  await registry.loadFromConfig(config, configDir)

  const metrics = new MetricsCollector()
  const app = createApp(config, registry, metrics)

  const { serve } = await import("hono/node-server")
  serve(
    { fetch: app.fetch, port: config.server.port, hostname: config.server.host },
    (info) => {
      console.log(`open-agent-runtime listening on http://${info.address}:${info.port}`)
    },
  )
}

export { createApp, AgentRegistry, MetricsCollector, discoverConfig, findConfigDir }

main().catch((err) => {
  console.error("Failed to start:", err.message)
  process.exit(1)
})
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts && git commit -m "feat: wire CLI entry with config loading, registry, and Hono server"
```

---

### Task 8: Sample Config Files

**Files:**
- Create: `agents.yaml`
- Create: `runtime.yaml`

- [ ] **Step 1: Create runtime.yaml**

```yaml
server:
  host: "0.0.0.0"
  port: 3000

cors:
  origins: ["*"]

logging:
  level: "info"
```

- [ ] **Step 2: Create agents.yaml**

```yaml
agents:
  - id: "general"
    name: "通用助手"
    model: "claude-sonnet-4-6"
    systemPrompt: "你是一个通用 AI 助手。"
    maxTurns: 10
```

- [ ] **Step 3: Commit**

```bash
git add agents.yaml runtime.yaml && git commit -m "chore: add sample config files"
```

---

### Task 9: Integration Smoke Test

**Files:**
- None (manual verification)

- [ ] **Step 1: Start the runtime**

Run: `npm start`
Expected: `open-agent-runtime listening on http://0.0.0.0:3000`

- [ ] **Step 2: Test health endpoint**

Run: `curl http://localhost:3000/v1/health`
Expected: `{"status":"ok","agents":1,"uptime":...}`

- [ ] **Step 3: Test agent list**

Run: `curl http://localhost:3000/v1/agents`
Expected: `[{...id:"general"...}]`

- [ ] **Step 4: Test agent run (SSE)**

Run: `curl -N -X POST http://localhost:3000/v1/agents/general/runs -H "Content-Type: application/json" -d '{"message":"hello","stream":true}'`
Expected: SSE stream with `event: system`, `event: assistant`, `event: done`, etc.

- [ ] **Step 5: Test session list**

Run: `curl http://localhost:3000/v1/sessions`
Expected: JSON array of sessions

- [ ] **Step 6: Test metrics**

Run: `curl http://localhost:3000/v1/metrics`
Expected: `{"totalRequests":1,"totalTokens":{...},"totalCost":...}`

---

### Task 10: Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY agents.yaml runtime.yaml ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile && git commit -m "chore: add Dockerfile for container deployment"
```

---

## Summary of Commits

1. `chore: scaffold project with package.json, tsconfig, minimal entry`
2. `feat: add config loading with YAML parsing and zod validation`
3. `feat: add AgentRegistry for multi-agent instance management`
4. `feat: add SSE bridge from SDK AsyncGenerator to HTTP`
5. `feat: add in-memory metrics collector`
6. `feat: add Hono routers for agents, sessions, health, metrics`
7. `feat: wire CLI entry with config loading, registry, and Hono server`
8. `chore: add sample config files`
9. (smoke test — no commit)
10. `chore: add Dockerfile for container deployment`
