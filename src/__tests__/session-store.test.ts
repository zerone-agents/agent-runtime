import { describe, it, expect } from "vitest"
import { InMemorySessionStore, WriteCoordinator } from "@zerone-agent/agent-sdk/store"
import { OwnershipRootPreRegisteringCoordinator } from "../session-store.js"

/**
 * agent-sdk#158 workaround 的行为钉用例。
 *
 * v4 register 协议：携带外部 ownership.rootSessionId 的写入（subagent
 * spawn 的预登记）要求该 root 已在 store 中注册，否则 ensureRow 的祖先
 * 检查抛 WriteNotAuthorizedError。SDK 的自注册发生在 engine 循环后的
 * 首次 checkpoint，且 prepareChildOwnership 注册的是 engine agentId
 * （'main'）而非 session id——mid-query spawn 必败。装饰器在此类写入前
 * 预注册该 root（自根归属）。
 *
 * 测试复刻真实 spawn 序列：prepareChildOwnership 先注册 'main'（带 root
 * 归属），runSubagent 再注册子会话（parentSessionId='main'）——两写都
 * 要求 root 先存在。
 */

describe("OwnershipRootPreRegisteringCoordinator (agent-sdk#158 workaround)", () => {
  it("pre-registers a foreign ownership root before the write (plain coordinator throws)", async () => {
    const rootSid = "root-session"

    // 对照：未包装的 coordinator——复现 SDK#158 失败形态。真实序列的第一写
    // （注册 'main'，ownership.rootSessionId 指向根会话）即要求 root 已存在。
    const plainStore = new InMemorySessionStore()
    const plain = new WriteCoordinator({ store: plainStore })
    await expect(
      plain.execute("main", { kind: "register", ownership: { rootSessionId: rootSid } }),
    ).rejects.toThrow(/ownership target .* is not registered or deleted/)

    // 包装后：root 先被注册，'main' 与子会话的注册都成功
    const store = new InMemorySessionStore()
    const coordinator = new OwnershipRootPreRegisteringCoordinator({ store })
    await coordinator.execute("main", { kind: "register", ownership: { rootSessionId: rootSid } })
    await coordinator.execute("child-session", {
      kind: "register",
      ownership: { rootSessionId: rootSid, parentSessionId: "main" },
    })

    const rootState = await store.loadSession(rootSid)
    expect(rootState).not.toBeNull()
    expect(rootState!.ownership).toEqual({ rootSessionId: rootSid })
    const childState = await store.loadSession("child-session")
    expect(childState).not.toBeNull()
    expect(childState!.ownership.parentSessionId).toBe("main")
  })

  it("is idempotent: repeated same-ownership writes do not throw or duplicate", async () => {
    const rootSid = "root-session"
    const store = new InMemorySessionStore()
    const coordinator = new OwnershipRootPreRegisteringCoordinator({ store })

    for (let i = 0; i < 3; i++) {
      await coordinator.execute("main", { kind: "register", ownership: { rootSessionId: rootSid } })
      await coordinator.execute("child-session", {
        kind: "register",
        ownership: { rootSessionId: rootSid, parentSessionId: "main" },
      })
    }
    const rootState = await store.loadSession(rootSid)
    expect(rootState).not.toBeNull()
    expect(rootState!.revision).toBe(0) // register 不推进 revision
  })

  it("does not pre-register for self-root or ownership-free intents", async () => {
    const store = new InMemorySessionStore()
    const coordinator = new OwnershipRootPreRegisteringCoordinator({ store })

    // 自根 register：root === sessionId，无外部 root 需要预注册
    await coordinator.execute("solo", { kind: "register", ownership: { rootSessionId: "solo" } })
    const solo = await store.loadSession("solo")
    expect(solo).not.toBeNull()
    expect(solo!.ownership).toEqual({ rootSessionId: "solo" })

    // 无 ownership 的 intent（如 save-todos 缺省形状）不受影响、不抛错
    await expect(
      coordinator.execute("solo", { kind: "save-todos", todos: [] }),
    ).resolves.toBeDefined()
    // 未预注册任何其他 session
    expect(await store.loadSession("other")).toBeNull()
  })
})
