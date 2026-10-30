import { describe, it, expect, vi } from "vitest"
import { Hono } from "hono"
import { createSessionRouter } from "../router/session.js"
import type { SessionManagerV2 } from "@zerone-agent/agent-sdk/store"

/**
 * SDK v4（issue #131）：session router 经注入的 SessionManagerV2 读会话
 * （v3 的 listSessions/getSessionInfo/getSessionMessages/deleteSession 模块
 * 函数已移除）。测试用 stub manager——路由映射契约（list/get/delete → 响应
 * 形状与 404 语义）在此层钉住；store 真实行为由 SDK 侧测试 + runtime 的
 * 集成测试（compaction/skills/diagnostics）覆盖。
 */

function stateFor(sessionId: string) {
  return {
    sessionId,
    metadata: {
      id: sessionId,
      cwd: "/tmp",
      model: "test",
      provider: "test",
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
      messageCount: 1,
    },
    branches: [],
    currentBranchId: "b1",
    revision: 1,
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    ownership: { rootSessionId: sessionId },
  }
}

function stubManager(overrides: Partial<SessionManagerV2> = {}): SessionManagerV2 {
  return {
    get: vi.fn(async (sessionId: string) => stateFor(sessionId) as never),
    getMessages: vi.fn(async () => [{ role: "user", content: "hello" }] as never),
    list: vi.fn(async () => [] as never),
    delete: vi.fn(async () => ({}) as never),
    ...overrides,
  } as unknown as SessionManagerV2
}

function createApp(sessions: SessionManagerV2 | undefined) {
  const app = new Hono()
  const router = createSessionRouter(sessions)
  app.route("/v1/sessions", router)
  return app
}

describe("Session Router", () => {
  describe("GET /v1/sessions", () => {
    it("returns sessions list", async () => {
      const sessions = [
        { id: "s1", cwd: "/tmp", model: "test", provider: "test", createdAt: "2025-01-01", updatedAt: "2025-01-01", messageCount: 1 },
        { id: "s2", cwd: "/tmp", model: "test", provider: "test", createdAt: "2025-01-02", updatedAt: "2025-01-02", messageCount: 2 },
      ]
      const manager = stubManager({ list: vi.fn(async () => sessions as never) })
      const app = createApp(manager)

      const res = await app.request("http://localhost/v1/sessions")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(sessions)
      expect(manager.list).toHaveBeenCalledOnce()
    })

    it("returns an empty list when no session manager is configured", async () => {
      const app = createApp(undefined)
      const res = await app.request("http://localhost/v1/sessions")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    })
  })

  describe("GET /v1/sessions/:sessionId", () => {
    it("returns session detail with messages", async () => {
      const manager = stubManager()
      const app = createApp(manager)

      const res = await app.request("http://localhost/v1/sessions/s1")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.metadata).toMatchObject({ id: "s1", cwd: "/tmp", model: "test" })
      expect(body.messages).toEqual([{ role: "user", content: "hello" }])
      expect(manager.get).toHaveBeenCalledWith("s1")
      expect(manager.getMessages).toHaveBeenCalledWith("s1")
    })

    it("returns 404 if session not found", async () => {
      const manager = stubManager({ get: vi.fn(async () => null) })
      const app = createApp(manager)

      const res = await app.request("http://localhost/v1/sessions/missing")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Session not found")
    })

    it("returns 404 when no session manager is configured", async () => {
      const app = createApp(undefined)
      const res = await app.request("http://localhost/v1/sessions/s1")
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe("Session not found")
    })
  })

  describe("DELETE /v1/sessions/:sessionId", () => {
    it("returns ok when session is deleted", async () => {
      const manager = stubManager()
      const app = createApp(manager)

      const res = await app.request("http://localhost/v1/sessions/s1", { method: "DELETE" })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
      expect(manager.delete).toHaveBeenCalledWith("s1")
    })

    it("returns 404 if session not found (no delete attempted)", async () => {
      const manager = stubManager({ get: vi.fn(async () => null) })
      const app = createApp(manager)

      const res = await app.request("http://localhost/v1/sessions/missing", { method: "DELETE" })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Session not found")
      expect(manager.delete).not.toHaveBeenCalled()
    })

    it("returns 404 when no session manager is configured", async () => {
      const app = createApp(undefined)
      const res = await app.request("http://localhost/v1/sessions/s1", { method: "DELETE" })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe("Session not found")
    })
  })
})
