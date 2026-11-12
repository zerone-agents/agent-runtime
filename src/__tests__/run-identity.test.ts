import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import {
  USER_ID_HEADER,
  RUN_ID_HEADER,
  runWithIdentity,
  getCurrentRunIdentity,
  generatorWithIdentity,
  identityHeaderProvider,
  SessionIdentityStore,
} from "../run-identity.js"
import { createAgentRouter } from "../router/agent.js"
import { RunRegistry } from "../runs.js"

/**
 * issue #95（会话级身份透传）的行为钉用例。
 *
 * 单元层：identityHeaderProvider（ALS 内外、静态头合并、无身份降级、并发
 * 不串号）、SessionIdentityStore（绑定/查找/清除/重启存续/损坏容忍）、
 * generatorWithIdentity（事件流通 + 生成体内可读身份）。
 * 路由层：run 入站 X-User-Id 绑定会话、无头回退既有绑定、register-only
 * 宿主（无 store）降级。MCP 出站接线（provider 注入到连接配置）在
 * mcp-connections.test.ts 钉；DELETE 身份级联在 router-session.test.ts 钉。
 */

describe("identityHeaderProvider", () => {
  const STATIC = { "X-Agent-Capability": "cap-1" }

  it("injects X-User-Id + X-Run-Id over static headers inside a run context", () => {
    const provider = identityHeaderProvider(STATIC)
    const headers = runWithIdentity({ runId: "r-1", sessionId: "s-1", userId: "u-9" }, () => provider())
    expect(headers).toEqual({
      "X-Agent-Capability": "cap-1",
      [USER_ID_HEADER]: "u-9",
      [RUN_ID_HEADER]: "r-1",
    })
  })

  it("returns static headers only outside a run (cron / background / pre-start)", () => {
    const provider = identityHeaderProvider(STATIC)
    expect(provider()).toEqual({ "X-Agent-Capability": "cap-1" })
  })

  it("returns static headers only when the run context has no userId (acceptance 2)", () => {
    const provider = identityHeaderProvider(STATIC)
    // 会话无绑定且本次未带头 → 无身份头（hub 侧按 agent 模式降级）
    const headers = runWithIdentity({ runId: "r-2", sessionId: "s-2" }, () => provider())
    expect(headers).toEqual({ "X-Agent-Capability": "cap-1" })
  })

  it("works with no static headers at all", () => {
    const provider = identityHeaderProvider(undefined)
    expect(runWithIdentity({ runId: "r", sessionId: "s", userId: "u" }, () => provider())).toEqual({
      [USER_ID_HEADER]: "u",
      [RUN_ID_HEADER]: "r",
    })
    expect(provider()).toEqual({})
  })

  it("concurrent sessions on one shared provider never cross-contaminate (acceptance 1)", () => {
    const provider = identityHeaderProvider(STATIC)
    // 同一 provider（= 同一共享 MCP 连接）在两个会话的上下文中交替调用
    const alice = runWithIdentity({ runId: "r-a", sessionId: "s-a", userId: "alice" }, () => provider())
    const bob = runWithIdentity({ runId: "r-b", sessionId: "s-b", userId: "bob" }, () => provider())
    expect(alice[USER_ID_HEADER]).toBe("alice")
    expect(alice[RUN_ID_HEADER]).toBe("r-a")
    expect(bob[USER_ID_HEADER]).toBe("bob")
    expect(bob[RUN_ID_HEADER]).toBe("r-b")
    // 上下文退出后再调用 → 无身份（会话结束/切换后身份不残留的 ALS 面）
    expect(provider()[USER_ID_HEADER]).toBeUndefined()
  })
})

describe("SessionIdentityStore", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "identity-store-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("bind / get roundtrip; missing → undefined; rebind updates", async () => {
    const store = new SessionIdentityStore(dir)
    await store.bind("s-1", "user-a")
    expect((await store.get("s-1"))?.userId).toBe("user-a")
    expect(typeof (await store.get("s-1"))?.boundAt).toBe("string")
    expect(await store.get("s-missing")).toBeUndefined()
    await store.bind("s-1", "user-b")
    expect((await store.get("s-1"))?.userId).toBe("user-b")
  })

  it("clear removes the binding (session DELETE cascade)", async () => {
    const store = new SessionIdentityStore(dir)
    await store.bind("s-1", "user-a")
    await store.clear("s-1")
    expect(await store.get("s-1")).toBeUndefined()
  })

  it("persists across instances (restart: identity survives the session lifecycle)", async () => {
    const first = new SessionIdentityStore(dir)
    await first.bind("s-1", "user-a")
    // 新实例 = 进程重启后的重建（读同一文件）
    const second = new SessionIdentityStore(dir)
    expect((await second.get("s-1"))?.userId).toBe("user-a")
  })

  it("tolerates a corrupt file: empty table, next bind overwrites", async () => {
    writeFileSync(join(dir, "session-identity.json"), "{ corrupt!", "utf8")
    const store = new SessionIdentityStore(dir)
    expect(await store.get("s-1")).toBeUndefined()
    await store.bind("s-1", "user-a")
    expect((await new SessionIdentityStore(dir).get("s-1"))?.userId).toBe("user-a")
  })

  it("file lives next to sessions.json in the given dir (sid-keyed shape)", async () => {
    const store = new SessionIdentityStore(dir)
    await store.bind("s-1", "u")
    // 直接验证落盘形状（绑定表以 sessionId 为键）
    const { readFile } = await import("node:fs/promises")
    const parsed = JSON.parse(await readFile(join(dir, "session-identity.json"), "utf-8")) as Record<string, { userId: string }>
    expect(parsed["s-1"].userId).toBe("u")
  })
})

describe("generatorWithIdentity", () => {
  it("events flow through the wrapper AND the generator body reads the identity", async () => {
    async function* gen() {
      yield getCurrentRunIdentity()?.runId ?? "none"
      yield getCurrentRunIdentity()?.userId ?? "none"
    }
    const wrapped = generatorWithIdentity({ runId: "r-1", sessionId: "s-1", userId: "u-1" }, gen())
    const out: string[] = []
    for await (const v of wrapped) out.push(v as string)
    expect(out).toEqual(["r-1", "u-1"])
  })

  it("early break exits cleanly (return path re-enters the context, no hang)", async () => {
    async function* gen() {
      yield 1
      yield 2
    }
    const wrapped = generatorWithIdentity({ runId: "r", sessionId: "s" }, gen())
    const seen: number[] = []
    for await (const v of wrapped) {
      seen.push(v as number)
      break
    }
    expect(seen).toEqual([1])
  })
})

describe("run handler identity binding (router level)", () => {
  function makeAgent() {
    return {
      prompt: vi.fn(async () => ({
        text: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
        num_turns: 1,
        duration_ms: 1,
        messages: [],
      })),
      query: vi.fn(),
      close: vi.fn(async () => {}),
      getSessionId: () => "sess-bound-1",
    }
  }

  function makeApp(identityStore: unknown) {
    const agent = makeAgent()
    const registry = {
      list: vi.fn(),
      create: vi.fn().mockReturnValue(agent),
      getStatus: vi.fn().mockReturnValue("ready"),
      getModel: vi.fn().mockReturnValue("test-model"),
      getSessionIdentityStore: vi.fn(() => identityStore),
    }
    const app = new Hono()
    app.route("/v1/agents", createAgentRouter(registry as never, new RunRegistry(), { recordRun: vi.fn() } as never))
    return { app, agent }
  }

  function postRun(app: Hono, headers: Record<string, string>) {
    return app.request("/v1/agents/a/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify({ message: "hi" }),
    })
  }

  it("X-User-Id header binds the session identity (first arrival)", async () => {
    const store = { bind: vi.fn(async () => {}), get: vi.fn(async () => undefined), clear: vi.fn(async () => {}) }
    const { app } = makeApp(store)
    const res = await postRun(app, { [USER_ID_HEADER]: "user-42" })
    expect(res.status).toBe(200)
    expect(store.bind).toHaveBeenCalledWith("sess-bound-1", "user-42")
    // 带头时不查既有绑定（bind 即更新）
    expect(store.get).not.toHaveBeenCalled()
  })

  it("no header falls back to the session's existing binding (lifecycle persistence)", async () => {
    const store = { bind: vi.fn(async () => {}), get: vi.fn(async () => ({ userId: "user-old", boundAt: "t" })), clear: vi.fn(async () => {}) }
    const { app } = makeApp(store)
    const res = await postRun(app, {})
    expect(res.status).toBe(200)
    expect(store.get).toHaveBeenCalledWith("sess-bound-1")
    expect(store.bind).not.toHaveBeenCalled()
  })

  it("X-User-Name-only run: identity lookup happens, bind does not (acceptance 2)", async () => {
    const store = { bind: vi.fn(async () => {}), get: vi.fn(async () => undefined), clear: vi.fn(async () => {}) }
    const { app } = makeApp(store)
    const res = await postRun(app, { "X-User-Name": "alice" })
    expect(res.status).toBe(200)
    expect(store.get).toHaveBeenCalledWith("sess-bound-1")
    expect(store.bind).not.toHaveBeenCalled()
  })

  it("register-only host (no identity store) degrades gracefully: in-run identity only", async () => {
    const { app } = makeApp(undefined)
    const res = await postRun(app, { [USER_ID_HEADER]: "user-x" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.text).toBe("ok")
  })

  it("bind persistence failure degrades to in-run identity (run is NOT failed)", async () => {
    const store = {
      bind: vi.fn(async () => { throw new Error("disk full") }),
      get: vi.fn(async () => undefined),
      clear: vi.fn(async () => {}),
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { app } = makeApp(store)
      const res = await postRun(app, { [USER_ID_HEADER]: "user-x" })
      expect(res.status).toBe(200)
      expect(warnSpy).toHaveBeenCalledWith(
        "[identity] session identity bind failed; degrading to in-run identity only",
        expect.objectContaining({ sessionId: "sess-bound-1" }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
