import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { runLegacyImport, legacyTranscriptReader, legacyTodosReader } from "../legacy-import.js"
import { createSessionInfrastructure } from "../session-store.js"
import { createSessionRouter } from "../router/session.js"
import { rmRetryAsync } from "./helpers/fs.js"
import { runCli, CLI_EXIT } from "../cli.js"
import type { RuntimeConfig } from "../config.js"

/**
 * issue #88：一次性 v3 会话档案导入（opt-in CLI）的行为钉用例。
 *
 * 覆盖：正常导入（metadata 保真 + 消息 id 补写）、幂等重跑、源目录预检
 * （不存在/非目录显式失败——不与真实空目录混淆）、杂项条目跳过
 * （`.DS_Store` 等不翻转退出码）、损坏档案降级（零副作用）、todos 语义、
 * 导入会话对 GET /v1/sessions 可见（hub#227 兼容——自根 ownership）、
 * CLI 表面（USAGE/ERROR/OK 退出码、人类可读输出、--json 报告形状）。
 *
 * 三态编排语义来自 SDK importLegacySession（issue #131 P3 T7）——本文件钉
 * runtime 侧接线：读取器绑定 --from、目录过滤、源预检、目标为当前配置的
 * v4 store。
 */

function makeConfig(): RuntimeConfig {
  return {
    server: { host: "127.0.0.1", port: 3000 },
    agents: [{ id: "a", description: "test agent", model: "m", maxTurns: 5 }],
  }
}

const AGENTS_YAML = "agents:\n  - id: assistant\n    description: Fixture agent for CLI tests\n"

/** CLI 走 findConfigDir + discoverConfig——目标目录须有可发现的 agents.yaml。 */
function seedConfigDir(dir: string) {
  writeFileSync(join(dir, "agents.yaml"), AGENTS_YAML, "utf8")
}

/** v3 档案 fixture：<from>/<sid>/transcript.json（+ 可选 todos.json）。 */
function seedLegacySession(
  from: string,
  sessionId: string,
  opts: { messages?: Array<Record<string, unknown>>; metadataOverride?: Record<string, unknown>; raw?: string; todos?: unknown; todosRaw?: string } = {},
) {
  const dir = join(from, sessionId)
  mkdirSync(dir, { recursive: true })
  if (opts.raw !== undefined) {
    writeFileSync(join(dir, "transcript.json"), opts.raw, "utf8")
  } else {
    const data = {
      metadata: {
        id: sessionId,
        cwd: "/workspace",
        model: "claude-sonnet-4-6",
        provider: "anthropic-messages",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        messageCount: opts.messages?.length ?? 0,
        ...opts.metadataOverride,
      },
      messages: opts.messages ?? [
        { role: "user", content: "hi", id: "m1", timestamp: "2026-01-01T00:00:01.000Z" },
        { role: "assistant", content: "hello", id: "m2", rawUsage: { input_tokens: 1, output_tokens: 2 } },
      ],
    }
    writeFileSync(join(dir, "transcript.json"), JSON.stringify(data), "utf8")
  }
  if (opts.todosRaw !== undefined) writeFileSync(join(dir, "todos.json"), opts.todosRaw, "utf8")
  else if (opts.todos !== undefined) writeFileSync(join(dir, "todos.json"), JSON.stringify({ todos: opts.todos }), "utf8")
}

/** 在同一落点上另起读穿实例，验证导入产物（FileSessionStore read-through）。 */
function readerManager(configDir: string) {
  return createSessionInfrastructure(join(configDir, ".zerone", "sessions")).manager
}

describe("runLegacyImport (issue #88, opt-in one-time v3 migration)", () => {
  let from: string
  let configDir: string

  beforeAll(() => {
    from = mkdtempSync(join(tmpdir(), "legacy-from-"))
    configDir = mkdtempSync(join(tmpdir(), "legacy-cfg-"))
  })

  afterAll(async () => {
    await rmRetryAsync(from)
    await rmRetryAsync(configDir)
  })

  it("imports a v3 archive into the config's v4 store with metadata fidelity", async () => {
    seedLegacySession(from, "sess-normal")
    const { targetDir, report } = await runLegacyImport({ from, config: makeConfig(), configDir })

    expect(targetDir).toBe(join(configDir, ".zerone", "sessions"))
    expect(report.imported).toBe(1)
    expect(report.alreadyExistsUnknown).toBe(0)
    expect(report.notImported).toBe(0)
    const item = report.reports[0]!
    expect(item.status).toBe("imported")
    if (item.status === "imported") {
      expect(item.messageCount).toBe(2)
      expect(item.operationId).toBeTruthy()
    }

    // 读回验证：session 行存在、消息可取、v3 metadata 可映射字段保真
    //（cwd/model——v4 原生写入恒空的字段，导入路径反而保留）。
    const manager = readerManager(configDir)
    const state = await manager.get("sess-normal")
    expect(state).not.toBeNull()
    expect(state!.metadata.cwd).toBe("/workspace")
    expect(state!.metadata.model).toBe("claude-sonnet-4-6")
    const messages = await manager.getMessages("sess-normal")
    expect(messages).toHaveLength(2)
    expect(messages[0]!.id).toBe("m1")
  })

  it("is idempotent: re-running skips already-imported sessions (already-exists)", async () => {
    const { report } = await runLegacyImport({ from, config: makeConfig(), configDir })
    expect(report.imported).toBe(0)
    expect(report.alreadyExistsUnknown).toBe(1)
    expect(report.notImported).toBe(0)
    // 数据未被破坏
    const messages = await readerManager(configDir).getMessages("sess-normal")
    expect(messages).toHaveLength(2)
  })

  it("backfills missing message ids (import dedups by id — drops would be silent)", async () => {
    seedLegacySession(from, "sess-no-ids", {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    })
    const { report } = await runLegacyImport({ from, config: makeConfig(), configDir })
    expect(report.imported).toBe(1)
    const messages = await readerManager(configDir).getMessages("sess-no-ids")
    expect(messages).toHaveLength(2) // 无 id 消息经读取器补 UUID，未丢失
    for (const m of messages) expect(typeof m.id).toBe("string")
  })

  it("degrades corrupt archives without affecting healthy sessions", async () => {
    seedLegacySession(from, "sess-good")
    seedLegacySession(from, "sess-malformed", { raw: "{ not json" })
    seedLegacySession(from, "sess-id-mismatch", { metadataOverride: { id: "other-id" } })

    const { report } = await runLegacyImport({ from, config: makeConfig(), configDir })
    expect(report.imported).toBe(1) // 只有 sess-good
    expect(report.notImported).toBe(2)
    const reasons = Object.fromEntries(
      report.reports.filter((r) => r.status === "not-imported").map((r) => [r.sessionId, (r as { reason: string }).reason]),
    )
    expect(reasons["sess-malformed"]).toMatch(/legacy archive read failed/)
    expect(reasons["sess-id-mismatch"]).toMatch(/metadata.id mismatch/)
    // 零副作用：坏档案未在目标 store 落任何行
    expect(await readerManager(configDir).get("sess-malformed")).toBeNull()
    expect(await readerManager(configDir).get("sess-id-mismatch")).toBeNull()
  })

  it("imports valid todos alongside; malformed todos block that session with zero side effects", async () => {
    seedLegacySession(from, "sess-todos", { todos: [{ content: "task-1", status: "pending" }] })
    seedLegacySession(from, "sess-bad-todos", { todosRaw: '{"todos": "not-an-array"}' })

    // 共享 from 目录：此前的损坏档案（sess-malformed / sess-id-mismatch）在每次
    // 重跑中持续报 not-imported——与本次新种的两项合并计数。
    const { report } = await runLegacyImport({ from, config: makeConfig(), configDir })
    expect(report.imported).toBe(1)
    expect(report.notImported).toBe(3) // bad-todos + 此前两个永久损坏档案
    const blocked = report.reports.find((r) => r.sessionId === "sess-bad-todos")
    expect(blocked).toBeDefined()
    expect((blocked as { reason: string }).reason).toMatch(/todos/)

    // todos 随导入落库
    const todos = await readerManager(configDir).getTodos("sess-todos")
    expect(todos).toHaveLength(1)
    expect((todos[0] as { content?: string }).content).toBe("task-1")
    // 被阻断项零提交（修复档案后重跑即可恢复）
    expect(await readerManager(configDir).get("sess-bad-todos")).toBeNull()
  })

  it("tolerates an empty source directory (zero reports — nothing to import)", async () => {
    const emptyFrom = mkdtempSync(join(tmpdir(), "legacy-empty-"))
    try {
      const { report } = await runLegacyImport({ from: emptyFrom, config: makeConfig(), configDir })
      expect(report.reports).toEqual([])
      expect(report.imported).toBe(0)
    } finally {
      rmSync(emptyFrom, { recursive: true, force: true })
    }
  })

  it("rejects a nonexistent source directory explicitly (no silent zero report)", async () => {
    // 评审阻塞 1：SDK importLegacyArchive 对 readdir 失败静默返回全零报告——
    // runtime 侧循环必须显式失败，与真实空目录区分。
    const missing = join(tmpdir(), "legacy-missing-does-not-exist")
    await expect(
      runLegacyImport({ from: missing, config: makeConfig(), configDir }),
    ).rejects.toThrow(/ENOENT|no such file/)
  })

  it("skips non-directory entries (e.g. .DS_Store) — they must not flip the exit code", async () => {
    const miscFrom = mkdtempSync(join(tmpdir(), "legacy-misc-"))
    const miscCfg = mkdtempSync(join(tmpdir(), "legacy-misc-cfg-"))
    try {
      seedLegacySession(miscFrom, "sess-real")
      // 杂项条目：文件而非目录——v3 目录里的 .DS_Store / README 之类
      writeFileSync(join(miscFrom, ".DS_Store"), "garbage", "utf8")
      writeFileSync(join(miscFrom, "README.md"), "# notes", "utf8")

      const { report } = await runLegacyImport({ from: miscFrom, config: makeConfig(), configDir: miscCfg })
      expect(report.imported).toBe(1)
      expect(report.notImported).toBe(0) // 杂项未进入报告——不翻转退出码
      expect(report.reports.map((r) => r.sessionId)).toEqual(["sess-real"])
      expect(await readerManager(miscCfg).get("sess-real")).not.toBeNull()
    } finally {
      await rmRetryAsync(miscFrom)
      await rmRetryAsync(miscCfg)
    }
  })

  it("imported sessions are visible through GET /v1/sessions (hub#227 compatibility)", async () => {
    // 导入行 ownership 为自根——经 session router 的 isUserSession 过滤后
    // 出现在用户会话列表（存量视图兼容，hub#227 的部署前提）。
    const routeFrom = mkdtempSync(join(tmpdir(), "legacy-route-from-"))
    const routeCfg = mkdtempSync(join(tmpdir(), "legacy-route-cfg-"))
    try {
      seedLegacySession(routeFrom, "sess-visible")
      await runLegacyImport({ from: routeFrom, config: makeConfig(), configDir: routeCfg })

      const app = new Hono()
      app.route("/v1/sessions", createSessionRouter(() => readerManager(routeCfg)))
      const res = await app.request("http://localhost/v1/sessions")
      expect(res.status).toBe(200)
      const listed = (await res.json()) as Array<{ id: string }>
      expect(listed.map((s) => s.id)).toEqual(["sess-visible"])
    } finally {
      await rmRetryAsync(routeFrom)
      await rmRetryAsync(routeCfg)
    }
  })
})

describe("legacyTranscriptReader / legacyTodosReader (bound to --from)", () => {
  it("reader resolves from the given base dir, not HOME", async () => {
    const from = mkdtempSync(join(tmpdir(), "legacy-reader-"))
    try {
      seedLegacySession(from, "sid-x")
      const read = legacyTranscriptReader(from)
      const data = await read("sid-x")
      expect(data).not.toBeNull()
      expect(data!.metadata.id).toBe("sid-x")
      expect(data!.messages.every((m) => m.id)).toBe(true)
      // 不存在的会话 → null（SDK loadSession 语义）
      expect(await read("missing-sid")).toBeNull()
      // todos：无文件 → null；存在且合法 → 数组
      const todos = legacyTodosReader(from)
      expect(await todos("sid-x")).toBeNull()
      writeFileSync(join(from, "sid-x", "todos.json"), JSON.stringify({ todos: [{ content: "c", status: "pending" }] }), "utf8")
      expect(await todos("sid-x")).toEqual([{ content: "c", status: "pending" }])
    } finally {
      rmSync(from, { recursive: true, force: true })
    }
  })
})

describe("CLI surface: import-legacy-sessions", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "cli-import-"))
  const originalCwd = process.cwd()

  beforeAll(() => {
    seedConfigDir(fixtureDir)
    process.chdir(fixtureDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it("missing --from is a usage error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await runCli(["import-legacy-sessions"])
      expect(code).toBe(CLI_EXIT.USAGE)
      expect(errSpy.mock.calls[0]![0]).toContain("--from")
    } finally {
      errSpy.mockRestore()
    }
  })

  it("nonexistent --from is a usage error (pre-check, no silent zero report)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await runCli(["import-legacy-sessions", "--from", join(tmpdir(), "cli-import-missing-dir")])
      expect(code).toBe(CLI_EXIT.USAGE)
      expect(errSpy.mock.calls[0]![0]).toContain("--from must be an existing directory")
    } finally {
      errSpy.mockRestore()
    }
  })

  it("exit OK on all-imported, ERROR when not-imported > 0; --json carries the report", async () => {
    const from = mkdtempSync(join(tmpdir(), "cli-import-from-"))
    const cfgDir = mkdtempSync(join(tmpdir(), "cli-import-cfg-"))
    seedConfigDir(cfgDir)
    try {
      seedLegacySession(from, "cli-sess-good")
      seedLegacySession(from, "cli-sess-bad", { raw: "nope" })

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const code = await runCli([
          "import-legacy-sessions", "--from", from, "--config", cfgDir, "--json",
        ])
        expect(code).toBe(CLI_EXIT.ERROR) // 存在 not-imported 项
        const payload = JSON.parse(logSpy.mock.calls[0]![0] as string)
        expect(payload.ok).toBe(true) // 命令执行成功（not-imported 是数据面结果）
        expect(payload.from).toBe(from)
        expect(payload.targetDir).toBe(join(cfgDir, ".zerone", "sessions"))
        expect(payload.imported).toBe(1)
        expect(payload.notImported).toBe(1)
        expect(payload.reports).toHaveLength(2)
        // prepared（SDK 内部恢复句柄）已从 JSON 报告剥除
        for (const r of payload.reports) expect(r.prepared).toBeUndefined()

        // 全部成功的场景 → OK（干净 cfg + 干净 from）
        const cfg2 = mkdtempSync(join(tmpdir(), "cli-import-cfg2-"))
        seedConfigDir(cfg2)
        try {
          const from2 = mkdtempSync(join(tmpdir(), "cli-import-from2-"))
          try {
            seedLegacySession(from2, "only-good")
            const ok = await runCli([
              "import-legacy-sessions", "--from", from2, "--config", cfg2, "--json",
            ])
            expect(ok).toBe(CLI_EXIT.OK)
          } finally {
            rmSync(from2, { recursive: true, force: true })
          }
        } finally {
          rmSync(cfg2, { recursive: true, force: true })
        }
      } finally {
        logSpy.mockRestore()
        errSpy.mockRestore()
      }
    } finally {
      rmSync(from, { recursive: true, force: true })
      rmSync(cfgDir, { recursive: true, force: true })
    }
  })

  it("human-readable output: summary on stdout, failure details on stderr", async () => {
    const from = mkdtempSync(join(tmpdir(), "cli-import-hr-"))
    const cfgDir = mkdtempSync(join(tmpdir(), "cli-import-hr-cfg-"))
    seedConfigDir(cfgDir)
    try {
      seedLegacySession(from, "hr-good")
      seedLegacySession(from, "hr-bad", { raw: "nope" })
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const code = await runCli([
          "import-legacy-sessions", "--from", from, "--config", cfgDir,
        ])
        expect(code).toBe(CLI_EXIT.ERROR)
        const stdout = logSpy.mock.calls.map((c) => c[0]).join("\n")
        expect(stdout).toContain(`Legacy session import: ${from} -> ${join(cfgDir, ".zerone", "sessions")}`)
        expect(stdout).toContain("imported: 1, already-exists (skipped): 0, not-imported: 1")
        // 失败明细走 stderr（stdout 保持可管道）
        const stderr = errSpy.mock.calls.map((c) => c[0]).join("\n")
        expect(stderr).toContain("not-imported hr-bad:")
      } finally {
        logSpy.mockRestore()
        errSpy.mockRestore()
      }
    } finally {
      rmSync(from, { recursive: true, force: true })
      rmSync(cfgDir, { recursive: true, force: true })
    }
  })

  it("config discovery failure surfaces as a clean ERROR (not an unhandled crash)", async () => {
    const from = mkdtempSync(join(tmpdir(), "cli-import-cfgerr-"))
    try {
      seedLegacySession(from, "sess-any")
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        // --config 指向无 agents.yaml 的目录 → discoverConfig 抛错——命令内收敛
        const code = await runCli([
          "import-legacy-sessions", "--from", from, "--config", mkdtempSync(join(tmpdir(), "cli-import-nocfg-")),
        ])
        expect(code).toBe(CLI_EXIT.ERROR)
        expect(errSpy.mock.calls[0]![0]).toContain("import-legacy-sessions failed:")
      } finally {
        errSpy.mockRestore()
      }
    } finally {
      rmSync(from, { recursive: true, force: true })
    }
  })
})
