import { Hono } from "hono"
import type { AgentRegistry } from "../registry.js"
import type { MetricsCollector } from "../metrics.js"
import { streamAgentResponse } from "../sse.js"

export function createAgentRouter(registry: AgentRegistry, metrics: MetricsCollector) {
  const router = new Hono()

  router.get("/", (c) => {
    return c.json(registry.list())
  })

  router.get("/:agentId", (c) => {
    const { agentId } = c.req.param()
    const status = registry.getStatus(agentId)
    if (status === "not_found") {
      return c.json({ error: "Agent not found" }, 404)
    }
    return c.json({
      id: agentId,
      status,
    })
  })

  router.post("/:agentId/runs", async (c) => {
    const { agentId } = c.req.param()
    const agent = registry.get(agentId)

    if (!agent) {
      return c.json({ error: "Agent not found" }, 404)
    }

    const status = registry.getStatus(agentId)
    if (status === "unavailable") {
      return c.json({ error: "Agent unavailable" }, 503)
    }

    const body = await c.req.json().catch(() => null)
    if (!body?.message) {
      return c.json({ error: "Invalid request: message is required" }, 400)
    }

    const { message, sessionId, stream = true } = body

    const overrides: Record<string, any> = {}
    if (sessionId) overrides.sessionId = sessionId

    if (stream) {
      const agentStream = agent.query(message, overrides)
      return streamAgentResponse(c, agentStream)
    }

    const result = await agent.prompt(message, overrides)

    metrics.recordRun(agentId, result.usage, undefined)
    return c.json({
      sessionId: agent.getSessionId(),
      text: result.text,
      usage: result.usage,
      numTurns: result.num_turns,
      durationMs: result.duration_ms,
    })
  })

  return router
}
