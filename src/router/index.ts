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
