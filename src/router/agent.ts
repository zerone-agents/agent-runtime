import { Hono } from "hono"
import { createHash } from "node:crypto"
import type { AgentRegistry } from "../registry.js"
import { RunIdConflictError, type RunRegistry } from "../runs.js"
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
  runsRegistry: RunRegistry,
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

    const { message, sessionId, stream, maxSessionTurns, runId: callerRunId } = body

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

    // Register run BEFORE any SDK call, so early cancels are addressable.
    // Optional caller-provided runId enables JSON-blocking-mode cancellation:
    // otherwise the client cannot know the runtime-generated ID until prompt()
    // resolves. Reject duplicates (active or recently terminal) with 409, and
    // malformed UUIDs with 400. In both error cases we must close the
    // just-created Agent — register failure must not leak SDK resources.
    let runId: string
    try {
      runId = runsRegistry.register(
        { agent, agentId, sessionId: agent.getSessionId?.() ?? "" },
        callerRunId,
      )
    } catch (err) {
      // Cleanup the Agent we created above. Swallow rejection so the
      // documented 4xx response is preserved regardless of close() outcome.
      await agent.close().catch(() => {})
      if (err instanceof RunIdConflictError) {
        return c.json({ error: "Run ID conflict", runId: err.runId }, 409)
      }
      return c.json({ error: (err as Error).message }, 400)
    }
    c.header("X-Run-ID", runId)

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

    // Streamable HTTP: Accept header content negotiation
    const accept = c.req.header("Accept") ?? ""
    const wantsJson = accept.includes("application/json") && !accept.includes("text/event-stream")
    const wantsSse = accept.includes("text/event-stream")

    // Determine response mode:
    // 1. Accept header takes priority (Streamable HTTP)
    // 2. Fall back to body.stream field (backward compatibility)
    let responseMode: "json" | "sse-block" | "sse-raw"
    if (wantsJson) {
      responseMode = "json"
    } else if (wantsSse) {
      responseMode = stream === "block" ? "sse-block" : "sse-raw"
    } else {
      // Backward compatibility: use body.stream field
      const streamValue = stream ?? true
      if (streamValue === false) {
        responseMode = "json"
      } else if (streamValue === "block") {
        responseMode = "sse-block"
      } else {
        responseMode = "sse-raw"
      }
    }

    const handleTerminal = (state: "cancelled" | "completed" | "failed", reason?: string, usage?: any) => {
      if (usage) metrics.recordRun(agentId, usage, undefined)
      runsRegistry.markTerminal(runId, state, reason)
    }

    if (responseMode === "sse-block") {
      const agentStream = agent.query(message, { maxSessionTurns })
      return streamAgentResponse(c, agentStream, undefined, {
        aigc: aigcLabel,
        explicitHint,
        runId,
        runsRegistry,
        onTerminal: handleTerminal,
      })
    }

    if (responseMode === "sse-raw") {
      const agentStream = agent.query(message, { includePartialMessages: true, maxSessionTurns })
      recordAudit() // SSE: text unknown at stream start
      return streamAgentResponse(c, agentStream, undefined, {
        aigc: aigcLabel,
        explicitHint,
        runId,
        runsRegistry,
        onTerminal: handleTerminal,
      })
    }

    // JSON blocking response
    try {
      const result = await agent.prompt(message, { maxSessionTurns })
      recordAudit(result.text)

      const runInfo = runsRegistry.get(runId)
      if (runInfo?.state === "cancelling" || runInfo?.state === "cancelled") {
        // Cancelled during prompt: coerce cancelling → cancelled via markTerminal.
        // This ensures agent.close() is called exactly once and the run record
        // transitions out of the active map. The finally block's state guard
        // (state === "running") will then skip, so no double-close.
        // Metrics are NOT recorded here: a client-aborted run should not
        // conflate "completed work" with "cancelled work" in metrics.
        runsRegistry.markTerminal(runId, "cancelled", runInfo.reason ?? "client_request")
        return c.json({
          runId,
          sessionId: agent.getSessionId(),
          state: "cancelled",
          reason: runInfo.reason ?? "client_request",
          text: result.text,
          usage: result.usage,
          numTurns: result.num_turns,
          durationMs: result.duration_ms,
          ...(aigcLabel ? { aigc: aigcLabel, ...(explicitHint ? { aigcExplicitHint: true } : {}) } : {}),
        })
      }

      metrics.recordRun(agentId, result.usage, undefined)
      return c.json({
        runId,
        sessionId: agent.getSessionId(),
        text: result.text,
        usage: result.usage,
        numTurns: result.num_turns,
        durationMs: result.duration_ms,
        ...(aigcLabel ? { aigc: aigcLabel, ...(explicitHint ? { aigcExplicitHint: true } : {}) } : {}),
      })
    } catch (err) {
      // SDK may reject prompt() when interrupted (AbortError propagates
      // from provider fetch through engine). If the run was cancelled, the
      // caller should see the documented cancelled response, not an error.
      const runInfo = runsRegistry.get(runId)
      if (runInfo?.state === "cancelling" || runInfo?.state === "cancelled") {
        runsRegistry.markTerminal(runId, "cancelled", runInfo.reason ?? "client_request")
        return c.json({
          runId,
          sessionId: agent.getSessionId(),
          state: "cancelled",
          reason: runInfo.reason ?? "client_request",
          // No text/usage: prompt rejected, no partial result is available.
          ...(aigcLabel ? { aigc: aigcLabel, ...(explicitHint ? { aigcExplicitHint: true } : {}) } : {}),
        })
      }
      runsRegistry.markTerminal(runId, "failed", "error")
      throw err
    } finally {
      // Guard: if still running (no cancel, no error), mark completed.
      // markTerminal itself is idempotent; guard is for readability.
      const info = runsRegistry.get(runId)
      if (info?.state === "running") {
        runsRegistry.markTerminal(runId, "completed", "stream_end")
      }
    }
  })

  return router
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
