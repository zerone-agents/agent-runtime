import { Hono } from "hono"
import { cors } from "hono/cors"
import type { RuntimeConfig } from "../config.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import { createHealthRouter, createMetricsRouter } from "./health.js"
import { createAgentRouter } from "./agent.js"
import { createSessionRouter } from "./session.js"

export function createApp(config: RuntimeConfig, registry: AgentRegistry, metrics: MetricsCollector) {
  const app = new Hono()

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  app.route("/health", createHealthRouter(registry))
  app.route("/v1/metrics", createMetricsRouter(metrics))
  app.route("/v1/agents", createAgentRouter(registry, metrics))
  app.route("/v1/sessions", createSessionRouter())

  return app
}
