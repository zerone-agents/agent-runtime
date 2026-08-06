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
