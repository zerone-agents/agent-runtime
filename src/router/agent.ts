import { Hono } from "hono"
import { createHash } from "node:crypto"
import type { AgentRegistry } from "../registry.js"
import type { MetricsCollector } from "../metrics.js"
import { streamAgentResponse } from "../sse.js"
import { buildAigcLabel, type AigcConfig } from "../aigc.js"
import type { AigcAuditLog } from "../audit-log.js"

export interface AgentRouterOptions {
  aigc?: AigcConfig
  auditLog?: AigcAuditLog
}

export function createAgentRouter(
  registry: AgentRegistry,
  metrics: MetricsCollector,
  options: AgentRouterOptions = {},
) {
  const router = new Hono()

  router.get("/", (c) => {
    return c.json(registry.list())
  })

  router.get("/:agentId", (c) => {
    const { agentId } = c.req.param()
    const detail = registry.getDetail(agentId)
    if (!detail) {
      return c.json({ error: "Agent not found" }, 404)
    }
    return c.json(detail)
  })

  router.post("/:agentId/runs", async (c) => {
    const { agentId } = c.req.param()

    const body = await c.req.json().catch(() => null)
    if (!body?.message) {
      return c.json({ error: "Invalid request: message is required" }, 400)
    }

    const { message, sessionId, stream = true, maxSessionTurns } = body

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

    const aigcLabel = options.aigc
      ? buildAigcLabel(options.aigc, registry.getModel(agentId))
      : undefined
    const explicitHint = options.aigc?.explicitHint ?? false

    const recordAudit = (text?: string) => {
      if (!aigcLabel || !options.auditLog) return
      options.auditLog.record({
        produceId: aigcLabel.ProduceID,
        createdAt: new Date().toISOString(),
        agentId,
        model: registry.getModel(agentId),
        sessionId: agent.getSessionId?.(),
        ...(text !== undefined ? { contentHash: sha256(text) } : {}),
      })
    }

    if (stream === "block") {
      const agentStream = agent.query(message, { maxSessionTurns })
      return streamAgentResponse(c, agentStream, () => agent.close(), {
        aigc: aigcLabel,
        explicitHint,
      })
    }

    if (stream === true || stream === "raw") {
      const agentStream = agent.query(message, { includePartialMessages: true, maxSessionTurns })
      recordAudit() // SSE: text unknown at stream start
      return streamAgentResponse(c, agentStream, () => agent.close(), {
        aigc: aigcLabel,
        explicitHint,
      })
    }

    try {
      const result = await agent.prompt(message, { maxSessionTurns })
      metrics.recordRun(agentId, result.usage, undefined)
      recordAudit(result.text)
      return c.json({
        sessionId: agent.getSessionId(),
        text: result.text,
        usage: result.usage,
        numTurns: result.num_turns,
        durationMs: result.duration_ms,
        ...(aigcLabel ? { aigc: aigcLabel, ...(explicitHint ? { aigcExplicitHint: true } : {}) } : {}),
      })
    } finally {
      await agent.close()
    }
  })

  return router
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
