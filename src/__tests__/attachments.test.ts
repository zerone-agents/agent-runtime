import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  AttachmentError, parseAttachmentDescriptors, validateAttachments,
  type AttachmentDescriptor,
} from "../attachments.js"

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
