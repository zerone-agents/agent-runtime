import { describe, it, expect } from "vitest"
import { detectContainerIdentity, compareGeneration } from "../container-id.js"

const FULL_A = "a".repeat(64)
const FULL_B = "b".repeat(64)
const OTHER_FULL = "c".repeat(64)

/** 便捷构造：显式提供三个来源，避免测试依赖宿主真实环境 */
const src = (over: {
  env?: string | null
  cgroup?: string | null
  hostname?: string | null
}) => ({
  env: over.env ?? null,
  cgroup: over.cgroup ?? null,
  hostname: over.hostname ?? null,
})

describe("detectContainerIdentity", () => {
  it("env 注入完整 64-hex → full 身份（优先级最高）", () => {
    expect(detectContainerIdentity(src({ env: FULL_A }))).toEqual({ kind: "full", id: FULL_A })
  })

  it("env 非法（过短/非 hex）→ unavailable（显式注入配置错误宁拒绝）", () => {
    expect(detectContainerIdentity(src({ env: "abc123" }))).toEqual({ kind: "unavailable" })
    expect(detectContainerIdentity(src({ env: "x".repeat(64) }))).toEqual({ kind: "unavailable" })
  })

  it("cgroup v2 docker-<64hex>.scope → full", () => {
    const cgroup = `0::/0.system.slice/docker-${FULL_A}.scope\n`
    expect(detectContainerIdentity(src({ cgroup }))).toEqual({ kind: "full", id: FULL_A })
  })

  it("cgroup v1 /docker/<64hex> → full", () => {
    const cgroup = `13:cpu:/docker/${FULL_A}\n6:memory:/docker/${FULL_A}\n`
    expect(detectContainerIdentity(src({ cgroup }))).toEqual({ kind: "full", id: FULL_A })
  })

  it("cgroup 无 docker 条目 + hostname 12-hex → prefix12", () => {
    const cgroup = "0::/0.system.slice/user-1000.slice\n"
    expect(detectContainerIdentity(src({ cgroup, hostname: FULL_B.slice(0, 12) }))).toEqual({
      kind: "prefix12",
      id: FULL_B.slice(0, 12),
    })
  })

  it("hostname 显式配置（非 12-hex）→ unavailable（issue：显式 hostname 拒绝）", () => {
    expect(detectContainerIdentity(src({ hostname: "my-runtime-host" }))).toEqual({ kind: "unavailable" })
  })

  it("hostname 格式合法但与 cgroup full 矛盾 → unavailable（来源矛盾拒绝）", () => {
    const cgroup = `0::/0.system.slice/docker-${FULL_A}.scope\n`
    expect(
      detectContainerIdentity(src({ cgroup, hostname: OTHER_FULL.slice(0, 12) })),
    ).toEqual({ kind: "unavailable" })
  })

  it("hostname 与 cgroup full 前 12 位一致 → full 优先（完整比较）", () => {
    const cgroup = `0::/0.system.slice/docker-${FULL_A}.scope\n`
    expect(
      detectContainerIdentity(src({ cgroup, hostname: FULL_A.slice(0, 12) })),
    ).toEqual({ kind: "full", id: FULL_A })
  })

  it("全部来源缺失 → unavailable", () => {
    expect(detectContainerIdentity(src({}))).toEqual({ kind: "unavailable" })
  })

  it("env 优先于 cgroup（deployer 显式注入胜出）", () => {
    const cgroup = `0::/0.system.slice/docker-${FULL_B}.scope\n`
    expect(detectContainerIdentity(src({ env: FULL_A, cgroup }))).toEqual({ kind: "full", id: FULL_A })
  })
})

describe("compareGeneration", () => {
  const full = { kind: "full" as const, id: FULL_A }
  const prefix = { kind: "prefix12" as const, id: FULL_A.slice(0, 12) }
  const unavailable = { kind: "unavailable" as const }

  it("full 身份：expected 完整相等 → match", () => {
    expect(compareGeneration(FULL_A, full)).toBe("match")
  })

  it("full 身份：expected 不同 → mismatch", () => {
    expect(compareGeneration(OTHER_FULL, full)).toBe("mismatch")
  })

  it("prefix12 身份：expected 完整 64-hex 的前 12 位与 hostname 精确相等 → match", () => {
    expect(compareGeneration(FULL_A, prefix)).toBe("match")
  })

  it("prefix12 身份：前 12 位不等 → mismatch", () => {
    expect(compareGeneration(OTHER_FULL, prefix)).toBe("mismatch")
  })

  it("expected 非完整 64-hex 一律 mismatch（不接受过短/任意前缀）", () => {
    expect(compareGeneration(FULL_A.slice(0, 12), full)).toBe("mismatch") // 恰好 12 位（hostname 形态）
    expect(compareGeneration(FULL_A.slice(0, 63), full)).toBe("mismatch") // 过短 1 位
    expect(compareGeneration(FULL_A + "d", full)).toBe("mismatch") // 过长
    expect(compareGeneration("X".repeat(64), full)).toBe("mismatch") // 非 hex
    expect(compareGeneration(FULL_A.toUpperCase(), full)).toBe("mismatch") // 大写 hex 不接受
  })

  it("身份 unavailable → unavailable（禁止忽略 Header 继续）", () => {
    expect(compareGeneration(FULL_A, unavailable)).toBe("unavailable")
  })
})
