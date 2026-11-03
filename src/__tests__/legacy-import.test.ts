import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLegacyImport, legacyTranscriptReader, legacyTodosReader } from "../legacy-import.js"
import { createSessionInfrastructure } from "../session-store.js"
import { runCli, CLI_EXIT } from "../cli.js"
import type { RuntimeConfig } from "../config.js"

/**
 * issue #88：一次性 v3 会话档案导入（opt-in CLI）的行为钉用例。
 *
 * 覆盖：正常导入（含 metadata 保真与消息 id 补写）、幂等重跑（目标已有
 * transcript → already-exists 跳过）、损坏档案降级（畸形 JSON / metadata.id
 * 不匹配 → not-imported 且不影响其他会话）、todos 语义（合法随导入落库、
 * 畸形阻止该项提交且零副作用）、空源目录、CLI 表面（退出码与 --json 输出）。
 *
 * 三态语义来自 SDK importLegacyArchive 编排（issue #131 P3 T7）——本文件钉
 * 的是 runtime 侧的接线：读取器绑定 --from、目标为当前配置的 v4 store。
 */

function makeConfig(): RuntimeConfig {
  return {
    server: { host: "127.0.0.1", port: 3000 },
    agents: [{ id: "a", description: "test agent", model: "m", maxTurns: 5 }],
  }
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
    // FileSessionStore 异步落盘与 rmSync 的竞态——重试清理（helpers/fs 同款语义）。
    for (const dir of [from, configDir]) {
      let lastErr: unknown
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true })
          lastErr = undefined
          break
        } catch (err) {
          lastErr = err
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      if (lastErr) throw lastErr
    }
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

  it("tolerates an empty source directory (zero reports)", async () => {
    const emptyFrom = mkdtempSync(join(tmpdir(), "legacy-empty-"))
    try {
      const { report } = await runLegacyImport({ from: emptyFrom, config: makeConfig(), configDir })
      expect(report.reports).toEqual([])
      expect(report.imported).toBe(0)
    } finally {
      rmSync(emptyFrom, { recursive: true, force: true })
    }
  })
})

describe("legacyTranscriptReader / legacyTodosReader (bound to --from)", () => {
  it("reader resolves from the given base dir, not HOME", async () => {
    const from = mkdtempSync(join(tmpdir(), "legacy-reader-"))
    try {
      seedLegacySession(from, "sid-x")
      const read = legacyTranscriptReader(from)
      const data = (await read("sid-x")) as { metadata: { id: string }; messages: Array<{ id?: string }> } | null
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
    writeFileSync(
      join(fixtureDir, "agents.yaml"),
      "agents:\n  - id: assistant\n    description: Fixture agent for import CLI tests\n",
    )
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

  it("exit OK on all-imported, ERROR when not-imported > 0; --json carries the report", async () => {
    const from = mkdtempSync(join(tmpdir(), "cli-import-from-"))
    const cfgDir = mkdtempSync(join(tmpdir(), "cli-import-cfg-"))
    // CLI 走 findConfigDir + discoverConfig——目标目录须有可发现的 agents.yaml
    writeFileSync(
      join(cfgDir, "agents.yaml"),
      "agents:\n  - id: assistant\n    description: Fixture agent for import CLI tests\n",
    )
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
        expect(payload.from).toBe(from)
        expect(payload.targetDir).toBe(join(cfgDir, ".zerone", "sessions"))
        expect(payload.imported).toBe(1)
        expect(payload.notImported).toBe(1)
        expect(payload.reports).toHaveLength(2)

        // 全部成功的场景 → OK（复用干净 cfg 重建目标）
        const cfg2 = mkdtempSync(join(tmpdir(), "cli-import-cfg2-"))
        writeFileSync(
          join(cfg2, "agents.yaml"),
          "agents:\n  - id: assistant\n    description: Fixture agent for import CLI tests\n",
        )
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
})
