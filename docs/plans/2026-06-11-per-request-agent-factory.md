# Per-Request Agent Factory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor runtime so each HTTP request creates a fresh Agent, executes, then closes it. Session resume works by passing `sessionId` → SDK `resume` field.

**Architecture:** Registry stores agent definitions + pre-computed `createAgent()` options (no live instances). Router calls `registry.create(agentId, sessionId)` per request, gets an Agent, runs it, then closes it in a finally block.

**Tech Stack:** TypeScript, Hono, Vitest, `@zerone-agent/open-agent-sdk`

---

### Task 1: Refactor `AgentRegistry` to factory pattern

**Files:**
- Modify: `src/registry.ts`
- Test: `src/__tests__/registry.test.ts`

**Step 1: Write failing tests for the new registry API**

Replace the entire test file. The new tests should cover:

1. `loadFromConfig` stores definitions but does NOT call `createAgent`
2. `create(agentId)` returns a new Agent from `createAgent`
3. `create(agentId, sessionId)` passes `resume: sessionId` to `createAgent`
4. `create("unknown")` returns undefined
5. `create("unavailable-agent")` returns undefined
6. `list()` returns info based on definitions
7. `getStatus()` returns ready/unavailable/not_found based on definitions
8. `closeAll()` is now a no-op (no live instances to close)

```ts
// src/__tests__/registry.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentRegistry } from "../registry.js"

vi.mock("@zerone-agent/open-agent-sdk", () => ({
  createAgent: vi.fn(),
}))

vi.mock("../config.js", () => ({
  resolveSystemPrompt: vi.fn(() => "test-prompt"),
}))

import { createAgent } from "@zerone-agent/open-agent-sdk"

const mockCreateAgent = vi.mocked(createAgent)

function makeConfig(agents: any[]) {
  return {
    server: { host: "0.0.0.0", port: 3000 },
    agents,
  } as any
}

describe("AgentRegistry (factory)", () => {
  let registry: AgentRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new AgentRegistry()
  })

  describe("loadFromConfig", () => {
    it("stores definitions without creating agents", async () => {
      const config = makeConfig([
        { id: "agent-a", model: "gpt-4" },
        { id: "agent-b", model: "claude-3" },
      ])

      await registry.loadFromConfig(config, "/tmp")

      expect(mockCreateAgent).not.toHaveBeenCalled()
      expect(registry.getStatus("agent-a")).toBe("ready")
      expect(registry.getStatus("agent-b")).toBe("ready")
    })

    it("marks agent as unavailable when resolveSystemPrompt throws", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("file not found")
      })

      const config = makeConfig([
        { id: "bad-agent", model: "gpt-4" },
        { id: "good-agent", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      expect(registry.getStatus("bad-agent")).toBe("unavailable")
      expect(registry.getStatus("good-agent")).toBe("ready")
    })
  })

  describe("create", () => {
    it("creates a new agent per call", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent.mockReturnValue(mockAgent as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const agent = await registry.create("my-agent")
      expect(agent).toBe(mockAgent)
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4", systemPrompt: "test-prompt" }),
      )
    })

    it("passes resume: sessionId when sessionId provided", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent.mockReturnValue(mockAgent as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const agent = await registry.create("my-agent", "sess-123")
      expect(agent).toBe(mockAgent)
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ resume: "sess-123" }),
      )
    })

    it("does not pass resume when sessionId is undefined", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent.mockReturnValue(mockAgent as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      await registry.create("my-agent")
      const opts = mockCreateAgent.mock.calls[0][0] as any
      expect(opts.resume).toBeUndefined()
    })

    it("returns undefined for unknown agent", async () => {
      const agent = await registry.create("nonexistent")
      expect(agent).toBeUndefined()
    })

    it("returns undefined for unavailable agent", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })

      const config = makeConfig([{ id: "bad", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const agent = await registry.create("bad")
      expect(agent).toBeUndefined()
    })

    it("creates independent agents on each call", async () => {
      const agent1 = { close: vi.fn().mockResolvedValue(undefined) }
      const agent2 = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent
        .mockReturnValueOnce(agent1 as any)
        .mockReturnValueOnce(agent2 as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const a1 = await registry.create("my-agent")
      const a2 = await registry.create("my-agent")
      expect(a1).toBe(agent1)
      expect(a2).toBe(agent2)
      expect(mockCreateAgent).toHaveBeenCalledTimes(2)
    })
  })

  describe("list", () => {
    it("returns AgentInfo based on definitions", async () => {
      const config = makeConfig([
        { id: "agent-1", name: "Agent One", model: "gpt-4", allowedTools: ["tool-a", "tool-b"] },
        { id: "agent-2", name: "Agent Two", model: "claude-3" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      const listed = registry.list()
      expect(listed).toHaveLength(2)
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "agent-1", name: "Agent One", model: "gpt-4", toolCount: 2, status: "ready" }),
          expect.objectContaining({ id: "agent-2", name: "Agent Two", model: "claude-3", toolCount: 0, status: "ready" }),
        ]),
      )
    })

    it("excludes unavailable agents from list", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })

      const config = makeConfig([
        { id: "agent-1", model: "gpt-4" },
        { id: "agent-2", model: "gpt-4" },
        { id: "agent-3", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      const listed = registry.list()
      expect(listed).toHaveLength(2)
      expect(listed.map((a) => a.id).sort()).toEqual(["agent-1", "agent-3"])
    })
  })

  describe("getStatus", () => {
    it("returns ready for loaded agent", async () => {
      const config = makeConfig([{ id: "a1", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")
      expect(registry.getStatus("a1")).toBe("ready")
    })

    it("returns unavailable for failed agent", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })
      const config = makeConfig([{ id: "a2", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")
      expect(registry.getStatus("a2")).toBe("unavailable")
    })

    it("returns not_found for unknown agent", () => {
      expect(registry.getStatus("unknown")).toBe("not_found")
    })
  })

  describe("closeAll", () => {
    it("is a no-op (no live instances)", async () => {
      const config = makeConfig([{ id: "a1", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      await registry.closeAll()

      expect(mockCreateAgent).not.toHaveBeenCalled()
    })
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/registry.test.ts`
Expected: FAIL — `registry.create is not a function`, tests about `loadFromConfig` not calling `createAgent` fail

**Step 3: Implement the refactored registry**

Replace `src/registry.ts`:

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

type CreateOpts = Parameters<typeof createAgent>[0]

export class AgentRegistry {
  private defs = new Map<string, AgentDefinition>()
  private createOpts = new Map<string, CreateOpts>()
  private statuses = new Map<string, "ready" | "unavailable">()

  register(id: string, def: AgentDefinition, opts: CreateOpts): void {
    this.defs.set(id, def)
    this.createOpts.set(id, opts)
    this.statuses.set(id, "ready")
  }

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
    for (const def of config.agents) {
      try {
        const systemPrompt = resolveSystemPrompt(def, configDir)
        const opts: CreateOpts = {
          model: process.env.OPENAGENT_MODEL ?? def.model,
          apiType: (process.env.OPENAGENT_API_TYPE as any) ?? undefined,
          apiKey: process.env.OPENAGENT_API_KEY ?? undefined,
          baseURL: process.env.OPENAGENT_BASE_URL ?? undefined,
          systemPrompt,
          allowedTools: def.allowedTools,
          disallowedTools: def.disallowedTools,
          maxTurns: def.maxTurns,
          permissionMode: def.permissionMode,
          allowedSkills: def.skills,
          mcpServers: def.mcpServers as any,
          thinking: def.thinking as any,
        }

        this.defs.set(def.id, def)
        this.createOpts.set(def.id, opts)
        this.statuses.set(def.id, "ready")
      } catch (err) {
        console.error(`Failed to configure agent "${def.id}":`, err)
        this.defs.set(def.id, def)
        this.statuses.set(def.id, "unavailable")
      }
    }
  }

  create(agentId: string, sessionId?: string): Agent | undefined {
    const opts = this.createOpts.get(agentId)
    if (!opts) return undefined
    if (this.statuses.get(agentId) !== "ready") return undefined

    const merged = sessionId ? { ...opts, resume: sessionId } : opts
    return createAgent(merged)
  }

  getStatus(agentId: string): "ready" | "unavailable" | "not_found" {
    return this.statuses.get(agentId) ?? "not_found"
  }

  list(): AgentInfo[] {
    const envModel = process.env.OPENAGENT_MODEL
    const result: AgentInfo[] = []
    for (const [id, def] of this.defs) {
      const status = this.statuses.get(id)
      if (status !== "ready") continue
      result.push({
        id,
        name: def.name ?? def.id,
        model: envModel ?? def.model ?? "",
        status: "ready",
        toolCount: def.allowedTools?.length ?? 0,
      })
    }
    return result
  }

  async closeAll(): Promise<void> {
    this.defs.clear()
    this.createOpts.clear()
    this.statuses.clear()
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/registry.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/registry.ts src/__tests__/registry.test.ts
git commit -m "refactor: AgentRegistry to factory pattern — store definitions, create agents per request"
```

---

### Task 2: Refactor router to per-request agent lifecycle

**Files:**
- Modify: `src/router/agent.ts`
- Test: `src/__tests__/router-agent.test.ts`

**Step 1: Write failing tests for the new router behavior**

Replace `src/__tests__/router-agent.test.ts`. Key changes:
- `registry.get` → `registry.create` (returns fresh Agent per call)
- Streaming tests: verify `agent.close` is called after stream
- Blocking test: verify `agent.close` is called after prompt
- sessionId test: verify `registry.create` is called with sessionId, not passed as override
- Remove test that checks `overrides.sessionId` is forwarded to `agent.prompt`

```ts
// src/__tests__/router-agent.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createAgentRouter } from "../router/agent.js"

vi.mock("../sse.js", () => ({
  streamAgentResponse: vi.fn().mockReturnValue(new Response("sse-stream", { status: 200 })),
}))

import { streamAgentResponse } from "../sse.js"

function createApp(registry: any, metrics: any) {
  const app = new Hono()
  const router = createAgentRouter(registry, metrics)
  app.route("/v1/agents", router)
  return app
}

describe("Agent Router (per-request)", () => {
  let registry: any
  let metrics: any

  beforeEach(() => {
    registry = {
      list: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn(),
    }
    metrics = {
      recordRun: vi.fn(),
    }
    vi.mocked(streamAgentResponse).mockClear()
  })

  describe("GET /v1/agents", () => {
    it("returns a list of agents", async () => {
      const agents = [
        { id: "agent-1", name: "Agent One", status: "ready", toolCount: 3 },
      ]
      registry.list.mockReturnValue(agents)
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(agents)
    })
  })

  describe("GET /v1/agents/:agentId", () => {
    it("returns agent detail when found", async () => {
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/my-agent")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ id: "my-agent", status: "ready" })
    })

    it("returns 404 for unknown agent", async () => {
      registry.getStatus.mockReturnValue("not_found")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/unknown")
      expect(res.status).toBe(404)
    })
  })

  describe("POST /v1/agents/:agentId/runs", () => {
    it("returns 404 if agent not found (create returns undefined)", async () => {
      registry.create.mockReturnValue(undefined)
      registry.getStatus.mockReturnValue("not_found")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/missing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      })
      expect(res.status).toBe(404)
    })

    it("returns 503 if agent unavailable", async () => {
      registry.create.mockReturnValue(undefined)
      registry.getStatus.mockReturnValue("unavailable")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/down/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      })
      expect(res.status).toBe(503)
    })

    it("returns 400 if message is missing", async () => {
      registry.create.mockReturnValue({})
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it("creates agent with sessionId for resume, returns blocking response", async () => {
      const agent = {
        query: vi.fn(),
        prompt: vi.fn().mockResolvedValue({
          text: "Hello world",
          usage: { input_tokens: 10, output_tokens: 20 },
          num_turns: 1,
          duration_ms: 150,
        }),
        getSessionId: vi.fn().mockReturnValue("sess-new"),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", stream: false, sessionId: "sess-old" }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.text).toBe("Hello world")
      expect(body.sessionId).toBe("sess-new")
      expect(registry.create).toHaveBeenCalledWith("a1", "sess-old")
      expect(agent.prompt).toHaveBeenCalledWith("hello", {})
      expect(agent.close).toHaveBeenCalledOnce()
      expect(metrics.recordRun).toHaveBeenCalledWith("a1", { input_tokens: 10, output_tokens: 20 }, undefined)
    })

    it("creates agent without sessionId for new session", async () => {
      const agent = {
        query: vi.fn(),
        prompt: vi.fn().mockResolvedValue({
          text: "ok",
          usage: { input_tokens: 5, output_tokens: 5 },
          num_turns: 1,
          duration_ms: 50,
        }),
        getSessionId: vi.fn().mockReturnValue("sess-fresh"),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: false }),
      })
      expect(res.status).toBe(200)
      expect(registry.create).toHaveBeenCalledWith("a1", undefined)
    })

    it("streams via streamAgentResponse and closes agent when stream=true", async () => {
      async function* gen() {
        yield { type: "text", text: "hi" }
      }
      const agent = {
        query: vi.fn().mockImplementation(() => gen()),
        prompt: vi.fn(),
        getSessionId: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      })
      expect(res.status).toBe(200)
      expect(streamAgentResponse).toHaveBeenCalledOnce()
      expect(agent.query).toHaveBeenCalledWith("hello", { includePartialMessages: true })
      expect(agent.close).toHaveBeenCalledOnce()
    })

    it("closes agent even on error (blocking mode)", async () => {
      const agent = {
        query: vi.fn(),
        prompt: vi.fn().mockRejectedValue(new Error("LLM error")),
        getSessionId: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", stream: false }),
      })
      expect(agent.close).toHaveBeenCalledOnce()
    })
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/router-agent.test.ts`
Expected: FAIL — `registry.create is not a function`, wrong method being called, `agent.close` not called

**Step 3: Implement the refactored router**

Replace `src/router/agent.ts`:

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

    const body = await c.req.json().catch(() => null)
    if (!body?.message) {
      return c.json({ error: "Invalid request: message is required" }, 400)
    }

    const { message, sessionId, stream = true } = body

    const status = registry.getStatus(agentId)
    if (status === "not_found") {
      return c.json({ error: "Agent not found" }, 404)
    }
    if (status === "unavailable") {
      return c.json({ error: "Agent unavailable" }, 503)
    }

    const agent = registry.create(agentId, sessionId)
    if (!agent) {
      return c.json({ error: "Agent not found" }, 404)
    }

    if (stream === "block") {
      const agentStream = agent.query(message)
      return streamAgentResponse(c, agentStream, () => agent.close())
    }

    if (stream === true || stream === "raw") {
      const agentStream = agent.query(message, { includePartialMessages: true })
      return streamAgentResponse(c, agentStream, () => agent.close())
    }

    try {
      const result = await agent.prompt(message)
      metrics.recordRun(agentId, result.usage, undefined)
      return c.json({
        sessionId: agent.getSessionId(),
        text: result.text,
        usage: result.usage,
        numTurns: result.num_turns,
        durationMs: result.duration_ms,
      })
    } finally {
      await agent.close()
    }
  })

  return router
}
```

**Step 4: Update `streamAgentResponse` to accept cleanup callback**

Modify `src/sse.ts` — add optional `onDone` callback:

```ts
import type { SDKMessage } from "@zerone-agent/open-agent-sdk"
import { streamSSE } from "hono/streaming"
import type { Context } from "hono"

export function streamAgentResponse(
  c: Context,
  agentStream: AsyncGenerator<SDKMessage, void>,
  onDone?: () => Promise<void> | void,
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
    } finally {
      await onDone?.()
    }
  })
}
```

**Step 5: Run all tests**

Run: `npx vitest run src/__tests__/router-agent.test.ts src/__tests__/registry.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/router/agent.ts src/sse.ts src/__tests__/router-agent.test.ts
git commit -m "refactor: per-request agent lifecycle — create/close per HTTP request, sessionId → resume"
```

---

### Task 3: Update index.ts and public API

**Files:**
- Modify: `src/index.ts`

**Step 1: Update index.ts**

The `loadFromConfig` call stays the same (it's async, returns void). No changes needed to `main()` since the API is compatible. But review the exports — `AgentInfo` is still exported correctly.

Verify `src/index.ts` needs no changes — it calls `registry.loadFromConfig(config, configDir)` which has the same signature.

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors

**Step 3: Run full test suite**

Run: `npm test`
Expected: ALL PASS

**Step 4: Commit (if any changes)**

```bash
git add -A
git commit -m "chore: update public API for factory pattern registry"
```

---

### Task 4: Verify end-to-end

**Step 1: Run full typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: ALL PASS

**Step 2: Manual smoke test (optional)**

Run: `npm run start -- -c examples/simple`
Expected: Server starts, agents listed at `/v1/agents`

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: final adjustments for per-request factory pattern"
```
