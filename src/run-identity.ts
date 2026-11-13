import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * 会话级身份透传的 runtime 基础设施（issue #95）。
 *
 * 两个正交构件：
 * 1. **Run 作用域上下文**（AsyncLocalStorage）：run 入口建立，engine →
 *    工具执行 → MCP transport fetch 的整条进程内异步链（含 Task/MultiTask
 *    子代理 spawn——子引擎同样在父 run 的异步链上）都可读；cron 触发的
 *    run 与任何 run 之外的后台操作读到 undefined。
 * 2. **会话身份绑定**（文件侧 store）：`X-User-Id` 首次随 run 到达即绑定
 *    会话，随会话生命周期存续（跨 run、跨重启——后续 run 不带头仍保有
 *    既有身份，带头则重绑更新）；session DELETE 级联清除。SDK SessionStore
 *    的 metadata 是固定类型形状、无公开写入口，故 runtime 自持 sidecar
 *    （与 sessions.json 同目录、同单写者模型：一个 runtime 进程一个文件）。
 */

/** 身份头名：入站（run 请求头）与出站（hub MCP 调用）同名同值贯穿——issue #95 的刻意设计。 */
export const USER_ID_HEADER = "X-User-Id"
export const RUN_ID_HEADER = "X-Run-Id"

/** 入站 X-User-Id 的合法上限（评审建议 1：垃圾身份不落库出站）。 */
export const USER_ID_MAX_LENGTH = 128

/**
 * 校验入站 X-User-Id：返回拒绝原因（undefined = 合法）。非空且无首尾空白
 *（trim 不改变原值——HTTP 解析通常已剥离首尾空白，此规则防御非 HTTP 注入
 * 路径）、≤128 字符、无控制字符（含 CR/LF——SDK 的 header 物化已挡换行
 * 注入，此处在入口 fail-fast，给调用方明确的 400 而非静默透传垃圾身份）。
 */
export function invalidUserIdReason(userId: string): string | undefined {
  if (userId.trim().length === 0) return `${USER_ID_HEADER} must be a non-empty identifier`
  if (userId !== userId.trim()) return `${USER_ID_HEADER} must not have leading/trailing whitespace`
  if (userId.length > USER_ID_MAX_LENGTH) return `${USER_ID_HEADER} exceeds ${USER_ID_MAX_LENGTH} characters`
  if (/[\u0000-\u001f\u007f]/.test(userId)) return `${USER_ID_HEADER} contains control characters`
  return undefined
}

/** run 作用域身份——MCP header provider 在每次请求时读取。 */
export interface RunIdentityContext {
  runId: string
  sessionId: string
  /** 会话绑定的用户 ID（本次 run 头携带，或会话既有绑定）；无身份时 undefined。 */
  userId?: string
}

const runIdentityStorage = new AsyncLocalStorage<RunIdentityContext>()

/** 在 run 身份上下文内执行 fn：fn 内发起的整条异步链（含 MCP 调用）可读身份。 */
export function runWithIdentity<T>(ctx: RunIdentityContext, fn: () => T): T {
  return runIdentityStorage.run(ctx, fn)
}

/** 当前异步链上的 run 身份；run 之外（cron、后台任务、启动路径）为 undefined。 */
export function getCurrentRunIdentity(): RunIdentityContext | undefined {
  return runIdentityStorage.getStore()
}

/**
 * 包裹异步生成器：每次推进（next / return / throw）都重新进入 run 身份
 * 上下文——生成器体内执行的 engine → 工具 → MCP transport 链在读到身份，
 * 与消费方的调度上下文无关（SSE 流回调在 Hono 响应泵送时才执行，
 * 不依赖框架的上下文传播语义）。
 */
export function generatorWithIdentity<T, TReturn, TNext>(
  ctx: RunIdentityContext,
  gen: AsyncGenerator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  const advance = <R>(fn: () => Promise<R>): Promise<R> => runWithIdentity(ctx, fn)
  return {
    // next 的参数以 rest 形式原样转发（[] | [TNext] 保类型）；return 的可选
    // 值经 as 委托——AsyncGenerator 接口的 return 形参必填，但运行时 async
    // generator 接受 undefined（for-await 提前退出即无参调用，语义等价）。
    next: (...args: [] | [TNext]) => advance(() => gen.next(...args)),
    return: (value?: TReturn) => advance(() => gen.return(value as TReturn)),
    throw: (reason?: unknown) => advance(() => gen.throw(reason)),
    [Symbol.asyncIterator]() {
      return this
    },
  } as AsyncGenerator<T, TReturn, TNext>
}

/**
 * MCP 动态 header provider（SDK ≥4.2.0 McpHeaderProvider，agent-sdk#163）：
 * 静态部署头（如 `X-Agent-Capability`）之上叠加当前 run 的身份头。
 * 无身份（cron、未绑定会话、run 外调用）→ 仅静态头，与现状行为一致
 * （issue #95 验收 2：不带 X-User-Id 的 run，hub MCP 调用不带身份头）。
 */
export function identityHeaderProvider(
  staticHeaders: Record<string, string> | undefined,
): () => Record<string, string> {
  return () => {
    const ctx = getCurrentRunIdentity()
    const headers: Record<string, string> = { ...(staticHeaders ?? {}) }
    if (ctx?.userId !== undefined) {
      headers[USER_ID_HEADER] = ctx.userId
      headers[RUN_ID_HEADER] = ctx.runId
    }
    return headers
  }
}

export interface SessionIdentityEntry {
  userId: string
  /** ISO-8601：首次（或最近一次重绑）绑定时间。 */
  boundAt: string
}

/**
 * 文件侧会话→用户绑定表：`<sessionsDir>/session-identity.json`。
 *
 * - 读穿（load once）+ 写穿（map 更新后原子落盘，temp+rename；进程内经
 *   promise 链串行化写操作，防并发 read-modify-write 交错）
 * - 文件缺失/损坏 → 空表起步（损坏在下次 bind 时被覆盖修复）
 * - 孤儿条目（会话已删而条目残留）惰性无害：sessionId 为 UUID 不复用，
 *   身份只在对应 run 发生时注入；DELETE 路径的级联清除是主清理通道
 */
export class SessionIdentityStore {
  private readonly file: string
  private data = new Map<string, SessionIdentityEntry>()
  /**
   * 首载竞态修复（评审重要 1）：共享 loadPromise——并发 get/bind/clear
   * await 同一次加载。旧实现的 loaded 标志在读盘前置位，首载窗口内的
   * 并发 get 读到空表（该次 MCP 请求漏注身份）、并发 bind 会被首载完成
   * 的磁盘旧值覆盖（重绑丢失）。
   */
  private loadPromise: Promise<void> | undefined
  private writeChain: Promise<void> = Promise.resolve()
  /**
   * 本进程 bind 过的 sessionId——prune 的保护集（见 prune 注释）。
   * e2e 实证竞态：绑定发生在 run 开始，session 行要到 run 结束（首个
   * checkpoint）才落盘——清扫若把「行未落」当孤儿，会抹掉刚绑定的身份。
   */
  private boundInProcess = new Set<string>()

  constructor(sessionsDir: string) {
    this.file = join(sessionsDir, "session-identity.json")
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load()
    return this.loadPromise
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, "utf-8")
    } catch {
      return // 文件不存在 → 空表
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, SessionIdentityEntry>
      if (parsed !== null && typeof parsed === "object") {
        for (const [sid, entry] of Object.entries(parsed)) {
          if (entry !== null && typeof entry === "object" && typeof entry.userId === "string") {
            this.data.set(sid, { userId: entry.userId, boundAt: typeof entry.boundAt === "string" ? entry.boundAt : "" })
          }
        }
      }
    } catch {
      // 损坏 → 空表起步；下次 bind 的写穿会覆盖修复
    }
  }

  /** 会话的既有绑定；无则 undefined。 */
  async get(sessionId: string): Promise<SessionIdentityEntry | undefined> {
    await this.ensureLoaded()
    return this.data.get(sessionId)
  }

  /** 绑定（或重绑更新）会话身份并落盘。 */
  async bind(sessionId: string, userId: string): Promise<void> {
    await this.ensureLoaded()
    this.boundInProcess.add(sessionId)
    this.data.set(sessionId, { userId, boundAt: new Date().toISOString() })
    await this.persist()
  }

  /** 清除会话绑定（session DELETE 级联）；无绑定时不产生写。 */
  async clear(sessionId: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.data.delete(sessionId)) return
    await this.persist()
  }

  /**
   * 孤儿清扫（评审建议 6）：清除 liveSessionIds 之外的条目（会话已删而
   * 绑定残留——DELETE best-effort 失败、或存量数据）。返回清除数量。
   *
   * **本进程 bind 过的条目受保护**：绑定发生在 run 开始，session 行要到
   * run 结束（首个 checkpoint）才落盘——「行未落」与「会话已删」在 store
   * 侧不可区分，无保护的热清扫会误删刚绑定的身份（e2e 实证：冷启动
   * 清扫的 list 快照在首个 run 的 bind 与 checkpoint 之间解析为空集）。
   * 磁盘遗留条目（上一进程）无此窗口——其 run 要么已 checkpoint（行在
   * → live），要么从未完成（行不在 → 绑定失效，清除正确）。
   */
  async prune(liveSessionIds: ReadonlySet<string>): Promise<number> {
    await this.ensureLoaded()
    let removed = 0
    for (const sid of [...this.data.keys()]) {
      if (this.boundInProcess.has(sid)) continue
      if (!liveSessionIds.has(sid)) {
        this.data.delete(sid)
        removed++
      }
    }
    if (removed > 0) await this.persist()
    return removed
  }

  /** 原子落盘：temp+rename；写操作经链串行（单进程单写者）。 */
  private persist(): Promise<void> {
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), "utf-8")
      await rename(tmp, this.file)
    }
    // 链上失败不阻断后续写（下一次 bind/clear 重新尝试持久化整表）。
    this.writeChain = this.writeChain.then(write, write)
    return this.writeChain
  }
}
