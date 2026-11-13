import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { AgentRegistry } from "../registry.js"
import {
  USER_ID_HEADER,
  RUN_ID_HEADER,
  USER_ID_MAX_LENGTH,
  invalidUserIdReason,
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

  it("concurrent first-load: all gets see the stored data (no load-window miss)", async () => {
    // 评审重要 1 回归钉：旧实现的 loaded 标志在读盘前置位——并发的第二个
    // get 在读盘完成前读到空表，该次 MCP 请求漏注身份。
    const first = new SessionIdentityStore(dir)
    await first.bind("s-1", "user-a")
    const second = new SessionIdentityStore(dir)
    const [a, b] = await Promise.all([second.get("s-1"), second.get("s-1")])
    expect(a?.userId).toBe("user-a")
    expect(b?.userId).toBe("user-a")
  })

  it("concurrent bind during first-load is not clobbered by stale disk values", async () => {
    // 评审重要 1 回归钉：旧实现 bind 立即写入，首载完成的磁盘旧值会 set 回
    // 同一 sid（重绑丢失）。修复后 bind 等待共享 loadPromise 再写入。
    const first = new SessionIdentityStore(dir)
    await first.bind("s-1", "user-old")
    const second = new SessionIdentityStore(dir)
    await Promise.all([second.get("s-1"), second.bind("s-1", "user-new")])
    expect((await second.get("s-1"))?.userId).toBe("user-new")
    // 落盘亦为新值（重绑未被磁盘旧值覆盖）
    expect((await new SessionIdentityStore(dir).get("s-1"))?.userId).toBe("user-new")
  })

  it("prune removes only disk-inherited entries without a live session and persists (cold-start sweep)", async () => {
    // 评审建议 6：DELETE best-effort 失败/存量数据的孤儿条目清扫——
    // 磁盘遗留条目（上一进程）按 live 集判定。
    writeFileSync(
      join(dir, "session-identity.json"),
      JSON.stringify({
        "s-live": { userId: "u-live", boundAt: "t" },
        "s-orphan": { userId: "u-orphan", boundAt: "t" },
      }),
      "utf8",
    )
    const store = new SessionIdentityStore(dir)
    const removed = await store.prune(new Set(["s-live"]))
    expect(removed).toBe(1)
    expect((await store.get("s-live"))?.userId).toBe("u-live")
    expect(await store.get("s-orphan")).toBeUndefined()
    // 持久化：新实例（重启模拟）只看到 live 条目
    const reloaded = new SessionIdentityStore(dir)
    expect((await reloaded.get("s-live"))?.userId).toBe("u-live")
    expect(await reloaded.get("s-orphan")).toBeUndefined()
  })

  it("prune protects entries bound in THIS process (session row not yet checkpointed — e2e-proven race)", async () => {
    // 竞态回归钉：绑定发生在 run 开始，session 行要到 run 结束（首个
    // checkpoint）才落盘——无保护的热清扫会把「行未落」当孤儿，抹掉刚
    // 绑定的身份（e2e 场景 3 实证：冷启动清扫的 list 快照在首个 run 的
    // bind 与 checkpoint 之间解析为空集）。
    const store = new SessionIdentityStore(dir)
    await store.bind("s-fresh", "u-fresh")
    const removed = await store.prune(new Set()) // 无任何 live 会话
    expect(removed).toBe(0)
    expect((await store.get("s-fresh"))?.userId).toBe("u-fresh")
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

describe("invalidUserIdReason (评审建议 1: 入站身份头校验)", () => {
  it("rejects empty / whitespace / trimmed-mismatch / overlong / control chars", () => {
    expect(invalidUserIdReason("")).toContain("non-empty")
    expect(invalidUserIdReason("   ")).toContain("non-empty")
    expect(invalidUserIdReason(" user-1")).toContain("whitespace")
    expect(invalidUserIdReason("user-1 ")).toContain("whitespace")
    expect(invalidUserIdReason("u".repeat(USER_ID_MAX_LENGTH + 1))).toContain("exceeds")
    expect(invalidUserIdReason("user-\u0007-1")).toContain("control")
    expect(invalidUserIdReason("user\r\n-1")).toContain("control")
  })

  it("accepts normal and unicode identifiers at the boundary length", () => {
    expect(invalidUserIdReason("user-42")).toBeUndefined()
    expect(invalidUserIdReason("用户-42")).toBeUndefined()
    expect(invalidUserIdReason("u".repeat(USER_ID_MAX_LENGTH))).toBeUndefined()
  })
})

describe("run handler identity binding (router level)", () => {
  /** prompt 执行期间的捕获：run ALS 上下文 + 真实 provider 的输出头（评审重要 3：
   * 证明 caller 的 runId 真正进入 run 上下文并到达 provider 输出）。 */
  interface RunCapture {
    ctx?: ReturnType<typeof getCurrentRunIdentity>
    providerHeaders?: Record<string, string>
  }

  function makeAgent(capture: RunCapture) {
    return {
      prompt: vi.fn(async () => {
        // prompt 经 runWithIdentity 包裹执行——此处即 run 的 ALS 上下文内。
        // 在该上下文里调用「真实」identityHeaderProvider：输出头即 MCP 请求
        // 头的内容（MCP 接线测试钉 provider 进连接配置；SDK 传输层按请求
        // 解析由上游 agent-sdk#164 钉）。
        capture.ctx = getCurrentRunIdentity()
        capture.providerHeaders = identityHeaderProvider({ "X-Agent-Capability": "cap-1" })()
        return {
          text: "ok",
          usage: { input_tokens: 1, output_tokens: 1 },
          num_turns: 1,
          duration_ms: 1,
          messages: [],
        }
      }),
      query: vi.fn(),
      close: vi.fn(async () => {}),
      getSessionId: () => "sess-bound-1",
    }
  }

  function makeApp(identityStore: unknown, capture: RunCapture) {
    const agent = makeAgent(capture)
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

  it("rejects malformed X-User-Id with 400 before agent creation (garbage identity never bound)", async () => {
    const store = { bind: vi.fn(async () => {}), get: vi.fn(async () => undefined), clear: vi.fn(async () => {}) }
    const { app } = makeApp(store, {})
    // 解析器安全的畸形值：空串 / 纯空白（HTTP/fetch 层规整后归空值路径）/
    // 超长。控制字符路径由 invalidUserIdReason 单测覆盖（CR/LF 另有 SDK
    // header 物化层兜底）。
    for (const value of ["", "   ", "u".repeat(USER_ID_MAX_LENGTH + 1)]) {
      const res = await postRun(app, { [USER_ID_HEADER]: value })
      expect(res.status, `value=${JSON.stringify(value)}`).toBe(400)
      const body = await res.json()
      expect((body as { error: string }).error).toContain(USER_ID_HEADER)
    }
    expect(store.bind).not.toHaveBeenCalled()
  })

  it("X-User-Id header binds the session identity; runId reaches the run context AND the provider output (评审重要 3)", async () => {
    const store = { bind: vi.fn(async () => {}), get: vi.fn(async () => undefined), clear: vi.fn(async () => {}) }
    const capture: RunCapture = {}
    const { app } = makeApp(store, capture)
    const res = await postRun(app, { [USER_ID_HEADER]: "user-42" })
    expect(res.status).toBe(200)
    expect(store.bind).toHaveBeenCalledWith("sess-bound-1", "user-42")
    // 带头时不查既有绑定（bind 即更新）
    expect(store.get).not.toHaveBeenCalled()

    // 评审重要 3：caller 的 runId 真正进入 run 上下文（ALS）并到达 provider
    // 的输出头——与响应头 X-Run-ID 精确相等（registry 生成的同一 runId）。
    expect(capture.ctx).toBeDefined()
    expect(capture.ctx!.userId).toBe("user-42")
    expect(capture.ctx!.sessionId).toBe("sess-bound-1")
    expect(capture.providerHeaders).toEqual({
      "X-Agent-Capability": "cap-1",
      [USER_ID_HEADER]: "user-42",
      [RUN_ID_HEADER]: res.headers.get("X-Run-ID"),
    })
    // run 结束后上下文退出：run 之外调用 provider → 仅静态头（无身份残留）
    expect(identityHeaderProvider({ "X-Agent-Capability": "cap-1" })()).toEqual({
      "X-Agent-Capability": "cap-1",
    })
  })

  it("no header falls back to the session's existing binding — restored identity reaches the run context (评审重要 4)", async () => {
    const store = { bind: vi.fn(async () => {}), get: vi.fn(async () => ({ userId: "user-old", boundAt: "t" })), clear: vi.fn(async () => {}) }
    const capture: RunCapture = {}
    const { app } = makeApp(store, capture)
    const res = await postRun(app, {})
    expect(res.status).toBe(200)
    expect(store.get).toHaveBeenCalledWith("sess-bound-1")
    expect(store.bind).not.toHaveBeenCalled()
    // 语义钉死（需求 2「随会话生命周期存续」优先于验收 2 字面）：已绑定会话
    // 无头 run 恢复既有身份——上下文与 provider 输出均携带 user-old。
    expect(capture.ctx?.userId).toBe("user-old")
    expect(capture.providerHeaders?.[USER_ID_HEADER]).toBe("user-old")
  })

  it("X-User-Name-only run on an UNBOUND session: no identity in context or provider output (acceptance 2 literal)", async () => {
    const store = { bind: vi.fn(async () => {}), get: vi.fn(async () => undefined), clear: vi.fn(async () => {}) }
    const capture: RunCapture = {}
    const { app } = makeApp(store, capture)
    const res = await postRun(app, { "X-User-Name": "alice" })
    expect(res.status).toBe(200)
    expect(store.get).toHaveBeenCalledWith("sess-bound-1")
    expect(store.bind).not.toHaveBeenCalled()
    // 验收 2 字面钉（未绑定会话）：上下文无 userId，provider 输出仅静态头
    expect(capture.ctx?.userId).toBeUndefined()
    expect(capture.providerHeaders).toEqual({ "X-Agent-Capability": "cap-1" })
  })

  it("register-only host (no identity store) degrades gracefully: in-run identity only", async () => {
    const { app } = makeApp(undefined, {})
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
      const { app } = makeApp(store, {})
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

describe("registry cold-start orphan sweep (issue #95 评审建议 6)", () => {
  const MINIMAL_CONFIG = {
    server: { host: "127.0.0.1", port: 3000 },
    agents: [{ id: "a", description: "d", model: "m", maxTurns: 5 }],
  }

  it("first load prunes pre-seeded orphaned sidecar entries (fire-and-forget)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "identity-sweep-cfg-"))
    try {
      // 预置孤儿 sidecar（会话不存在——DELETE best-effort 失败残留/存量数据）
      const sessionsDir = join(configDir, ".zerone", "sessions")
      mkdirSync(sessionsDir, { recursive: true })
      writeFileSync(
        join(sessionsDir, "session-identity.json"),
        JSON.stringify({
          "orphan-1": { userId: "u-1", boundAt: "t" },
          "orphan-2": { userId: "u-2", boundAt: "t" },
        }),
        "utf8",
      )

      const registry = new AgentRegistry()
      await registry.loadFromConfig(MINIMAL_CONFIG, configDir)

      // fire-and-forget：waitFor 清扫落地（冷启动空会话集 → 两条均为孤儿）
      await vi.waitFor(async () => {
        const store = new SessionIdentityStore(sessionsDir)
        expect(await store.get("orphan-1")).toBeUndefined()
        expect(await store.get("orphan-2")).toBeUndefined()
      })
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("pruneOrphanIdentities is directly callable and best-effort", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "identity-sweep2-cfg-"))
    try {
      // 磁盘遗留孤儿（上一进程）——本进程 bind 的条目受保护不清扫
      const sessionsDir = join(configDir, ".zerone", "sessions")
      mkdirSync(sessionsDir, { recursive: true })
      writeFileSync(
        join(sessionsDir, "session-identity.json"),
        JSON.stringify({ "orphan-x": { userId: "u", boundAt: "t" } }),
        "utf8",
      )
      const registry = new AgentRegistry()
      await registry.loadFromConfig(MINIMAL_CONFIG, configDir)
      const identityStore = registry.getSessionIdentityStore()!
      // 空会话集（无任何 session 行）→ 磁盘遗留孤儿被清（auto-prune 或直调，幂等）
      await registry.pruneOrphanIdentities()
      expect(await identityStore.get("orphan-x")).toBeUndefined()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
