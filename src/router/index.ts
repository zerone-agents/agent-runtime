import { Hono } from "hono"
import { cors } from "hono/cors"
import type { RuntimeConfig } from "../config.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import { RunRegistry } from "../runs.js"
import { createHealthRouter, createMetricsRouter } from "./health.js"
import { createAgentRouter } from "./agent.js"
import { createSessionRouter } from "./session.js"
import { createFilesRouter } from "./files.js"
import { createRunsRouter } from "./runs.js"
import { createAuthMiddleware } from "../auth.js"
import { resolveAigcConfig } from "../aigc.js"
import { AigcAuditLog, type AigcRunRecord } from "../audit-log.js"

export interface CreateAppOptions {
  /** External persistence hook for the in-memory AIGC audit log. */
  onAigcRecord?: (record: AigcRunRecord) => void | Promise<void>
  /**
   * Optional injected RunRegistry. When omitted, a new instance is created
   * internally. Inject when the orchestrator (e.g. agent-deployer) needs to
   * call closeAll() on SIGTERM or query run state outside the HTTP API.
   */
  runsRegistry?: RunRegistry
}

export function createApp(
  config: RuntimeConfig,
  registry: AgentRegistry,
  metrics: MetricsCollector,
  options: CreateAppOptions = {},
) {
  const app = new Hono({ strict: false })

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  app.route("/health", createHealthRouter(registry))

  const apiKey = process.env.ZERONE_AGENT_HTTP_API_KEY ?? config.auth?.apiKey
  if (apiKey) {
    app.use("/v1/*", createAuthMiddleware(apiKey))
  }

  app.route("/v1/metrics", createMetricsRouter(metrics))

  const aigc = resolveAigcConfig(config.aigc)
  const auditLog = aigc ? new AigcAuditLog({ onRecord: options.onAigcRecord }) : undefined

  // Use injected RunRegistry if provided (orchestrator-managed lifecycle);
  // otherwise instantiate internally. Single instance serves all agent runs.
  const runsRegistry = options.runsRegistry ?? new RunRegistry()
  app.route("/v1/agents", createAgentRouter(registry, runsRegistry, metrics, { aigc, auditLog }))
  app.route("/v1/runs", createRunsRouter(runsRegistry))
  app.route("/v1/sessions", createSessionRouter())
  app.route("/v1/files", createFilesRouter())

  return app
}
