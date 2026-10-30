import { Hono } from "hono"
import type { SessionManagerV2 } from "@zerone-agent/agent-sdk/store"

/**
 * Session REST surface over the SDK v4 SessionManagerV2 (issue #131).
 *
 * `sessions` is the registry's file-backed manager
 * (AgentRegistry.getSessionManager()); undefined when the host never ran
 * loadFromConfig (register()-only embedders/tests) — no persistence exists,
 * so the list is empty and every lookup is a 404.
 *
 * Response shapes are unchanged from the v3 SDK-function router:
 *   GET    /v1/sessions            → SessionMetadata[]
 *   GET    /v1/sessions/:sessionId → { metadata, messages } | 404
 *   DELETE /v1/sessions/:sessionId → { ok: true } | 404
 */
export function createSessionRouter(sessions: SessionManagerV2 | undefined) {
  const router = new Hono()

  router.get("/", async (c) => {
    if (!sessions) return c.json([])
    const list = await sessions.list()
    return c.json(list)
  })

  router.get("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const state = await sessions?.get(sessionId)
    if (!state || !sessions) {
      return c.json({ error: "Session not found" }, 404)
    }
    const messages = await sessions.getMessages(sessionId)
    return c.json({ metadata: state.metadata, messages })
  })

  router.delete("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    // Existence pre-check: manager.delete on a missing session throws a
    // store error; the router contract is a 404, not a 500.
    const state = await sessions?.get(sessionId)
    if (!state || !sessions) {
      return c.json({ error: "Session not found" }, 404)
    }
    await sessions.delete(sessionId)
    return c.json({ ok: true })
  })

  return router
}
