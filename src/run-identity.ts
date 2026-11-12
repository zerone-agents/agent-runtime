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
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(sessionsDir: string) {
    this.file = join(sessionsDir, "session-identity.json")
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
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
    this.data.set(sessionId, { userId, boundAt: new Date().toISOString() })
    await this.persist()
  }

  /** 清除会话绑定（session DELETE 级联）；无绑定时不产生写。 */
  async clear(sessionId: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.data.delete(sessionId)) return
    await this.persist()
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
