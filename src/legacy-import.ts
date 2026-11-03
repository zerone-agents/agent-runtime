import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SessionData, TodoInfo } from "@zerone-agent/agent-sdk"
import {
  importLegacySession,
  type ImportArchiveReport,
  type ImportLegacyOptions,
  type ImportReport,
} from "@zerone-agent/agent-sdk/store"
import { createSessionInfrastructure } from "./session-store.js"
import { resolveSessionsDir } from "./data-root.js"
import type { RuntimeConfig } from "./config.js"

/**
 * 一次性 v3 会话档案导入（issue #88，opt-in CLI——不做启动时自动迁移）。
 *
 * 迁移面：持久 HOME 的裸机部署升级到 SDK v4 存储（PR #86）后磁盘上残留的
 * `~/.agents/sessions/<id>/transcript.json`（+ 可选 todos.json）；Docker
 * 容器内 HOME 历来不在卷挂载指引内，旧档案随容器重建已丢。HOME 漂移规避：
 * 源位置经 `--from` 显式给定，读取器全部绑定该目录；目标恒为当前配置的
 * v4 store（`resolveSessionsDir`，与 serve 同一落点）。
 *
 * 编排在 runtime 侧而非 SDK `importLegacyArchive`：后者对 readdir 失败
 * 静默返回全零报告（源目录缺失/不可读与真实空目录不可区分），且不区分
 * 目录与杂项条目（`.DS_Store` 等会被当会话 id 导入并翻转退出码）。
 */

/**
 * 绑定 `--from` 的 transcript 读取器——语义与 SDK @deprecated loadSession
 * 一致：不可读 → null（v3 FileSessionStorage.load 语义）；畸形 → throw
 * （编排层归为 not-imported）；无 id 消息补 UUID（import 按 messageId 去重，
 * 不补 id 的消息会被静默丢弃）。
 */
export function legacyTranscriptReader(from: string): NonNullable<ImportLegacyOptions["legacyReader"]> {
  return async (sessionId: string): Promise<SessionData | null> => {
    const file = join(from, sessionId, "transcript.json")
    let raw: string
    try {
      raw = await readFile(file, "utf-8")
    } catch {
      return null
    }
    const data = JSON.parse(raw) as SessionData
    if (
      typeof data !== "object" || data === null
      || typeof data.metadata !== "object" || data.metadata === null
      || !Array.isArray(data.messages)
    ) {
      throw new Error(`malformed SessionData: metadata object and messages array required (${file})`)
    }
    if (data.metadata.id !== sessionId) {
      throw new Error(`metadata.id mismatch: stored ${String(data.metadata.id)} (${file})`)
    }
    for (const msg of data.messages) {
      if (!msg.id) msg.id = randomUUID()
    }
    return data
  }
}

/**
 * 绑定 `--from` 的 todos 读取器——语义与 SDK readLegacyTodos 一致（R24 严格）：
 * 仅 ENOENT 视为无 todos（null）；其他 IO 错误、解析失败、结构错误（缺 todos
 * 数组）一律 throw——编排层归为 not-imported 且**未提交任何操作**，修复档案
 * 后重跑即恢复（不得当作已导入，否则 transcript 已存在、todos 无法补导）。
 */
export function legacyTodosReader(from: string): NonNullable<ImportLegacyOptions["legacyTodosReader"]> {
  return async (sessionId: string): Promise<TodoInfo[] | null> => {
    const file = join(from, sessionId, "todos.json")
    let raw: string
    try {
      raw = await readFile(file, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
    const parsed = JSON.parse(raw) as { todos?: unknown }
    if (!Array.isArray(parsed.todos)) {
      throw new Error(`legacy todos.json exists but has no todos array (structure error) (${file})`)
    }
    return parsed.todos as TodoInfo[]
  }
}

export interface LegacyImportResult {
  /** v3 档案源目录（调用方显式给定）。 */
  from: string
  /** v4 store 目录（当前配置的 resolveSessionsDir 落点）。 */
  targetDir: string
  report: ImportArchiveReport
}

/**
 * 执行一次性导入：扫描 `from` 下的会话目录（仅目录条目——杂项文件跳过），
 * 逐个经 SDK `importLegacySession` 三态编排（imported / already-exists-unknown
 * / not-imported）写入当前配置的 v4 store。幂等可重跑——目标已有 transcript
 * 的会话按 already-exists 跳过；not-imported 项（档案缺失/畸形/todos 阻断）
 * 未提交任何操作，修复后重跑即可。
 *
 * 源目录缺失/不可读直接抛错——与「真实空目录（零报告）」显式区分，调用方
 * （CLI）据此判定操作者输入错误而非无事可导。
 */
export async function runLegacyImport(opts: {
  from: string
  config: RuntimeConfig
  configDir: string
}): Promise<LegacyImportResult> {
  // withFileTypes：目录过滤（发现 2）兼源可读性预检（发现 1）——readdir
  // 失败（不存在/非目录/无权限）在此抛出，不再有全零报告的假成功。
  const entries = await readdir(opts.from, { withFileTypes: true })
  const sessionIds = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  const targetDir = resolveSessionsDir(opts.config, opts.configDir)
  const { store, coordinator } = createSessionInfrastructure(targetDir)
  const init: ImportLegacyOptions = {
    store,
    coordinator,
    legacyReader: legacyTranscriptReader(opts.from),
    legacyTodosReader: legacyTodosReader(opts.from),
  }

  const reports: ImportReport[] = []
  for (const sid of sessionIds) {
    reports.push(await importLegacySession(init, sid))
  }
  return {
    from: opts.from,
    targetDir,
    report: {
      reports,
      imported: reports.filter((r) => r.status === "imported").length,
      alreadyExistsUnknown: reports.filter((r) => r.status === "already-exists-unknown").length,
      notImported: reports.filter((r) => r.status === "not-imported").length,
    },
  }
}
