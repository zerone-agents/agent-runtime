import { describe, it, expect, vi } from "vitest"
import { Hono } from "hono"
import { createHealthRouter, createMetricsRouter } from "../router/health.js"

function createHealthApp(registry: any) {
  const app = new Hono()
  app.route("/health", createHealthRouter(registry))
  return app
}

function createMetricsApp(metrics: any) {
  const app = new Hono()
  app.route("/v1/metrics", createMetricsRouter(metrics))
  return app
}

describe("Health Router", () => {
  describe("GET /health", () => {
    it("returns ok when all agents are ready", async () => {
      const registry = {
        list: vi.fn().mockReturnValue([
          { id: "a1", status: "ready" },
          { id: "a2", status: "ready" },
        ]),
      }
      const app = createHealthApp(registry)

      const res = await app.request("http://localhost/health")
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
      const app = createHealthApp(registry)

      const res = await app.request("http://localhost/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("degraded")
      expect(body.agents).toBe(2)
    })

    it("returns ok when there are no agents", async () => {
      const registry = { list: vi.fn().mockReturnValue([]) }
      const app = createHealthApp(registry)

      const res = await app.request("http://localhost/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("ok")
      expect(body.agents).toBe(0)
    })
  })
})

describe("Metrics Router", () => {
  describe("GET /v1/metrics", () => {
    it("returns the metrics snapshot", async () => {
      const snapshot = {
        totalRequests: 42,
        totalTokens: { input: 100, output: 200 },
        totalCost: 0.5,
        agentMetrics: {},
        uptime: 9999,
      }
      const metrics = { getSnapshot: vi.fn().mockReturnValue(snapshot) }
      const app = createMetricsApp(metrics)

      const res = await app.request("http://localhost/v1/metrics")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(snapshot)
      expect(metrics.getSnapshot).toHaveBeenCalledOnce()
    })
  })
})
