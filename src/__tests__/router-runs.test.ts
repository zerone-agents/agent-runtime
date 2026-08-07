import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createRunsRouter } from "../router/runs.js"
import { RunRegistry } from "../runs.js"

function makeMockAgent() {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getSessionId: vi.fn().mockReturnValue("s1"),
  } as any
}

function createApp(registry: RunRegistry) {
  const app = new Hono()
  app.route("/v1/runs", createRunsRouter(registry))
  return app
}

describe("POST /v1/runs/:runId/cancel", () => {
  let registry: RunRegistry

  beforeEach(() => {
    registry = new RunRegistry({ ttlMs: 60_000, sweepMs: 60_000 })
  })

  it("returns 202 and state=cancelling for an active running run", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toEqual({ runId: id, state: "cancelling", reason: undefined })
  })

  it("triggers agent.interrupt() exactly once", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )
    await Promise.resolve()

    expect(agent.interrupt).toHaveBeenCalledTimes(1)
  })

  it("returns 202 cancelling for 2nd cancel during cancelling state (idempotent)", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    const app = createApp(registry)
    await app.request(`http://localhost/v1/runs/${id}/cancel`, { method: "POST" })
    const res2 = await app.request(`http://localhost/v1/runs/${id}/cancel`, { method: "POST" })

    expect(res2.status).toBe(202)
    const body = await res2.json()
    expect(body.state).toBe("cancelling")
  })

  it("returns 202 cancelled for cancel after run has terminated as cancelled", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    registry.cancel(id)
    registry.markTerminal(id, "cancelled", "client_request")

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.state).toBe("cancelled")
  })

  it("returns 404 for unknown runId", async () => {
    const res = await createApp(registry).request(
      "http://localhost/v1/runs/nonexistent/cancel",
      { method: "POST" },
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: "Run not found" })
  })

  it("returns 409 with state=completed when run already completed", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    registry.markTerminal(id, "completed", "stream_end")

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.state).toBe("completed")
  })

  it("returns 409 with state=failed when run already failed", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    registry.markTerminal(id, "failed", "error")

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.state).toBe("failed")
  })

  it("cancelling one run does not affect another concurrent run", async () => {
    const agent1 = makeMockAgent()
    const agent2 = makeMockAgent()
    const id1 = registry.register({ agent: agent1, agentId: "a1", sessionId: "s1" })
    const id2 = registry.register({ agent: agent2, agentId: "a1", sessionId: "s2" })

    const app = createApp(registry)
    await app.request(`http://localhost/v1/runs/${id1}/cancel`, { method: "POST" })
    await Promise.resolve()

    expect(agent1.interrupt).toHaveBeenCalledTimes(1)
    expect(agent2.interrupt).not.toHaveBeenCalled()
    expect(registry.get(id2)?.state).toBe("running")
  })
})

import { createApp as createFullApp } from "../router/index.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import type { RuntimeConfig } from "../config.js"

describe("cancel endpoint auth integration", () => {
  it("returns 401 when API key is required but not provided", async () => {
    // Mock SDK so AgentRegistry doesn't try to load real config
    vi.doMock("@zerone-agent/agent-sdk", () => ({ createAgent: vi.fn() }))
    vi.doMock("../skills.js", () => ({ scanSkills: vi.fn(async () => []) }))

    const config: any = {
      server: { host: "0.0.0.0", port: 3000 },
      auth: { apiKey: "secret-key" },
      agents: [{ id: "a1", model: "glm-4.5" }],
    }
    const registry = new AgentRegistry()
    await registry.loadFromConfig(config, "/tmp")
    const metrics = new MetricsCollector()
    const app = createFullApp(config, registry, metrics)

    const res = await app.request(
      "http://localhost/v1/runs/anything/cancel",
      { method: "POST" },
    )

    expect(res.status).toBe(401)
  })

  it("passes auth when correct API key is provided", async () => {
    vi.doMock("@zerone-agent/agent-sdk", () => ({ createAgent: vi.fn() }))
    vi.doMock("../skills.js", () => ({ scanSkills: vi.fn(async () => []) }))

    const config: any = {
      server: { host: "0.0.0.0", port: 3000 },
      auth: { apiKey: "secret-key" },
      agents: [{ id: "a1", model: "glm-4.5" }],
    }
    const registry = new AgentRegistry()
    await registry.loadFromConfig(config, "/tmp")
    const metrics = new MetricsCollector()
    const app = createFullApp(config, registry, metrics)

    // Unknown runId returns 404 (not 401) when auth passes
    const res = await app.request(
      "http://localhost/v1/runs/nonexistent/cancel",
      {
        method: "POST",
        headers: { "X-API-Key": "secret-key" },
      },
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Run not found" })
  })
})

describe("CreateAppOptions.runsRegistry injection", () => {
  it("injected RunRegistry owns runs created through the app", async () => {
    // Lightweight mock registry — only what createApp touches
    const injected = new RunRegistry({ ttlMs: 60_000, sweepMs: 60_000 })

    // Mock SDK so AgentRegistry.loadFromConfig doesn't try real I/O
    vi.doMock("@zerone-agent/agent-sdk", () => ({ createAgent: vi.fn() }))
    vi.doMock("../skills.js", () => ({ scanSkills: vi.fn(async () => []) }))

    const config: any = {
      server: { host: "0.0.0.0", port: 3000 },
      agents: [{ id: "a1", model: "glm-4.5" }],
    }
    const registry = new AgentRegistry()
    await registry.loadFromConfig(config, "/tmp")
    const metrics = new MetricsCollector()
    const app = createFullApp(config, registry, metrics, { runsRegistry: injected })

    // Verify the injected instance is reachable: register a run externally,
    // then cancel via the app's /v1/runs endpoint.
    const agent = makeMockAgent()
    const runId = injected.register({ agent, agentId: "a1", sessionId: "s1" })

    const res = await app.request(`http://localhost/v1/runs/${runId}/cancel`, {
      method: "POST",
    })

    expect(res.status).toBe(202)
    expect(injected.get(runId)?.state).toBe("cancelling")
  })
})
