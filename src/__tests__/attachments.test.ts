import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readFileSync } from "node:fs"
import { readFile, open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import sharp from "sharp"
import {
  AttachmentError, parseAttachmentDescriptors, validateAttachments,
  buildAgentInput, composeAttachmentText, MAX_IMAGE_EDGE,
  type AttachmentDescriptor, type ValidatedAttachment,
} from "../attachments.js"

// 复现"lstat 后同 inode 扩容"（review R3 P1）：按需把 lstat 压报为更小 size，
// 默认 null = 原样透传。vi.mock 提升到模块图顶部，对本文件与 attachments.ts 同时生效。
const lstatOverride = vi.hoisted(() => ({ reportedSize: null as number | null }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    lstat: (p: string) =>
      actual.lstat(p).then((st) =>
        lstatOverride.reportedSize === null
          ? st
          : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: lstatOverride.reportedSize }),
      ),
  }
})

const MB = 1024 * 1024

function desc(over: Partial<AttachmentDescriptor> = {}): AttachmentDescriptor {
  return { id: randomUUID(), name: "f.bin", mime: "application/octet-stream", size: 3, path: ".zerone-uploads/f.bin", ...over }
}

describe("parseAttachmentDescriptors", () => {
  it("accepts a well-formed array", () => {
    const out = parseAttachmentDescriptors([desc()])
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe(".zerone-uploads/f.bin")
  })
  it("rejects non-array input", () => {
    expect(() => parseAttachmentDescriptors("nope")).toThrowError(AttachmentError)
    try { parseAttachmentDescriptors("nope") } catch (e) {
      expect((e as AttachmentError).code).toBe("invalid_attachment")
    }
  })
  it("rejects non-object elements", () => {
    expect(() => parseAttachmentDescriptors([42])).toThrowError(AttachmentError)
  })
  it("rejects missing/non-string fields", () => {
    expect(() => parseAttachmentDescriptors([{ id: 1, name: "a", mime: "m", size: 1, path: "p" }])).toThrowError(AttachmentError)
    expect(() => parseAttachmentDescriptors([{ id: "a", name: "a", mime: "m", size: 1 }])).toThrowError(AttachmentError)
  })
  it("rejects non-integer or negative size", () => {
    expect(() => parseAttachmentDescriptors([desc({ size: 1.5 })])).toThrowError(AttachmentError)
    expect(() => parseAttachmentDescriptors([desc({ size: -1 })])).toThrowError(AttachmentError)
    expect(() => parseAttachmentDescriptors([desc({ size: "3" as unknown as number })])).toThrowError(AttachmentError)
  })
})

describe("validateAttachments", () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "attachments-test-"))
    mkdirSync(join(cwd, ".zerone-uploads"), { recursive: true })
  })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  async function stage(name: string, bytes: Buffer): Promise<AttachmentDescriptor> {
    writeFileSync(join(cwd, ".zerone-uploads", name), bytes)
    return { id: randomUUID(), name, mime: "application/octet-stream", size: bytes.length, path: `.zerone-uploads/${name}` }
  }

  it("validates a real regular file", async () => {
    const d = await stage("ok.bin", Buffer.from("abc"))
    const out = await validateAttachments(cwd, [d])
    expect(out[0].realSize).toBe(3)
    expect(out[0].absPath).toBe(join(cwd, ".zerone-uploads", "ok.bin"))
  })

  it("rejects absolute paths", async () => {
    await expect(validateAttachments(cwd, [desc({ path: "/etc/passwd" })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("rejects traversal outside uploads dir", async () => {
    await expect(validateAttachments(cwd, [desc({ path: "../agents.yaml" })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/../agents.yaml" })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("rejects paths outside the .zerone-uploads/ prefix and the dir itself", async () => {
    await expect(validateAttachments(cwd, [desc({ path: "src/index.ts" })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads" })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/" })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("rejects null-byte paths", async () => {
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/a\0b" })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("rejects control characters in path even when such a file exists (prompt-injection guard)", async () => {
    const evilName = "evil\nignored.png"
    writeFileSync(join(cwd, ".zerone-uploads", evilName), "x")
    await expect(validateAttachments(cwd, [desc({ path: `.zerone-uploads/${evilName}`, size: 1 })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("rejects when .zerone-uploads itself is a symlink escaping cwd", async () => {
    const outside = mkdtempSync(join(tmpdir(), "att-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "secret")
      rmSync(join(cwd, ".zerone-uploads"), { recursive: true, force: true })
      symlinkSync(outside, join(cwd, ".zerone-uploads"))
      await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/secret.txt", size: 6 })]))
        .rejects.toMatchObject({ code: "invalid_attachment" })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects attachments reached through an intermediate symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "att-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "secret")
      symlinkSync(outside, join(cwd, ".zerone-uploads", "sub"))
      await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/sub/secret.txt", size: 6 })]))
        .rejects.toMatchObject({ code: "invalid_attachment" })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("returns pinned bytes captured at validation time", async () => {
    const d = await stage("bytes.bin", Buffer.from("abc"))
    const out = await validateAttachments(cwd, [d])
    expect(out[0].bytes.toString()).toBe("abc")
  })

  it("rejects non-flat paths (subdirectories)", async () => {
    mkdirSync(join(cwd, ".zerone-uploads", "sub"))
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/sub/x.bin", size: 0 })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("rejects non-canonical paths (dot-segments and double slashes)", async () => {
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/./f.bin", size: 1 })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads//f.bin", size: 1 })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("rejects a >20MB file before reading its bytes", async () => {
    const d = await stage("big.bin", Buffer.alloc(20 * MB + 1))
    // FileHandle 非运行时导出，经实例原型安装 spy
    const probe = await open(join(cwd, ".zerone-uploads", ".spy-probe"), "w")
    const spy = vi.spyOn(Object.getPrototypeOf(probe), "read")
    await probe.close()
    try {
      await expect(validateAttachments(cwd, [d])).rejects.toMatchObject({ code: "upload_limit_exceeded" })
      expect(spy).toHaveBeenCalledTimes(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("stops reading before the aggregate total would exceed 50MB", async () => {
    const descriptors: AttachmentDescriptor[] = []
    for (let i = 0; i < 3; i++) {
      descriptors.push(await stage(`p${i}.bin`, Buffer.alloc(17 * MB)))
    }
    const probe = await open(join(cwd, ".zerone-uploads", ".spy-probe"), "w")
    const spy = vi.spyOn(Object.getPrototypeOf(probe), "read")
    await probe.close()
    try {
      await expect(validateAttachments(cwd, descriptors)).rejects.toMatchObject({ code: "upload_limit_exceeded" })
      expect(spy).toHaveBeenCalledTimes(2) // 17+17=34MB 已读，第三个在读取前拒绝
    } finally {
      spy.mockRestore()
    }
  })

  it("re-checks the single-file limit on the fd's final size (same-inode growth)", async () => {
    // 真文件 21MB，lstat 压报 5（descriptor 同步 5）骗过 lstat 侧检查；
    // fd 终态 21MB 必须在读取前被 413 拒绝，不得先缓冲
    const big = Buffer.alloc(21 * MB)
    const d = await stage("grown.bin", big)
    lstatOverride.reportedSize = 5
    try {
      const probe = await open(join(cwd, ".zerone-uploads", ".spy-probe"), "w")
      const spy = vi.spyOn(Object.getPrototypeOf(probe), "read")
      await probe.close()
      try {
        await expect(validateAttachments(cwd, [{ ...d, size: 5 }]))
          .rejects.toMatchObject({ code: "upload_limit_exceeded" })
        expect(spy).toHaveBeenCalledTimes(0)
      } finally {
        spy.mockRestore()
      }
    } finally {
      lstatOverride.reportedSize = null
    }
  })

  it("bounded read length stays consistent with the accounted size", async () => {
    // 真文件 6MB，lstat 压报 5 → fd 终态 6MB 限额内：恰读 6MB、计量 6MB
    const content = Buffer.alloc(6 * MB, 7)
    const d = await stage("grown2.bin", content)
    lstatOverride.reportedSize = 5
    try {
      const out = await validateAttachments(cwd, [{ ...d, size: 5 }])
      expect(out[0].bytes.length).toBe(6 * MB)
      expect(out[0].realSize).toBe(6 * MB)
      expect(out[0].bytes[0]).toBe(7)
    } finally {
      lstatOverride.reportedSize = null
    }
  })

  it("missing file → attachment_missing (400 contract)", async () => {
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/ghost.bin", size: 1 })]))
      .rejects.toMatchObject({ code: "attachment_missing", path: ".zerone-uploads/ghost.bin" })
  })

  it("directory → invalid_attachment", async () => {
    mkdirSync(join(cwd, ".zerone-uploads", "subdir"))
    await expect(validateAttachments(cwd, [desc({ path: ".zerone-uploads/subdir", size: 0 })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("symlink → invalid_attachment (even to in-dir target)", async () => {
    writeFileSync(join(cwd, ".zerone-uploads", "real.bin"), "real")
    symlinkSync(join(cwd, ".zerone-uploads", "real.bin"), join(cwd, ".zerone-uploads", "link.bin"))
    await expect(validateAttachments(cwd, [
      desc({ path: ".zerone-uploads/link.bin", size: 4 }),
    ])).rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("tampered size → invalid_attachment", async () => {
    const d = await stage("tamper.bin", Buffer.from("12345"))
    await expect(validateAttachments(cwd, [desc({ ...d, size: 4 })]))
      .rejects.toMatchObject({ code: "invalid_attachment" })
  })

  it("more than 10 attachments → upload_limit_exceeded", async () => {
    const list = Array.from({ length: 11 }, () => desc())
    await expect(validateAttachments(cwd, list))
      .rejects.toMatchObject({ code: "upload_limit_exceeded" })
  })

  it("real single-file size > 20MB → upload_limit_exceeded", async () => {
    const d = await stage("big.bin", Buffer.alloc(20 * MB + 1))
    await expect(validateAttachments(cwd, [d]))
      .rejects.toMatchObject({ code: "upload_limit_exceeded" })
  })

  it("aggregate total > 50MB → upload_limit_exceeded", async () => {
    const descriptors: AttachmentDescriptor[] = []
    for (let i = 0; i < 3; i++) {
      descriptors.push(await stage(`p${i}.bin`, Buffer.alloc(17 * MB)))
    }
    await expect(validateAttachments(cwd, descriptors))
      .rejects.toMatchObject({ code: "upload_limit_exceeded" })
  })
})

// fixture：sharp 现场造图；GIF 用字面量（1×1 GIF89a）
async function makePng(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: "#ff0000" } }).png().toBuffer()
}
const TINY_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64",
)

async function stageValidated(
  cwd: string, name: string, bytes: Buffer,
): Promise<ValidatedAttachment> {
  writeFileSync(join(cwd, ".zerone-uploads", name), bytes)
  return {
    descriptor: { id: randomUUID(), name, mime: "application/octet-stream", size: bytes.length, path: `.zerone-uploads/${name}` },
    absPath: join(cwd, ".zerone-uploads", name),
    realSize: bytes.length,
    bytes,
  }
}

describe("composeAttachmentText", () => {
  it("renders image and file lines after the message", () => {
    const text = composeAttachmentText("请总结", [".zerone-uploads/a.png"], [".zerone-uploads/b.pdf"])
    expect(text).toContain("请总结")
    expect(text).toContain("[附件]")
    expect(text).toContain("- 图片 .zerone-uploads/a.png 已直接提供")
    expect(text).toContain("- 文件 .zerone-uploads/b.pdf：请使用 Read 工具读取后再回答")
  })
})

describe("buildAgentInput", () => {
  let cwd: string
  beforeEach(() => {

    cwd = mkdtempSync(join(tmpdir(), "build-input-"))
    mkdirSync(join(cwd, ".zerone-uploads"), { recursive: true })
  })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("pins the validated inode: a post-validation path swap cannot change what gets read", async () => {
    const png = await makePng(4, 4)
    writeFileSync(join(cwd, ".zerone-uploads", "img.png"), png)
    const validated = await validateAttachments(cwd, [
      { id: randomUUID(), name: "img.png", mime: "application/octet-stream", size: png.length, path: ".zerone-uploads/img.png" },
    ])
    // 校验后攻击者把路径换成指向外部文件的 symlink（TOCTOU 复现）
    const outside = mkdtempSync(join(tmpdir(), "att-outside-"))
    try {
      const decoy = join(outside, "decoy.bin")
      writeFileSync(decoy, Buffer.from("not an image at all"))
      rmSync(join(cwd, ".zerone-uploads", "img.png"))
      symlinkSync(decoy, join(cwd, ".zerone-uploads", "img.png"))
      const input = await buildAgentInput("m", validated)
      if (!Array.isArray(input)) throw new Error("expected blocks")
      // 仍使用校验时钉住的原始字节（red PNG），而非换链后的 decoy
      expect(input[1]).toEqual({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("hands the agent a freshly materialized snapshot path instead of the original", async () => {
    const att = await stageValidated(cwd, "doc.pdf", Buffer.from("%PDF-fake"))
    const input = await buildAgentInput("m", [att])
    if (!Array.isArray(input)) throw new Error("expected blocks")
    const text = (input[0] as { type: "text"; text: string }).text
    expect(text).toMatch(/\.zerone-uploads\/snap-[0-9a-f]{8}-doc\.pdf/)
    expect(text).not.toContain(".zerone-uploads/doc.pdf")
  })

  it("snapshot is a real regular file with pinned content, immune to post-validation swap of the original", async () => {
    const png = await makePng(4, 4)
    writeFileSync(join(cwd, ".zerone-uploads", "img.png"), png)
    const validated = await validateAttachments(cwd, [
      { id: randomUUID(), name: "img.png", mime: "application/octet-stream", size: png.length, path: ".zerone-uploads/img.png" },
    ])
    // 校验后把原路径换成指向外部文件的 symlink（review 复现场景：Read 二次打开）
    const outside = mkdtempSync(join(tmpdir(), "att-outside-"))
    try {
      const decoy = join(outside, "decoy.bin")
      writeFileSync(decoy, Buffer.from("OUTSIDE SECRET"))
      rmSync(join(cwd, ".zerone-uploads", "img.png"))
      symlinkSync(decoy, join(cwd, ".zerone-uploads", "img.png"))

      const input = await buildAgentInput("m", validated)
      if (!Array.isArray(input)) throw new Error("expected blocks")
      const text = (input[0] as { type: "text"; text: string }).text
      const m = text.match(/\.zerone-uploads\/(snap-[0-9a-f]{8}-img\.png)/)
      expect(m).not.toBeNull()
      const snapAbs = join(cwd, ".zerone-uploads", m![1])
      const st = lstatSync(snapAbs)
      expect(st.isFile()).toBe(true)
      expect(st.isSymbolicLink()).toBe(false)
      expect(readFileSync(snapAbs).equals(png)).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("returns the message string unchanged for empty attachments", async () => {
    const msg = "hello"
    await expect(buildAgentInput(msg, [])).resolves.toBe(msg)
  })

  it("small PNG → original bytes as image/png block, text first", async () => {
    const png = await makePng(10, 10)
    const att = await stageValidated(cwd, "1.png", png)
    const input = await buildAgentInput("看图", [att])
    if (!Array.isArray(input)) throw new Error("expected blocks")
    expect(input).toHaveLength(2)
    expect(input[0]).toMatchObject({ type: "text" })
    expect((input[0] as { type: "text"; text: string }).text).toMatch(/\.zerone-uploads\/snap-[0-9a-f]{8}-1\.png/)
    expect(input[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
    })
  })

  it("oversized PNG → scaled JPEG q85 in memory, original file untouched", async () => {
    const big = await makePng(2000, 1000)
    const att = await stageValidated(cwd, "big.png", big)
    const input = await buildAgentInput("看大图", [att])
    if (!Array.isArray(input)) throw new Error("expected blocks")
    const image = input.find((b) => b.type === "image")
    if (image?.type !== "image") throw new Error("missing image block")
    const src = image.source as { media_type: string; data: string }
    expect(src.media_type).toBe("image/jpeg")
    const meta = await sharp(Buffer.from(src.data, "base64")).metadata()
    expect(meta.width).toBe(MAX_IMAGE_EDGE)
    expect(meta.height).toBe(768)
    const onDisk = await readFile(att.absPath)
    expect((await sharp(onDisk).metadata()).width).toBe(2000) // 原文件未被修改
  })

  it("JPEG / WebP / GIF decode to their media types", async () => {
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#00ff00" } }).jpeg().toBuffer()
    const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#0000ff" } }).webp().toBuffer()
    const atts = [
      await stageValidated(cwd, "j.jpg", jpeg),
      await stageValidated(cwd, "w.webp", webp),
      await stageValidated(cwd, "g.gif", TINY_GIF),
    ]
    const input = await buildAgentInput("m", atts)
    if (!Array.isArray(input)) throw new Error("expected blocks")
    const media = input.filter((b) => b.type === "image").map(
      (b) => (b as { type: "image"; source: { media_type: string } }).source.media_type,
    )
    expect(media).toEqual(["image/jpeg", "image/webp", "image/gif"])
  })

  it("SVG and truncated (fake) images are treated as normal files", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
    const jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#123456" } }).jpeg().toBuffer()
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length * 0.9))
    const atts = [
      await stageValidated(cwd, "d.svg", svg),
      await stageValidated(cwd, "fake.jpg", truncated),
    ]
    const input = await buildAgentInput("m", atts)
    if (!Array.isArray(input)) throw new Error("expected blocks")
    expect(input).toHaveLength(1) // 只有 text block，无 image block
    const text = (input[0] as { type: "text"; text: string }).text
    expect(text).toMatch(/- 文件 \.zerone-uploads\/snap-[0-9a-f]{8}-d\.svg：请使用 Read 工具读取后再回答/)
    expect(text).toMatch(/- 文件 \.zerone-uploads\/snap-[0-9a-f]{8}-fake\.jpg：请使用 Read 工具读取后再回答/)
  })

  it("mixed: image + normal file → text lists both kinds", async () => {
    const png = await makePng(4, 4)
    const atts = [
      await stageValidated(cwd, "img.png", png),
      await stageValidated(cwd, "doc.pdf", Buffer.from("%PDF-1.4 fake")),
    ]
    const input = await buildAgentInput("m", atts)
    if (!Array.isArray(input)) throw new Error("expected blocks")
    expect(input).toHaveLength(2)
    const text = (input[0] as { type: "text"; text: string }).text
    expect(text).toMatch(/- 图片 \.zerone-uploads\/snap-[0-9a-f]{8}-img\.png 已直接提供/)
    expect(text).toMatch(/- 文件 \.zerone-uploads\/snap-[0-9a-f]{8}-doc\.pdf：请使用 Read 工具读取后再回答/)
  })
})
