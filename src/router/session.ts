import { Hono } from "hono"
import type { SessionManagerV2 } from "@zerone-agent/agent-sdk/store"

/**
 * Session REST surface over the SDK v4 SessionManagerV2 (issue #131).
 *
 * `getSessions` is a LAZY accessor (registry.getSessionManager), resolved per
 * request: a config reload can re-anchor the registry's store (dataRoot
 * change), and a manager captured at createApp time would then read/write a
 * different store than the one new runs persist through. Undefined accessor
 * result (register()-only hosts that never ran loadFromConfig) means no
 * persistence exists — empty list, 404 lookups.
 *
 * Response shapes:
 *   GET    /v1/sessions            → SessionMetadata[] (self-root sessions only)
 *   GET    /v1/sessions/:sessionId → { metadata, messages } | 404
 *   DELETE /v1/sessions/:sessionId → { ok: true } | 404
 */
export function createSessionRouter(getSessions: () => SessionManagerV2 | undefined) {
  const router = new Hono()

  router.get("/", async (c) => {
    const sessions = getSessions()
    if (!sessions) return c.json([])
    const list = await sessions.list()
    // v4 store persists a row for EVERY subagent spawn (spawn pre-registration
    // + child transcript) and for the engine's agentId pseudo-session
    // ('main', registered by prepareChildOwnership) — none are user-visible
    // conversations (v3 never persisted them). Self-root test: the session is
    // its own ownership root and has no parent. Filtering keeps
    // GET /v1/sessions to real conversations.
    const visible: unknown[] = []
    for (const meta of list) {
      const state = await sessions.get(meta.id)
      if (
        state &&
        state.ownership.rootSessionId === state.sessionId &&
        !state.ownership.parentSessionId
      ) {
        visible.push(meta)
      }
    }
    return c.json(visible)
  })

  router.get("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const sessions = getSessions()
    const state = await sessions?.get(sessionId)
    if (!state || !sessions) {
      return c.json({ error: "Session not found" }, 404)
    }
    const messages = await sessions.getMessages(sessionId)
    return c.json({ metadata: state.metadata, messages })
  })

  router.delete("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const sessions = getSessions()
    // Existence pre-check: manager.delete on a missing session throws a
    // store error; the router contract is a 404, not a 500.
    const state = await sessions?.get(sessionId)
    if (!state || !sessions) {
      return c.json({ error: "Session not found" }, 404)
    }
    // cascadeOwned: the session's subagent rows (Task/MultiTask spawns) are
    // internal — deleting the conversation removes them too, no orphans.
    await sessions.delete(sessionId, true)
    return c.json({ ok: true })
  })

  return router
}
