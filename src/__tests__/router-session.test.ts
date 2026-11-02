import { describe, it, expect, vi } from "vitest"
import { Hono } from "hono"
import { createSessionRouter } from "../router/session.js"
import type { SessionManagerV2 } from "@zerone-agent/agent-sdk/store"
import { makeSessionState } from "./helpers/session.js"

/**
 * SDK v4（issue #131）：session router 经惰性 getter 取 SessionManagerV2 读
 * 会话（v3 的 listSessions/getSessionInfo/getSessionMessages/deleteSession
 * 模块函数已移除）。测试用 stub manager——路由映射契约（list/get/delete →
 * 响应形状、404 语义、幽灵会话过滤、级联删除）在此层钉住；store 真实行为
 * 由 SDK 侧测试 + runtime 的集成测试（compaction/skills/subagent-spawn）
 * 覆盖。
 */

function stateFor(sessionId: string, ownership?: { rootSessionId: string; parentSessionId?: string }) {
  return makeSessionState(sessionId, ownership ? { ownership } : {})
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

function createApp(getSessions: () => SessionManagerV2 | undefined) {
  const app = new Hono()
  const router = createSessionRouter(getSessions)
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
      const manager = stubManager({
        list: vi.fn(async () => sessions as never),
        get: vi.fn(async (sessionId: string) => stateFor(sessionId) as never),
      })
      const app = createApp(() => manager)

      const res = await app.request("http://localhost/v1/sessions")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(sessions)
      expect(manager.list).toHaveBeenCalledOnce()
    })

    it("hides subagent spawn rows and the engine agentId pseudo-session from the list", async () => {
      // v4 store persists a row per spawn (spawn-subagent pre-registration +
      // child transcript) plus prepareChildOwnership's 'main' row — none are
      // user-visible conversations. Only self-root sessions are listed.
      const listed = [
        { id: "s1", cwd: "/tmp", model: "test", createdAt: "2025-01-01", updatedAt: "2025-01-01", messageCount: 1 },
        { id: "child-x", cwd: "/tmp", model: "test", createdAt: "2025-01-01", updatedAt: "2025-01-01", messageCount: 1 },
        { id: "main", cwd: "/tmp", model: "test", createdAt: "2025-01-01", updatedAt: "2025-01-01", messageCount: 0 },
      ]
      const manager = stubManager({
        list: vi.fn(async () => listed as never),
        get: vi.fn(async (sessionId: string) =>
          (sessionId === "child-x"
            ? stateFor(sessionId, { rootSessionId: "s1", parentSessionId: "main" })
            : sessionId === "main"
              ? stateFor(sessionId, { rootSessionId: "s1" }) // 伪行：root 指向他者
              : stateFor(sessionId)) as never,
        ),
      })
      const app = createApp(() => manager)

      const res = await app.request("http://localhost/v1/sessions")
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ id: string }>
      expect(body.map((s) => s.id)).toEqual(["s1"])
    })

    it("returns an empty list when no session manager is configured", async () => {
      const app = createApp(() => undefined)
      const res = await app.request("http://localhost/v1/sessions")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    })

    it("resolves the manager lazily per request (reload re-anchor safe)", async () => {
      // getter 每次请求解析：reload 后换 manager，路由不持旧实例
      let current: SessionManagerV2 | undefined = stubManager({ list: vi.fn(async () => [{ id: "old" }] as never) })
      const app = createApp(() => current)
      const res1 = await app.request("http://localhost/v1/sessions")
      expect((await res1.json()) as unknown[]).toEqual([{ id: "old" }])

      current = stubManager({ list: vi.fn(async () => [{ id: "new" }] as never) })
      const res2 = await app.request("http://localhost/v1/sessions")
      expect((await res2.json()) as unknown[]).toEqual([{ id: "new" }])
    })
  })

  describe("GET /v1/sessions/:sessionId", () => {
    it("returns session detail with messages", async () => {
      const manager = stubManager()
      const app = createApp(() => manager)

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
      const app = createApp(() => manager)

      const res = await app.request("http://localhost/v1/sessions/missing")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Session not found")
    })

    it("returns 404 for subagent spawn rows (list hides them, by-id too)", async () => {
      // 子会话行在 store 中存在但非用户会话——显式 id 读取同样 404，
      // 与列表过滤一致（客户端可从 SSE subagent 事件得知其 id）。
      const manager = stubManager({
        get: vi.fn(async (sessionId: string) =>
          stateFor(sessionId, { rootSessionId: "root-1", parentSessionId: "main" }) as never,
        ),
      })
      const app = createApp(() => manager)

      const res = await app.request("http://localhost/v1/sessions/child-x")
      expect(res.status).toBe(404)
      expect(manager.getMessages).not.toHaveBeenCalled()
    })

    it("returns 404 when no session manager is configured", async () => {
      const app = createApp(() => undefined)
      const res = await app.request("http://localhost/v1/sessions/s1")
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe("Session not found")
    })
  })

  describe("DELETE /v1/sessions/:sessionId", () => {
    it("returns ok when session is deleted, cascading to owned subagent rows", async () => {
      const manager = stubManager()
      const app = createApp(() => manager)

      const res = await app.request("http://localhost/v1/sessions/s1", { method: "DELETE" })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
      expect(manager.get).toHaveBeenCalledWith("s1")
      // cascadeOwned=true：subagent 幽灵行随主会话一并删除，不留孤儿
      expect(manager.delete).toHaveBeenCalledWith("s1", true)
    })

    it("returns 404 if session not found (no delete attempted)", async () => {
      const manager = stubManager({ get: vi.fn(async () => null) })
      const app = createApp(() => manager)

      const res = await app.request("http://localhost/v1/sessions/missing", { method: "DELETE" })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Session not found")
      expect(manager.delete).not.toHaveBeenCalled()
    })

    it("returns 404 for subagent spawn rows (internal, not deletable by id)", async () => {
      const manager = stubManager({
        get: vi.fn(async (sessionId: string) =>
          stateFor(sessionId, { rootSessionId: "root-1", parentSessionId: "main" }) as never,
        ),
      })
      const app = createApp(() => manager)

      const res = await app.request("http://localhost/v1/sessions/child-x", { method: "DELETE" })
      expect(res.status).toBe(404)
      // 幽灵行不经此面删除——随所属主会话的级联删除消亡
      expect(manager.delete).not.toHaveBeenCalled()
    })

    it("returns 404 when no session manager is configured", async () => {
      const app = createApp(() => undefined)
      const res = await app.request("http://localhost/v1/sessions/s1", { method: "DELETE" })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe("Session not found")
    })
  })
})
