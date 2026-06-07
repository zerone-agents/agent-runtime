import { describe, it, expect, vi } from "vitest"
import { Hono } from "hono"
import { createHealthRouter } from "../router/health.js"

function createApp(registry: any, metrics: any) {
  const app = new Hono()
  const router = createHealthRouter(registry, metrics)
  app.route("/v1", router)
  return app
}

describe("Health Router", () => {
  describe("GET /v1/health", () => {
    it("returns ok when all agents are ready", async () => {
      const registry = {
        list: vi.fn().mockReturnValue([
          { id: "a1", status: "ready" },
          { id: "a2", status: "ready" },
        ]),
      }
      const metrics = { getSnapshot: vi.fn() }
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("ok")
      expect(body.agents).toBe(2)
    })

    it("returns degraded when some agents are unavailable", async () => {
      const registry = {
        list: vi.fn().mockReturnValue([
          { id: "a1", status: "ready" },
          { id: "a2", status: "unavailable" },
        ]),
      }
      const metrics = { getSnapshot: vi.fn() }
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("degraded")
      expect(body.agents).toBe(2)
    })

    it("returns ok when there are no agents", async () => {
      const registry = { list: vi.fn().mockReturnValue([]) }
      const metrics = { getSnapshot: vi.fn() }
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("ok")
      expect(body.agents).toBe(0)
    })
  })

  describe("GET /v1/metrics", () => {
    it("returns the metrics snapshot", async () => {
      const snapshot = {
        totalRequests: 42,
        totalTokens: { input: 100, output: 200 },
        totalCost: 0.5,
        agentMetrics: {},
        uptime: 9999,
      }
      const registry = { list: vi.fn() }
      const metrics = { getSnapshot: vi.fn().mockReturnValue(snapshot) }
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/metrics")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(snapshot)
      expect(metrics.getSnapshot).toHaveBeenCalledOnce()
    })
  })
})
