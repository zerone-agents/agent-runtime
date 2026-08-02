import { Hono } from "hono"
import {
  listSessions, getSessionInfo, getSessionMessages,
  deleteSession,
} from "@zerone-agent/agent-sdk"

export function createSessionRouter() {
  const router = new Hono()

  router.get("/", async (c) => {
    const sessions = await listSessions()
    return c.json(sessions)
  })

  router.get("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const info = await getSessionInfo(sessionId)
    if (!info) {
      return c.json({ error: "Session not found" }, 404)
    }
    const messages = await getSessionMessages(sessionId)
    return c.json({ metadata: info, messages })
  })

  router.delete("/:sessionId", async (c) => {
    const { sessionId } = c.req.param()
    const deleted = await deleteSession(sessionId)
    if (!deleted) {
      return c.json({ error: "Session not found" }, 404)
    }
    return c.json({ ok: true })
  })

  return router
}
