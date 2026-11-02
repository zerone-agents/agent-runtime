import { Hono } from "hono"
import type { SessionMetadata } from "@zerone-agent/agent-sdk"
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
 * The surface shows USER conversations only: subagent spawn rows and the
 * engine agentId pseudo-session ('main') persist in the store but are hidden
 * from both the list and by-id detail (self-root test, see list below) —
 * clients can learn a spawn row's id from SSE subagent events, but it is
 * internal machinery, not a conversation (v3 never persisted them).
 *
 * Response shapes:
 *   GET    /v1/sessions            → SessionMetadata[] (self-root sessions only)
 *   GET    /v1/sessions/:sessionId → { metadata, messages } | 404
 *   DELETE /v1/sessions/:sessionId → { ok: true } | 404
 */
export function createSessionRouter(getSessions: () => SessionManagerV2 | undefined) {
  const router = new Hono()

  /** 自根判定：v4 store 为每次 subagent spawn 落持久行（spawn 预登记 +
   * transcript 终态），prepareChildOwnership 还会注册 engine agentId
   * （'main'）伪行——均非用户可见会话。 */
  async function isUserSession(
    sessions: SessionManagerV2,
    sessionId: string,
  ): Promise<boolean> {
    const state = await sessions.get(sessionId)
    return (
      state !== null &&
      state.ownership.rootSessionId === state.sessionId &&
      !state.ownership.parentSessionId
    )
  }

  router.get("/", async (c) => {
    const sessions = getSessions()
    if (!sessions) return c.json([])
    const list = await sessions.list()
    const visible: SessionMetadata[] = []
    for (const meta of list) {
      if (await isUserSession(sessions, meta.id)) {
        visible.push(meta)
      }
    }
    return c.json(visible)
  })

  router.get("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const sessions = getSessions()
    const state = await sessions?.get(sessionId)
    if (!state || !sessions || !(await isUserSession(sessions, sessionId))) {
      return c.json({ error: "Session not found" }, 404)
    }
    const messages = await sessions.getMessages(sessionId)
    return c.json({ metadata: state.metadata, messages })
  })

  router.delete("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const sessions = getSessions()
    // Existence pre-check: manager.delete on a missing session throws a
    // store error; the router contract is a 404, not a 500. Ghost rows are
    // not deletable through this surface (internal machinery — they die
    // with their owning conversation's cascade).
    if (!sessions || !(await isUserSession(sessions, sessionId))) {
      return c.json({ error: "Session not found" }, 404)
    }
    // cascadeOwned: the session's subagent rows (Task/MultiTask spawns) are
    // internal — deleting the conversation removes them too, no orphans.
    await sessions.delete(sessionId, true)
    return c.json({ ok: true })
  })

  return router
}
