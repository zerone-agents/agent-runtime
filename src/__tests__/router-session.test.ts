import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"

vi.mock("@zerone-agent/open-agent-sdk", () => ({
  listSessions: vi.fn(),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
}))

import { listSessions, getSessionInfo, getSessionMessages, deleteSession } from "@zerone-agent/open-agent-sdk"
import { createSessionRouter } from "../router/session.js"

function createApp() {
  const app = new Hono()
  const router = createSessionRouter()
  app.route("/v1/sessions", router)
  return app
}

describe("Session Router", () => {
  beforeEach(() => {
    vi.mocked(listSessions).mockReset()
    vi.mocked(getSessionInfo).mockReset()
    vi.mocked(getSessionMessages).mockReset()
    vi.mocked(deleteSession).mockReset()
  })

  describe("GET /v1/sessions", () => {
    it("returns sessions list", async () => {
      const sessions = [
        { id: "s1", createdAt: "2025-01-01" },
        { id: "s2", createdAt: "2025-01-02" },
      ]
      vi.mocked(listSessions).mockResolvedValue(sessions)
      const app = createApp()

      const res = await app.request("http://localhost/v1/sessions")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(sessions)
      expect(listSessions).toHaveBeenCalledOnce()
    })
  })

  describe("GET /v1/sessions/:sessionId", () => {
    it("returns session detail with messages", async () => {
      const info = { id: "s1", createdAt: "2025-01-01" }
      const messages = [{ role: "user", content: "hello" }]
      vi.mocked(getSessionInfo).mockResolvedValue(info)
      vi.mocked(getSessionMessages).mockResolvedValue(messages)
      const app = createApp()

      const res = await app.request("http://localhost/v1/sessions/s1")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ metadata: info, messages })
      expect(getSessionInfo).toHaveBeenCalledWith("s1")
      expect(getSessionMessages).toHaveBeenCalledWith("s1")
    })

    it("returns 404 if session not found", async () => {
      vi.mocked(getSessionInfo).mockResolvedValue(null)
      const app = createApp()

      const res = await app.request("http://localhost/v1/sessions/missing")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Session not found")
    })
  })

  describe("DELETE /v1/sessions/:sessionId", () => {
    it("returns ok when session is deleted", async () => {
      vi.mocked(deleteSession).mockResolvedValue(true)
      const app = createApp()

      const res = await app.request("http://localhost/v1/sessions/s1", { method: "DELETE" })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
      expect(deleteSession).toHaveBeenCalledWith("s1")
    })

    it("returns 404 if session not found", async () => {
      vi.mocked(deleteSession).mockResolvedValue(false)
      const app = createApp()

      const res = await app.request("http://localhost/v1/sessions/missing", { method: "DELETE" })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Session not found")
    })
  })
})
