/**
 * 容器身份识别与附件代次比较（issue #61）。
 *
 * Hub 侧的前置 containerId 校验与实际请求处理之间存在容器 recreate 窗口，
 * 只有让"代次校验发生在实际处理附件的 Runtime 请求内"才能结构性封死该
 * TOCTOU。本模块提供：
 *
 * - detectContainerIdentity：确定自身容器身份。优先级：
 *   ① env ZERONE_RUNTIME_CONTAINER_ID（deployer 显式注入/测试覆盖；
 *     非法值 = 配置错误 → unavailable，宁拒绝）
 *   ② cgroup 完整 ID（v2 `docker-<64hex>.scope` / v1 `/docker/<64hex>`）
 *   ③ /etc/hostname 的 Docker 默认 12-hex 前缀
 *   hostname 被显式配置（非 12-hex）、或与 cgroup 来源矛盾时一律
 *   unavailable——issue 契约第 5 条：无法可靠确定身份必须 fail-closed。
 * - compareGeneration：契约固定的比较规则。expected 必须是完整 64-hex
 *   （不接受过短/任意前缀）；full 身份做完整常量时间相等，prefix12 身份
 *   仅允许"完整 64-hex expected 的前 12 位与 hostname 精确相等"。
 * - assertExpectedGeneration：入口断言——Header 存在时在任何附件 I/O 或
 *   run 启动之前调用，失败抛带稳定错误码的 GenerationError。
 */
import { readFileSync } from "node:fs"
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

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function readDefaults(): Required<ContainerIdSources> {
  return {
    env: process.env[CONTAINER_ID_ENV] ?? null,
    cgroup: safeRead("/proc/self/cgroup"),
    hostname: safeRead("/etc/hostname"),
  }
}

/** cgroup 内容提取 Docker 容器完整 ID（v2 scope / v1 路径两种形态） */
function extractCgroupFullId(content: string): string | null {
  const v2 = content.match(/docker-([0-9a-f]{64})\.scope/)
  if (v2) return v2[1]
  const v1 = content.match(/\/docker\/([0-9a-f]{64})/)
  if (v1) return v1[1]
  return null
}

export function detectContainerIdentity(sources?: ContainerIdSources): ContainerIdentity {
  const d = readDefaults()
  const env = sources?.env === undefined ? d.env : sources.env
  const cgroup = sources?.cgroup === undefined ? d.cgroup : sources.cgroup
  const hostnameRaw = sources?.hostname === undefined ? d.hostname : sources.hostname

  // ① env 显式注入：非法值 = 配置错误，宁拒绝不猜测
  if (env !== null && env !== "") {
    return FULL_RE.test(env) ? { kind: "full", id: env } : { kind: "unavailable" }
  }

  // ② cgroup 完整 ID
  const full = cgroup !== null && cgroup !== "" ? extractCgroupFullId(cgroup) : null

  // ③ hostname：Docker 默认为 containerId 前 12 位；显式配置/格式不合法、
  //    或与 cgroup 来源矛盾 → unavailable（fail-closed）
  const host = hostnameRaw !== null && hostnameRaw !== "" ? hostnameRaw.trim() : null
  if (host !== null) {
    if (!HOST12_RE.test(host)) {
      return { kind: "unavailable" }
    }
    if (full !== null && full.slice(0, 12) !== host) {
      return { kind: "unavailable" }
    }
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
 * 入口原子断言（issue #61 契约第 2-4 条）：在读取任何附件、写入上传或
 * 启动 run 之前调用；身份无法确定同样 fail-closed，禁止忽略 Header 继续。
 */
export function assertExpectedGeneration(expectedHeader: string): void {
  const identity = detectContainerIdentity()
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
