/**
 * 容器身份识别与附件代次比较（issue #61，PR #62 review 修复）。
 *
 * Hub 侧的前置 containerId 校验与实际请求处理之间存在容器 recreate 窗口，
 * 只有让"代次校验发生在实际处理附件的 Runtime 请求内"才能结构性封死该
 * TOCTOU。本模块提供：
 *
 * - detectContainerIdentity：确定自身容器身份。**任何可用来源矛盾一律
 *   fail-closed（review P1）**——合法的 env 注入也不得压倒冲突的 cgroup/
 *   hostname（陈旧注入可能重新造成跨代放行）。来源：
 *   ① env ZERONE_RUNTIME_CONTAINER_ID（deployer 显式注入/测试覆盖；
 *     非法值 = 配置错误 → unavailable）
 *   ② cgroup 完整 ID（v2 `docker-<64hex>.scope` / v1 `/docker/<64hex>`）
 *   ③ /etc/hostname 的 Docker 默认 12-hex 前缀
 *   hostname 被显式配置（非 12-hex）、env/cgroup/hostname 两两矛盾时
 *   一律 unavailable。文件读取走 async + promise 缓存（review P2：容器
 *   身份进程内不变，热路径不重复做文件 I/O）。
 * - compareGeneration：契约固定的比较规则。expected 必须是完整 64-hex
 *   （不接受过短/任意前缀）；full 身份做完整常量时间相等，prefix12 身份
 *   仅允许"完整 64-hex expected 的前 12 位与 hostname 精确相等"。
 * - assertExpectedGeneration：入口断言——Header 存在时在任何附件 I/O 或
 *   run 启动之前调用，失败抛带稳定错误码的 GenerationError。
 * - generationErrorPayload：三入口共用的错误映射（review P3）。
 */
import { readFile } from "node:fs/promises"
import { timingSafeEqual } from "node:crypto"

/** 入口请求头（Hono 大小写不敏感；对外文档拼写为 X-Expected-Container-Id） */
export const EXPECTED_CONTAINER_ID_HEADER = "X-Expected-Container-Id"

/** 测试/deployer 显式注入自身容器身份的环境变量 */
export const CONTAINER_ID_ENV = "ZERONE_RUNTIME_CONTAINER_ID"

export type ContainerIdentity =
  | { kind: "full"; id: string }
  | { kind: "prefix12"; id: string }
  | { kind: "unavailable" }

/** 可注入来源（测试用）；undefined 字段回退到真实环境读取，null 表示来源不存在 */
export interface ContainerIdSources {
  env?: string | null
  cgroup?: string | null
  hostname?: string | null
}

const FULL_RE = /^[0-9a-f]{64}$/
const HOST12_RE = /^[0-9a-f]{12}$/

/**
 * 文件来源的 async 读取 + 进程级 promise 缓存（review P2）：容器身份在
 * 进程生命周期内不变，cgroup/hostname 只读一次，热路径零文件 I/O。
 */
let defaultFilesCache: Promise<{ cgroup: string | null; hostname: string | null }> | null = null

function loadDefaultFiles(): Promise<{ cgroup: string | null; hostname: string | null }> {
  if (defaultFilesCache === null) {
    defaultFilesCache = (async () => ({
      cgroup: await readFile("/proc/self/cgroup", "utf8").catch(() => null),
      hostname: await readFile("/etc/hostname", "utf8").catch(() => null),
    }))()
  }
  return defaultFilesCache
}

/** cgroup 内容提取 Docker 容器完整 ID（v2 scope / v1 路径两种形态） */
function extractCgroupFullId(content: string): string | null {
  const v2 = content.match(/docker-([0-9a-f]{64})\.scope/)
  if (v2) return v2[1]
  const v1 = content.match(/\/docker\/([0-9a-f]{64})/)
  if (v1) return v1[1]
  return null
}

export async function detectContainerIdentity(sources?: ContainerIdSources): Promise<ContainerIdentity> {
  const files = await loadDefaultFiles()
  const env = sources?.env === undefined ? (process.env[CONTAINER_ID_ENV] ?? null) : sources.env
  const cgroup = sources?.cgroup === undefined ? files.cgroup : sources.cgroup
  const hostnameRaw = sources?.hostname === undefined ? files.hostname : sources.hostname

  // 提取可用来源
  const full = cgroup !== null && cgroup !== "" ? extractCgroupFullId(cgroup) : null
  const host = hostnameRaw !== null && hostnameRaw !== "" ? hostnameRaw.trim() : null

  // hostname 被显式配置（非 Docker 默认 12-hex）→ unavailable（无论 env 是否注入）
  if (host !== null && !HOST12_RE.test(host)) {
    return { kind: "unavailable" }
  }
  // cgroup 与 hostname 矛盾 → unavailable
  if (host !== null && full !== null && full.slice(0, 12) !== host) {
    return { kind: "unavailable" }
  }

  // env 显式注入（review P1）：非法 = 配置错误；与任何可用来源矛盾 =
  // 陈旧注入不得压倒真实身份 → 一律 unavailable
  if (env !== null && env !== "") {
    if (!FULL_RE.test(env)) return { kind: "unavailable" }
    if (full !== null && full !== env) return { kind: "unavailable" }
    if (host !== null && env.slice(0, 12) !== host) return { kind: "unavailable" }
    return { kind: "full", id: env }
  }

  if (full !== null) return { kind: "full", id: full }
  if (host !== null) return { kind: "prefix12", id: host }
  return { kind: "unavailable" }
}

export type GenerationComparison = "match" | "mismatch" | "unavailable"

function timingEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function compareGeneration(expected: string, identity: ContainerIdentity): GenerationComparison {
  if (identity.kind === "unavailable") return "unavailable"
  // expected 必须是完整 64-hex：不接受过短/任意前缀（issue 契约第 5 条）
  if (!FULL_RE.test(expected)) return "mismatch"
  if (identity.kind === "full") {
    return timingEqual(expected, identity.id) ? "match" : "mismatch"
  }
  // prefix12：仅允许"完整 64-hex expected 的前 12 位与 hostname 精确相等"
  return timingEqual(expected.slice(0, 12), identity.id) ? "match" : "mismatch"
}

export type GenerationErrorCode = "generation_mismatch" | "generation_unavailable"

export class GenerationError extends Error {
  constructor(
    public code: GenerationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "GenerationError"
  }
}

/**
 * 三入口共用的错误映射（review P3）：mismatch → 412，unavailable → 503。
 */
export function generationErrorPayload(err: GenerationError): {
  status: 412 | 503
  body: { error: string; code: GenerationErrorCode }
} {
  return {
    status: err.code === "generation_mismatch" ? 412 : 503,
    body: { error: err.message, code: err.code },
  }
}

/**
 * 入口原子断言（issue #61 契约第 2-4 条）：在读取任何附件、写入上传或
 * 启动 run 之前调用；身份无法确定同样 fail-closed，禁止忽略 Header 继续。
 */
export async function assertExpectedGeneration(expectedHeader: string): Promise<void> {
  const identity = await detectContainerIdentity()
  const result = compareGeneration(expectedHeader, identity)
  if (result === "unavailable") {
    throw new GenerationError(
      "generation_unavailable",
      "runtime cannot reliably determine its container identity",
    )
  }
  if (result === "mismatch") {
    throw new GenerationError(
      "generation_mismatch",
      "attachment generation does not match the current runtime container",
    )
  }
}
