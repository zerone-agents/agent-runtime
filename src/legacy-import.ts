import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  importLegacyArchive,
  type ImportArchiveReport,
  type ImportLegacyOptions,
} from "@zerone-agent/agent-sdk/store"
import type { NormalizedMessageParam } from "@zerone-agent/agent-sdk"
import { createSessionInfrastructure } from "./session-store.js"
import { resolveSessionsDir } from "./data-root.js"
import type { RuntimeConfig } from "./config.js"

/**
 * 一次性 v3 会话档案导入（issue #88，opt-in CLI——不做启动时自动迁移）。
 *
 * 迁移面：裸机/持久 HOME 部署升级到 SDK v4 存储（PR #86）后，磁盘上残留的
 * `~/.agents/sessions/<id>/transcript.json`（+ 可选 todos.json）。Docker 部署
 * 的容器内 HOME 历来不在卷挂载指引内，旧档案随容器重建已丢——本命令对其
 * 是无害 no-op（源目录为空 → 全量 not-imported? 不——空目录扫描为 0 项）。
 *
 * HOME 漂移规避：源位置经 `--from` 显式给定，读取器全部绑定该目录——
 * 不猜测「当前 HOME vs 历史 HOME」。目标恒为当前配置的 v4 store
 * （`resolveSessionsDir`，与 runtime serve 同一落点）。
 */

/** v3 档案形状（SDK session.ts 的 SessionData；此处按结构复述以绑定 baseDir 读取）。 */
interface LegacySessionData {
  metadata: { id: string } & Record<string, unknown>
  messages: NormalizedMessageParam[]
}

/**
 * 绑定 `--from` 的 transcript 读取器——语义与 SDK @deprecated loadSession
 * 一致：不可读 → null（v3 FileSessionStorage.load 语义）；畸形 → throw
 * （编排层归为 not-imported）；无 id 消息补 UUID（import 按 messageId 去重，
 * 不补 id 的消息会被静默丢弃）。
 */
export function legacyTranscriptReader(from: string): NonNullable<ImportLegacyOptions["legacyReader"]> {
  return async (sessionId: string) => {
    const file = join(from, sessionId, "transcript.json")
    let raw: string
    try {
      raw = await readFile(file, "utf-8")
    } catch {
      return null
    }
    const data = JSON.parse(raw) as LegacySessionData
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
    return data as never
  }
}

/**
 * 绑定 `--from` 的 todos 读取器——语义与 SDK readLegacyTodos 一致（R24 严格）：
 * 仅 ENOENT 视为无 todos（null）；其他 IO 错误、解析失败、结构错误（缺 todos
 * 数组）一律 throw——编排层归为 not-imported 且**未提交任何操作**，修复档案
 * 后重跑即恢复（不得当作已导入，否则 transcript 已存在、todos 无法补导）。
 */
export function legacyTodosReader(from: string): NonNullable<ImportLegacyOptions["legacyTodosReader"]> {
  return async (sessionId: string) => {
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
    return parsed.todos as never
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
 * 执行一次性导入：扫描 `from` 下的会话目录，逐个经 SDK `importLegacyArchive`
 * 三态编排（imported / already-exists-unknown / not-imported）写入当前配置的
 * v4 store。幂等可重跑——目标已有 transcript 的会话按 already-exists 跳过；
 * not-imported 项（档案缺失/畸形/todos 阻断）未提交任何操作，修复后重跑即可。
 */
export async function runLegacyImport(opts: {
  from: string
  config: RuntimeConfig
  configDir: string
}): Promise<LegacyImportResult> {
  const targetDir = resolveSessionsDir(opts.config, opts.configDir)
  const { store, coordinator } = createSessionInfrastructure(targetDir)
  const report = await importLegacyArchive(
    {
      store,
      coordinator,
      legacyReader: legacyTranscriptReader(opts.from),
      legacyTodosReader: legacyTodosReader(opts.from),
    },
    { baseDir: opts.from },
  )
  return { from: opts.from, targetDir, report }
}
