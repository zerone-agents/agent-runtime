import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReadGuardTool, readGuardApplies } from "../read-guard.js"
import { validateAttachments, buildAgentInput } from "../attachments.js"
import { FileReadTool, type ToolContext } from "@zerone-agent/agent-sdk"

/** fd 钉住委托仅在 /proc/self/fd 可用（Linux）时可证；其他平台跳过 */
const itProcfs = existsSync("/proc/self/fd") ? it : it.skip
/** fail-closed 反向验证：无内核 fd 绑定的平台必须拒绝 uploads 文件读取 */
const itFallback = existsSync("/proc/self/fd") ? it.skip : it

/** 最小 ToolContext：Read 路径只消费 cwd，其余字段按类型补齐 */
const ctx = (cwd: string): ToolContext => ({
  cwd,
  agentId: "read-guard-test",
  services: {} as ToolContext["services"],
  subprocessEnv: {},
})

/** SDK Read 成功返回 string 或 { data } 对象，统一取文本断言 */
const asText = (r: unknown): string => (typeof r === "string" ? r : JSON.stringify(r))

describe("buildReadGuardTool", () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "read-guard-"))
    mkdirSync(join(cwd, ".zerone-uploads"), { recursive: true })
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  itProcfs("delegates normal reads under uploads to the base tool", async () => {
    writeFileSync(join(cwd, ".zerone-uploads", "a.txt"), "hello-guard")
    const tool = buildReadGuardTool(cwd)
    const res = await tool.call({ file_path: ".zerone-uploads/a.txt" }, ctx(cwd))
    expect(asText(res)).toContain("hello-guard")
  })

  itProcfs("allows listing the uploads directory itself (real directory)", async () => {
    writeFileSync(join(cwd, ".zerone-uploads", "a.txt"), "x")
    const tool = buildReadGuardTool(cwd)
    const res = await tool.call({ file_path: ".zerone-uploads" }, ctx(cwd))
    expect(asText(res)).toContain("a.txt")
  })

  it("rejects a symlinked file under uploads at Read time", async () => {
    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "OUTSIDE SECRET")
      symlinkSync(join(outside, "secret.txt"), join(cwd, ".zerone-uploads", "link.txt"))
      const tool = buildReadGuardTool(cwd)
      const res = await tool.call({ file_path: ".zerone-uploads/link.txt" }, ctx(cwd))
      expect(res).toMatchObject({ is_error: true })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects intermediate-symlink escape under uploads at Read time", async () => {
    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "OUTSIDE SECRET")
      symlinkSync(outside, join(cwd, ".zerone-uploads", "sub"))
      const tool = buildReadGuardTool(cwd)
      const res = await tool.call({ file_path: ".zerone-uploads/sub/secret.txt" }, ctx(cwd))
      expect(res).toMatchObject({ is_error: true })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  itProcfs("delegation is fd-pinned: a swap between validation and the SDK open cannot feed external content", async () => {
    writeFileSync(join(cwd, ".zerone-uploads", "doc.txt"), "SAFE CONTENT")
    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"))
    try {
      const decoy = join(outside, "secret.txt")
      writeFileSync(decoy, "OUTSIDE SECRET")
      const orig = FileReadTool.call.bind(FileReadTool)
      const spy = vi.spyOn(FileReadTool, "call").mockImplementation(async (input: any, ctx: any) => {
        // 模拟攻击者在校验通过后、SDK 真正打开前换链（review R4 P1 复现）
        rmSync(join(cwd, ".zerone-uploads", "doc.txt"))
        symlinkSync(decoy, join(cwd, ".zerone-uploads", "doc.txt"))
        return orig(input, ctx)
      })
      try {
        const tool = buildReadGuardTool(cwd)
        const res = await tool.call({ file_path: ".zerone-uploads/doc.txt" }, ctx(cwd))
        const text = typeof res === "string" ? res : JSON.stringify(res)
        expect(text).toContain("SAFE CONTENT")
        expect(text).not.toContain("OUTSIDE SECRET")
      } finally {
        spy.mockRestore()
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  itProcfs("directory listing is fd-pinned: a swap before the SDK open cannot list outside names", async () => {
    writeFileSync(join(cwd, ".zerone-uploads", "a.txt"), "x")
    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "s")
      const orig = FileReadTool.call.bind(FileReadTool)
      const spy = vi.spyOn(FileReadTool, "call").mockImplementation(async (input: any, ctx: any) => {
        // 校验后、SDK 真正打开前换链：真实目录改名保内容，词法位置换成
        // 指向外部的 symlink（review R6 P1 复现）
        renameSync(join(cwd, ".zerone-uploads"), join(cwd, ".zerone-uploads-stolen"))
        symlinkSync(outside, join(cwd, ".zerone-uploads"))
        return orig(input, ctx)
      })
      try {
        const tool = buildReadGuardTool(cwd)
        const res = await tool.call({ file_path: ".zerone-uploads" }, ctx(cwd))
        const text = typeof res === "string" ? res : JSON.stringify(res)
        expect(text).toContain("a.txt") // 钉住目录的条目可见
        expect(text).not.toContain("secret.txt") // 外部名字绝不出现在列表
      } finally {
        spy.mockRestore()
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  itFallback("uploads reads fail closed without kernel fd binding (file and directory)", async () => {
    writeFileSync(join(cwd, ".zerone-uploads", "a.txt"), "hello-guard")
    const tool = buildReadGuardTool(cwd)
    const fileRes = await tool.call({ file_path: ".zerone-uploads/a.txt" }, ctx(cwd))
    expect(fileRes).toMatchObject({ is_error: true })
    expect(JSON.stringify(fileRes)).toContain("/proc/self/fd")
    const dirRes = await tool.call({ file_path: ".zerone-uploads" }, ctx(cwd))
    expect(dirRes).toMatchObject({ is_error: true })
  })

  it("leaves paths outside uploads untouched (base behavior, even symlinks)", async () => {    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"))
    try {
      writeFileSync(join(outside, "ok.txt"), "FINE")
      symlinkSync(join(outside, "ok.txt"), join(cwd, "plain-link.txt"))
      const tool = buildReadGuardTool(cwd)
      const res = await tool.call({ file_path: "plain-link.txt" }, ctx(cwd))
      expect(asText(res)).toContain("FINE")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  itProcfs("reviewer repro: snapshot swapped after buildAgentInput is rejected at Read time", async () => {
    // R3 P1 端到端复现：物化快照后 unlink + symlink 指向 cwd 外 secret，
    // 防护版 Read 必须拒绝（不再读到 OUTSIDE SECRET）
    writeFileSync(join(cwd, ".zerone-uploads", "doc.txt"), "SAFE CONTENT")
    const validated = await validateAttachments(cwd, [
      { id: "t", name: "doc.txt", mime: "text/plain", size: 12, path: ".zerone-uploads/doc.txt" },
    ])
    const input = await buildAgentInput("m", validated)
    const text = (input as Array<{ type: string; text?: string }>)[0].text ?? ""
    const m = text.match(/\.zerone-uploads\/(snap-[0-9a-f]{8}-doc\.txt)/)
    expect(m).not.toBeNull()

    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "OUTSIDE SECRET")
      rmSync(join(cwd, ".zerone-uploads", m![1]))
      symlinkSync(join(outside, "secret.txt"), join(cwd, ".zerone-uploads", m![1]))
      const tool = buildReadGuardTool(cwd)
      const res = await tool.call({ file_path: `.zerone-uploads/${m![1]}` }, ctx(cwd))
      expect(res).toMatchObject({ is_error: true })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("readGuardApplies", () => {
  it("applies by default and when the allow-list covers Read", () => {
    expect(readGuardApplies(undefined)).toBe(true)
    expect(readGuardApplies([])).toBe(true)
    expect(readGuardApplies(["Read", "Bash"])).toBe(true)
    expect(readGuardApplies(["Rea*"])).toBe(true)
  })
  it("skips when an allow-list excludes Read (custom tools bypass the SDK allow-list)", () => {
    expect(readGuardApplies(["Bash"])).toBe(false)
    expect(readGuardApplies(["Bash", "Write*"])).toBe(false)
  })
})
