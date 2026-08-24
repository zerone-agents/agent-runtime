import { afterEach, describe, expect, it } from "vitest"
import { buildSessionPayload, resolveHubConfig } from "../hub-push.js"

// buildSessionPayload 走 SDK 真实磁盘 transcript（~/.agents/sessions/<id>/），
// 测试用唯一 sessionId + saveSession 造数据，afterEach 用 deleteSession 清理。
import { deleteSession, saveSession } from "@zerone-agent/agent-sdk"

const TEST_SESSION = "hub-push-test-session-0001"
afterEach(async () => { await deleteSession(TEST_SESSION).catch(() => {}) })

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
})

describe("buildSessionPayload", () => {
  it("returns null for a nonexistent session", async () => {
    expect(await buildSessionPayload({
      sessionId: "definitely-not-exists-0000", agentId: "a", model: "m", identity: {},
    })).toBeNull()
  })

  it("builds a full session snapshot with segment-format content", async () => {
    await saveSession(TEST_SESSION, [
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
    ], { model: "test-model" })

    const payload = await buildSessionPayload({
      sessionId: TEST_SESSION, agentId: "weather-bot", model: "claude-sonnet-4-6",
      identity: { userName: "alice", org: "acme" },
    })

    expect(payload).toMatchObject({
      id: TEST_SESSION, title: "帮我查一下天气", model: "claude-sonnet-4-6",
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
    await saveSession(TEST_SESSION, [
      { role: "user", content: "hi" },
      { role: "assistant", content: [] },  // 空 content → 省略 content 字段
    ], { model: "m" })

    const payload = await buildSessionPayload({
      sessionId: TEST_SESSION, agentId: "a", model: "m", identity: {},
    })
    expect(payload!.user_name).toBeUndefined()
    expect(payload!.org).toBeUndefined()
    const msgs = payload!.messages as Array<Record<string, unknown>>
    // SDK 1.3.1 在 save/load 路径上会为无 id 消息补 UUID，这里断言 id 为非空字符串即可
    expect(typeof msgs[0].id).toBe("string")
    expect((msgs[0].id as string).length).toBeGreaterThan(0)
    expect(typeof msgs[1].id).toBe("string")
    expect((msgs[1].id as string).length).toBeGreaterThan(0)
    expect(msgs[1].content).toBeUndefined()
    // 每条 message 都有 created_at（session createdAt 兜底）
    expect(typeof msgs[0].created_at).toBe("string")
  })

  it("truncates title to 50 chars and omits title when no user message", async () => {
    await saveSession(TEST_SESSION, [
      { role: "user", content: "x".repeat(80) },
    ], { model: "m" })
    const p1 = await buildSessionPayload({ sessionId: TEST_SESSION, agentId: "a", model: "m", identity: {} })
    expect((p1!.title as string).length).toBe(50)

    await deleteSession(TEST_SESSION)
    await saveSession(TEST_SESSION, [{ role: "assistant", content: "hi" }], { model: "m" })
    const p2 = await buildSessionPayload({ sessionId: TEST_SESSION, agentId: "a", model: "m", identity: {} })
    expect(p2!.title).toBeUndefined()
  })
})
