import { Hono } from "hono"
import type { AgentRegistry } from "../registry.js"
import type { MetricsCollector } from "../metrics.js"

export function createHealthRouter(registry: AgentRegistry) {
  const router = new Hono()

  router.get("/", (c) => {
    const agents = registry.list()
    const allReady = agents.every((a) => a.status === "ready")
    return c.json({
      status: allReady ? "ok" : "degraded",
      agents: agents.length,
      uptime: Date.now(),
    })
  })

  return router
}

export function createMetricsRouter(metrics: MetricsCollector) {
  const router = new Hono()

  router.get("/", (c) => {
    return c.json(metrics.getSnapshot())
  })

  return router
}
