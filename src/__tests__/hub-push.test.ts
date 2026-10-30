import { describe, expect, it, vi } from "vitest"
import { buildSessionPayload, HubChatPusher, resolveHubConfig } from "../hub-push.js"
import type { SessionManagerV2 } from "@zerone-agent/agent-sdk/store"

/**
 * SDK v4（issue #131）：buildSessionPayload / HubChatPusher 经注入的
 * SessionManagerV2 读 transcript（v3 的 saveSession/getSessionInfo/
 * getSessionMessages 模块函数已随会话存储重写移除）。测试用内存 stub
 * manager 播种会话数据——无磁盘 I/O，无需 afterEach 清理。
 */

interface SeedMessage {
  role: "user" | "assistant"
  content: unknown
  id?: string
  timestamp?: string
  rawUsage?: unknown
}

const SESSION_CREATED_AT = "2026-08-28T09:00:00.000Z"

function stateFor(sessionId: string, messages: SeedMessage[]) {
  return {
    sessionId,
    metadata: {
      id: sessionId,
      cwd: "/tmp",
      model: "test-model",
      createdAt: SESSION_CREATED_AT,
      updatedAt: SESSION_CREATED_AT,
      messageCount: messages.length,
    },
    branches: [],
    currentBranchId: "b1",
    revision: 1,
    createdAt: SESSION_CREATED_AT,
    updatedAt: SESSION_CREATED_AT,
    ownership: { rootSessionId: sessionId },
  }
}

/** 内存 stub：get/getMessages 从播种 map 读；未播种的 session → null（不存在）。 */
function stubManager(
  seeds: Record<string, SeedMessage[]> = {},
  overrides: Partial<SessionManagerV2> = {},
): SessionManagerV2 {
  const map = new Map(Object.entries(seeds))
  return {
    get: async (sessionId: string) => {
      const messages = map.get(sessionId)
      return messages ? (stateFor(sessionId, messages) as never) : null
    },
    getMessages: async (sessionId: string) => (map.get(sessionId) ?? []) as never,
    ...overrides,
  } as unknown as SessionManagerV2
}

describe("resolveHubConfig", () => {
  it("returns undefined when hub config is absent", () => {
    expect(resolveHubConfig(undefined)).toBeUndefined()
  })

  it("returns undefined when enabled is false", () => {
    expect(resolveHubConfig({ enabled: false })).toBeUndefined()
  })

  it("throws when enabled but baseUrl is missing", () => {
    expect(() => resolveHubConfig({ enabled: true, chatPushKey: "k" }))
      .toThrow("hub is enabled but baseUrl is not configured")
  })

  it("throws when enabled but chatPushKey is missing", () => {
    expect(() => resolveHubConfig({ enabled: true, baseUrl: "https://hub.example.com" }))
      .toThrow("hub is enabled but chatPushKey is not configured")
  })

  it("resolves and strips trailing slashes from baseUrl", () => {
    expect(resolveHubConfig({ enabled: true, baseUrl: "https://hub.example.com/", chatPushKey: "k" }))
      .toEqual({ baseUrl: "https://hub.example.com", chatPushKey: "k" })
  })

  it("passes deployment org through, omits when absent (#28)", () => {
    expect(resolveHubConfig({ enabled: true, baseUrl: "https://hub.example.com", chatPushKey: "k", org: "tenant-a" }))
      .toEqual({ baseUrl: "https://hub.example.com", chatPushKey: "k", org: "tenant-a" })
    expect(resolveHubConfig({ enabled: true, baseUrl: "https://hub.example.com", chatPushKey: "k" })?.org)
      .toBeUndefined()
  })
})

describe("buildSessionPayload", () => {
  const INPUT = { sessionId: "sess-1", agentId: "a", model: "m", identity: {} }

  it("returns null for a nonexistent session", async () => {
    expect(await buildSessionPayload(INPUT, stubManager())).toBeNull()
  })

  it("returns null when no session manager is configured (register()-only host)", async () => {
    expect(await buildSessionPayload(INPUT, undefined)).toBeNull()
  })

  it("builds a full session snapshot with segment-format content", async () => {
    const sessions = stubManager({
      "sess-1": [
        { role: "user", content: "帮我查一下天气", id: "m1" },
        {
          role: "assistant",
          id: "m2",
          content: [
            { type: "thinking", thinking: "用户在问天气" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "curl wttr.in", timeout: 30 } },
          ],
          rawUsage: { input_tokens: 100, output_tokens: 20 },
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "晴 25°C", is_error: false }], id: "m3" },
        { role: "assistant", content: [{ type: "text", text: "今天晴，25°C" }], id: "m4", rawUsage: { input_tokens: 150, output_tokens: 10 } },
      ],
    })

    const payload = await buildSessionPayload({
      sessionId: "sess-1", agentId: "weather-bot", model: "claude-sonnet-4-6",
      identity: { userName: "alice" },
    }, sessions, "acme")

    expect(payload).toMatchObject({
      id: "sess-1", title: "帮我查一下天气", model: "claude-sonnet-4-6",
      agent_id: "weather-bot", user_name: "alice", org: "acme",
    })
    expect(typeof payload!.created_at).toBe("string")
    expect(typeof payload!.updated_at).toBe("string")

    const msgs = payload!.messages as Array<Record<string, unknown>>
    expect(msgs).toHaveLength(4)

    // user 纯文本 → text segment
    expect(JSON.parse(msgs[0].content as string)).toEqual([{ type: "text", text: "帮我查一下天气" }])
    expect(msgs[0].token_usage).toBeUndefined()

    // thinking → reasoning；tool_use input 值全转 string
    const m2 = JSON.parse(msgs[1].content as string)
    expect(m2[0]).toEqual({ type: "reasoning", reasoning: "用户在问天气" })
    expect(m2[1]).toEqual({ type: "tool_use", name: "Bash", id: "t1", input: { cmd: "curl wttr.in", timeout: "30" } })
    expect(JSON.parse(msgs[1].token_usage as string)).toEqual({ total_input: 100, total_output: 20, total_tokens: 120 })

    // tool_result 透传
    expect(JSON.parse(msgs[2].content as string)).toEqual([
      { type: "tool_result", content: "晴 25°C", toolUseId: "t1", isError: false },
    ])
    expect(JSON.parse(msgs[3].content as string)).toEqual([{ type: "text", text: "今天晴，25°C" }])
  })

  it("assigns ids and omits identity fields when absent", async () => {
    const sessions = stubManager({
      "sess-1": [
        { role: "user", content: "hi" },
        { role: "assistant", content: [] },  // 空 content → 省略 content 字段
      ],
    })

    const payload = await buildSessionPayload(INPUT, sessions)
    expect(payload!.user_name).toBeUndefined()
    expect(payload!.org).toBeUndefined()
    const msgs = payload!.messages as Array<Record<string, unknown>>
    // v4 store 透传消息 id 不补写；无 id 消息走 index 兜底（<sessionId>:<index>）
    expect(msgs[0].id).toBe("sess-1:0")
    expect(msgs[1].id).toBe("sess-1:1")
    expect(msgs[1].content).toBeUndefined()
    // 每条 message 都有 created_at（session createdAt 兜底）
    expect(typeof msgs[0].created_at).toBe("string")
  })

  it("takes tenant only from the org parameter, ignoring smuggled identity.org (#28 regression)", async () => {
    const sessions = stubManager({ "sess-1": [{ role: "user", content: "hi" }] })
    // HubIdentity 已无 org 字段（类型边界封闭）；这里运行时走私一个遗留 org，
    // 证明 buildSessionPayload 只读独立参数、identity 不再是租户注入口
    const smuggled = { userName: "alice", org: "spoofed-tenant" } as never
    const payload = await buildSessionPayload(
      { sessionId: "sess-1", agentId: "a", model: "m", identity: smuggled },
      sessions,
      "tenant-a",
    )
    expect(payload!.org).toBe("tenant-a")

    // 参数缺省时：即使 identity 走私了 org，payload 也省略 org 字段
    const noOrg = await buildSessionPayload(
      { sessionId: "sess-1", agentId: "a", model: "m", identity: smuggled },
      sessions,
    )
    expect(noOrg!.org).toBeUndefined()
  })

  it("uses per-message timestamps when present, falls back to session createdAt", async () => {
    const sessions = stubManager({
      "sess-1": [
        { role: "user", content: "first", id: "t1", timestamp: "2026-08-28T10:00:00.000Z" },
        { role: "assistant", content: "second", id: "t2", timestamp: "2026-08-28T10:00:05.000Z" },
        { role: "user", content: "no timestamp", id: "t3" }, // 旧 transcript 风格 → 兜底
      ],
    })

    const payload = await buildSessionPayload(INPUT, sessions)
    const msgs = payload!.messages as Array<Record<string, unknown>>
    expect(msgs[0].created_at).toBe("2026-08-28T10:00:00.000Z")
    expect(msgs[1].created_at).toBe("2026-08-28T10:00:05.000Z")
    expect(msgs[2].created_at).toBe(payload!.created_at) // session createdAt 兜底
  })

  it("truncates title to 50 chars and omits title when no user message", async () => {
    const longTitle = await buildSessionPayload(
      INPUT,
      stubManager({ "sess-1": [{ role: "user", content: "x".repeat(80) }] }),
    )
    expect((longTitle!.title as string).length).toBe(50)

    const assistantOnly = await buildSessionPayload(
      INPUT,
      stubManager({ "sess-1": [{ role: "assistant", content: "hi" }] }),
    )
    expect(assistantOnly!.title).toBeUndefined()
  })
})

const PUSHER_SESSION = "hub-push-pusher-test-0001"

function makePusher(fetchImpl: ReturnType<typeof vi.fn>, sessions?: SessionManagerV2) {
  return new HubChatPusher(
    { baseUrl: "https://hub.example.com", chatPushKey: "secret-key" },
    fetchImpl as unknown as typeof fetch,
    sessions,
  )
}

/** 播种单会话的 stub manager（pusher 测试的默认数据）。 */
function seededPusherManager(id = PUSHER_SESSION): SessionManagerV2 {
  return stubManager({ [id]: [{ role: "user", content: "hello" }] })
}

describe("HubChatPusher", () => {
  it("POSTs the session snapshot with the push key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, synced_sessions: 1, skipped_sessions: 0, synced_messages: 1, conflicts: [] }), { status: 200 }),
    )
    await makePusher(fetchMock, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: { userName: "alice" } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://hub.example.com/api/v1/chat/push")
    expect((init.headers as Record<string, string>)["X-Chat-Push-Key"]).toBe("secret-key")
    const body = JSON.parse(init.body as string)
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0].id).toBe(PUSHER_SESSION)
    expect(body.sessions[0].user_name).toBe("alice")
    expect(body.sessions[0].org).toBeUndefined() // 无部署 org 配置时省略字段
  })

  it("fills org from deployment config regardless of request identity (#28)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, synced_sessions: 1 }), { status: 200 }),
    )
    const pusher = new HubChatPusher(
      { baseUrl: "https://hub.example.com", chatPushKey: "secret-key", org: "tenant-a" },
      fetchMock as unknown as typeof fetch,
      seededPusherManager(),
    )
    await pusher.pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: { userName: "alice" } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.sessions[0].org).toBe("tenant-a")
    expect(body.sessions[0].user_name).toBe("alice")
  })

  it("does nothing when the session does not exist, warns after retries (#30)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchMock = vi.fn()
      await makePusher(fetchMock, stubManager()).pushSession({ sessionId: "not-exists-9999", agentId: "a", model: "m", identity: {} })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        "[hub-push] session transcript not found, giving up",
        expect.objectContaining({ sessionId: "not-exists-9999" }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("does nothing when no session manager is configured (register()-only host)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchMock = vi.fn()
      await makePusher(fetchMock).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        "[hub-push] session transcript not found, giving up",
        expect.objectContaining({ sessionId: PUSHER_SESSION }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("retries transcript build until the file appears, then pushes (#30)", async () => {
    // 模拟 SSE 竞态：transcript 晚于 pushSession 启动 ~400ms 才可见
    const lateSession = "hub-push-late-transcript-0001"
    const map = new Map<string, SeedMessage[]>()
    setTimeout(() => {
      map.set(lateSession, [{ role: "user", content: "late" }])
    }, 400)
    const lateManager = stubManager(undefined, {
      get: (async (sessionId: string) => {
        const messages = map.get(sessionId)
        return messages ? (stateFor(sessionId, messages) as never) : null
      }) as never,
      getMessages: (async (sessionId: string) => (map.get(sessionId) ?? []) as never),
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, synced_sessions: 1 }), { status: 200 }),
    )
    await makePusher(fetchMock, lateManager).pushSession({ sessionId: lateSession, agentId: "a", model: "m", identity: { userName: "u" } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.sessions[0].id).toBe(lateSession)
  })

  it("warns on 200 with non-JSON body without retrying (#29)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("<html><body>index</body></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      )
      await makePusher(fetchMock, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
      expect(fetchMock).toHaveBeenCalledTimes(1) // 配置错误不重试
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [msg, detail] = warnSpy.mock.calls[0] as unknown as [string, { status: number; contentType: string; body: string }]
      expect(msg).toContain("unexpected 2xx response shape")
      expect(detail.status).toBe(200)
      expect(detail.contentType).toContain("text/html")
      expect(detail.body).toContain("<html>")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("warns on 200 with JSON missing the success field (#29)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ foo: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      await makePusher(fetchMock, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain("unexpected 2xx response shape")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("does not warn on a well-formed success response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, synced_sessions: 1, skipped_sessions: 0, conflicts: [] }), { status: 200 }),
      )
      await makePusher(fetchMock, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("retries on network error then succeeds; never rejects on exhaustion", async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      const p = makePusher(fetchMock, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
      // stub manager 无磁盘 I/O，payload 即时就绪；等首次 fetch 发出后再推进定时器
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await vi.runAllTimersAsync() // 推进 1s + 2s 退避
      await p
      expect(fetchMock).toHaveBeenCalledTimes(3)

      // 全部失败：promise 正常 resolve，不 reject
      const failMock = vi.fn().mockRejectedValue(new Error("down"))
      const p2 = makePusher(failMock, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
      await vi.waitFor(() => expect(failMock).toHaveBeenCalledTimes(1))
      await vi.runAllTimersAsync()
      await expect(p2).resolves.toBeUndefined()
      expect(failMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not retry on 4xx but retries on 5xx", async () => {
    const mock401 = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }))
    await makePusher(mock401, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
    expect(mock401).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      const mock500 = vi.fn().mockResolvedValue(new Response("oops", { status: 500 }))
      const p = makePusher(mock500, seededPusherManager()).pushSession({ sessionId: PUSHER_SESSION, agentId: "a", model: "m", identity: {} })
      await vi.waitFor(() => expect(mock500).toHaveBeenCalledTimes(1))
      await vi.runAllTimersAsync()
      await p
      expect(mock500).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
