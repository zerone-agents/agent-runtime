import { Hono } from "hono"
import { createHash } from "node:crypto"
import type { AgentRegistry } from "../registry.js"
import { RunIdConflictError, RunRegistryClosedError, type RunRegistry } from "../runs.js"
import type { MetricsCollector } from "../metrics.js"
import { streamAgentResponse } from "../sse.js"
import { buildAigcLabel, type AigcConfig } from "../aigc.js"
import type { AigcAuditLog } from "../audit-log.js"
import type { HubChatPusher, HubIdentity } from "../hub-push.js"
import type { AgentInput } from "@zerone-agent/agent-sdk"
import {
  AttachmentError,
  buildAgentInput,
  parseAttachmentDescriptors,
  validateAttachments,
} from "../attachments.js"
import { EXPECTED_CONTAINER_ID_HEADER, GenerationError, assertExpectedGeneration, generationErrorPayload } from "../container-id.js"

export interface AgentRouterOptions {
  aigc?: AigcConfig
  auditLog?: AigcAuditLog
  hubPusher?: HubChatPusher
  /** Working directory for attachment resolution. Default: process.cwd(). */
  cwd?: string
}

// Hub rejects push-key sessions without user_name (HTTP 400); warn at most
// once per process when we skip a push for a missing X-User-Name header.
let warnedMissingUserName = false

export function createAgentRouter(
  registry: AgentRegistry,
  runsRegistry: RunRegistry,
  metrics: MetricsCollector,
  options: AgentRouterOptions = {},
) {
  const router = new Hono()
  const cwd = options.cwd ?? process.cwd()

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
    // Legacy field name rejected explicitly (not silently ignored): a
    // dropped session cap would silently become unlimited.
    if (typeof body === "object" && body !== null && "maxSessionTurns" in body) {
      return c.json(
        { error: "maxSessionTurns was renamed to maxSessionQueries — use the new field name" },
        400,
      )
    }

    const { message, sessionId, stream, maxSessionQueries, runId: callerRunId } = body

    const status = registry.getStatus(agentId)
    if (status === "not_found") {
      return c.json({ error: "Agent not found" }, 404)
    }
    if (status === "unavailable") {
      return c.json({ error: "Agent unavailable" }, 503)
    }

    // Attachments (issue #43): parse + validate BEFORE creating the agent so
    // invalid requests never leak SDK resources. undefined/null/[] → legacy
    // plain-text path with zero behavior change.
    let agentInput: AgentInput = message
    if (body.attachments !== undefined && body.attachments !== null) {
      try {
        const descriptors = parseAttachmentDescriptors(body.attachments)
        if (descriptors.length > 0) {
          // 代次原子校验（issue #61）：仅在真正存在附件时校验——
          // attachments: [] 等同纯文本请求，零行为变化
          const expectedGen = c.req.header(EXPECTED_CONTAINER_ID_HEADER)
          if (expectedGen !== undefined) await assertExpectedGeneration(expectedGen)
          const validated = await validateAttachments(cwd, descriptors)
          agentInput = await buildAgentInput(message, validated)
        }
      } catch (err) {
        if (err instanceof GenerationError) {
          const { status, body } = generationErrorPayload(err)
          return c.json(body, status)
        }
        if (err instanceof AttachmentError) {
          const status = err.code === "upload_limit_exceeded" ? 413 : 400
          return c.json(
            {
              error: err.message,
              code: err.code,
              ...(err.path !== undefined ? { path: err.path } : {}),
            },
            status,
          )
        }
        throw err
      }
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
      if (err instanceof RunRegistryClosedError) {
        return c.json({ error: "Runtime is shutting down", code: "shutting_down" }, 503)
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

    // Hub chat push: fire-and-forget after a run completes successfully.
    // 用户归属来自网关注入的 X-User-Name 头（必填，缺失跳过推送）；
    // 租户归属来自部署级配置 hub.org（#28），请求头 X-Org 已删除。
    const identity: HubIdentity = {
      userName: c.req.header("X-User-Name"),
    }
    const pushToHub = () => {
      const pusher = options.hubPusher
      if (!pusher) return
      if (!identity.userName) {
        if (!warnedMissingUserName) {
          warnedMissingUserName = true
          console.warn("[hub-push] X-User-Name header absent; skipping push (hub requires user_name)")
        }
        return
      }
      const sid = agent.getSessionId?.()
      if (!sid) return
      const model = registry.getModel(agentId)
      if (!model) return // agent 已过 getStatus/create 校验，此分支仅类型防御
      void pusher.pushSession({
        sessionId: sid,
        agentId,
        model,
        identity,
      }).catch(() => {}) // pushSession 契约上永不 reject；此处仅防御
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
      if (state === "completed") pushToHub()
    }

    if (responseMode === "sse-block") {
      const agentStream = agent.query(agentInput, { maxSessionQueries })
      return streamAgentResponse(c, agentStream, undefined, {
        aigc: aigcLabel,
        explicitHint,
        runId,
        runsRegistry,
        onTerminal: handleTerminal,
      })
    }

    if (responseMode === "sse-raw") {
      const agentStream = agent.query(agentInput, { includePartialMessages: true, maxSessionQueries })
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
      const result = await agent.prompt(agentInput, { maxSessionQueries })
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

      // SDK >= 1.2.4: prompt() surfaces upstream engine errors via is_error
      // instead of returning a success-looking empty result. Cancelled runs
      // are already handled above and take precedence; here the run was not
      // cancelled, so map the failure to a proper HTTP status.
      if (result.is_error) {
        runsRegistry.markTerminal(runId, "failed", result.error_type ?? "error")
        return c.json(
          {
            runId,
            sessionId: agent.getSessionId(),
            state: "failed",
            error: result.errors?.[0] ?? "Agent run failed",
            errorType: result.error_type,
            errors: result.errors,
            text: result.text, // may contain partial output before the failure
            usage: result.usage,
            numTurns: result.num_turns,
            durationMs: result.duration_ms,
            ...(aigcLabel ? { aigc: aigcLabel, ...(explicitHint ? { aigcExplicitHint: true } : {}) } : {}),
          },
          result.error_type === "rate_limit" ? 429 : 502,
        )
      }

      metrics.recordRun(agentId, result.usage, undefined)
      pushToHub()
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
