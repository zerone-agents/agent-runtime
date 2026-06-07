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
