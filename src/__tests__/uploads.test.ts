import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  mkdtempSync, rmSync, closeSync, openSync, existsSync,
  readdirSync, writeFileSync, mkdirSync, symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import {
  UPLOADS_DIR, MAX_FILE_COUNT, MAX_FILE_BYTES, MAX_TOTAL_BYTES,
  UploadError, splitExt, sanitizeFilename, allocateDestination,
  processUpload, type UploadedFileMeta,
} from "../uploads.js"
import { MB, multipartStream, bigChunks } from "./helpers/multipart.js"

describe("uploads constants", () => {
  it("exposes the spec limits", () => {
    expect(UPLOADS_DIR).toBe(".zerone-uploads")
    expect(MAX_FILE_COUNT).toBe(10)
    expect(MAX_FILE_BYTES).toBe(20 * 1024 * 1024)
    expect(MAX_TOTAL_BYTES).toBe(50 * 1024 * 1024)
  })
})

describe("splitExt", () => {
  it("splits name.ext", () => expect(splitExt("report.pdf")).toEqual({ stem: "report", ext: ".pdf" }))
  it("keeps only the last extension", () => expect(splitExt("report.tar.gz")).toEqual({ stem: "report.tar", ext: ".gz" }))
  it("no extension → empty ext", () => expect(splitExt("Makefile")).toEqual({ stem: "Makefile", ext: "" }))
  it("dotfile → all stem", () => expect(splitExt(".env")).toEqual({ stem: ".env", ext: "" }))
})

describe("sanitizeFilename", () => {
  it("keeps plain names", () => expect(sanitizeFilename("report.pdf")).toBe("report.pdf"))
  it("keeps CJK names", () => expect(sanitizeFilename("报告.pdf")).toBe("报告.pdf"))
  it("replaces path separators and unsafe chars with _", () => {
    expect(sanitizeFilename("a/b.txt")).toBe("a_b.txt")
    expect(sanitizeFilename("a\\b.txt")).toBe("a_b.txt")
    expect(sanitizeFilename("q?x*.txt")).toBe("q_x_.txt")
  })
  it("replaces control chars", () => expect(sanitizeFilename("a\x00b.pdf")).toBe("a_b.pdf"))
  it("replaces DEL (0x7f) like other control chars", () => {
    expect(sanitizeFilename("a\x7fb.txt")).toBe("a_b.txt")
  })
  it("trims surrounding whitespace", () => expect(sanitizeFilename("  x.pdf ")).toBe("x.pdf"))
  it("empty / . / .. → file", () => {
    expect(sanitizeFilename("")).toBe("file")
    expect(sanitizeFilename(".")).toBe("file")
    expect(sanitizeFilename("..")).toBe("file")
  })
  it("caps byte length at 200 preserving extension", () => {
    const long = "x".repeat(300) + ".pdf"
    const out = sanitizeFilename(long)
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200)
    expect(out.endsWith(".pdf")).toBe(true)
  })
})

describe("allocateDestination", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uploads-test-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("returns the bare name when free and creates nothing until write", async () => {
    const d = await allocateDestination(dir, "report.pdf")
    expect(d.name).toBe("report.pdf")
    expect(d.absPath).toBe(join(dir, "report.pdf"))
    await d.handle.close()
  })

  it("allocates -2 then -3 when names exist", async () => {
    const first = await allocateDestination(dir, "report.pdf"); await first.handle.close()
    const second = await allocateDestination(dir, "report.pdf"); await second.handle.close()
    const third = await allocateDestination(dir, "report.pdf"); await third.handle.close()
    expect(second.name).toBe("report-2.pdf")
    expect(third.name).toBe("report-3.pdf")
  })

  it("no-extension and dotfile names", async () => {
    const a = await allocateDestination(dir, "Makefile"); await a.handle.close()
    const b = await allocateDestination(dir, ".env"); await b.handle.close()
    expect(a.name).toBe("Makefile")
    expect(b.name).toBe(".env")
  })

  it("concurrent allocation of the same desired name yields distinct files", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => allocateDestination(dir, "report.pdf")),
    )
    const names = results.map((r) => r.name)
    expect(new Set(names).size).toBe(5)
    expect([...names].sort()).toEqual(
      ["report-2.pdf", "report-3.pdf", "report-4.pdf", "report-5.pdf", "report.pdf"],
    )
    for (const r of results) await r.handle.close()
    for (const n of names) expect(existsSync(join(dir, n))).toBe(true)
  })

  it("never overwrites an existing file (wx semantics)", async () => {
    const preexisting = join(dir, "taken.txt")
    const fd = openSync(preexisting, "w"); closeSync(fd)
    const d = await allocateDestination(dir, "taken.txt"); await d.handle.close()
    expect(d.name).toBe("taken-2.txt")
    expect(existsSync(preexisting)).toBe(true)
  })
})

describe("UploadError", () => {
  it("carries a stable code", () => {
    const err = new UploadError("invalid_multipart", "bad body")
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("invalid_multipart")
    expect(err.message).toBe("bad body")
  })
})

describe("processUpload", () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "process-upload-")) })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  const uploadsDir = () => join(cwd, ".zerone-uploads")

  it("writes files and returns metadata (id/name/mime/size/path)", async () => {
    const { contentType, body } = multipartStream([
      { filename: "a.pdf", type: "application/pdf", chunks: [Buffer.from("hello")] },
      { filename: "b.txt", type: "text/plain", chunks: [Buffer.from("world!")] },
    ])
    const metas = await processUpload(cwd, body, contentType)
    expect(metas.map((m) => m.path)).toEqual([".zerone-uploads/a.pdf", ".zerone-uploads/b.txt"])
    expect(metas[0]).toMatchObject({ name: "a.pdf", mime: "application/pdf", size: 5 })
    expect(metas[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(readdirSync(uploadsDir()).sort()).toEqual(["a.pdf", "b.txt"])
  })

  it("defaults mime to application/octet-stream when part has no Content-Type", async () => {
    const { contentType, body } = multipartStream([{ filename: "x.bin", chunks: [Buffer.from([0])] }])
    const metas = await processUpload(cwd, body, contentType)
    expect(metas[0].mime).toBe("application/octet-stream")
  })

  it("renames same-name files within one request (-2 suffix)", async () => {
    const { contentType, body } = multipartStream([
      { filename: "dup.pdf", type: "application/pdf", chunks: [Buffer.from("1")] },
      { filename: "dup.pdf", type: "application/pdf", chunks: [Buffer.from("22")] },
    ])
    const metas = await processUpload(cwd, body, contentType)
    expect(metas.map((m) => m.path)).toEqual([".zerone-uploads/dup.pdf", ".zerone-uploads/dup-2.pdf"])
    expect(metas[1].size).toBe(2)
  })

  it("rejects non-multipart content type", async () => {
    const stream = Readable.toWeb(Readable.from([Buffer.from("x")])) as unknown as ReadableStream<Uint8Array>
    await expect(processUpload(cwd, stream, "application/json"))
      .rejects.toMatchObject({ code: "invalid_multipart" })
  })

  it("rejects a request with no file parts", async () => {
    const { contentType, body } = multipartStream([])
    await expect(processUpload(cwd, body, contentType))
      .rejects.toMatchObject({ code: "invalid_multipart" })
  })

  it("rejects more than 10 files and cleans up its own files", async () => {
    // 预置一个既有文件（模拟此前请求的产物，不得被清理）
    mkdirSync(uploadsDir(), { recursive: true })
    writeFileSync(join(uploadsDir(), "keep.pdf"), "keep")
    const parts = Array.from({ length: 11 }, (_, i) => ({
      filename: `f${i}.txt`, type: "text/plain", chunks: [Buffer.from("x")],
    }))
    const { contentType, body } = multipartStream(parts)
    await expect(processUpload(cwd, body, contentType))
      .rejects.toMatchObject({ code: "upload_limit_exceeded" })
    expect(readdirSync(uploadsDir())).toEqual(["keep.pdf"])
  })

  it("rejects when .zerone-uploads is a symlink pointing outside cwd", async () => {
    const outside = mkdtempSync(join(tmpdir(), "uploads-outside-"))
    try {
      symlinkSync(outside, uploadsDir())
      const { contentType, body } = multipartStream([
        { filename: "a.pdf", type: "application/pdf", chunks: [Buffer.from("hello")] },
      ])
      await expect(processUpload(cwd, body, contentType)).rejects.toThrow()
      expect(readdirSync(outside)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects when the uploads dir is swapped to a symlink after the initial check", async () => {
    const outside = mkdtempSync(join(tmpdir(), "uploads-outside-"))
    try {
      const raw = Buffer.from(
        [
          "--testbound",
          'Content-Disposition: form-data; name="files"; filename="a.pdf"',
          "Content-Type: application/pdf",
          "",
          "",
        ].join("\r\n") + "hello\r\n--testbound--\r\n",
      )
      let swapped = false
      // 零水位 web 流：pull 仅在消费者（processUpload 内部的 pipe）真正拉取时触发，
      // 保证换链发生在初检（mkdir+realpath）之后、body 解析之前（toWeb 会无消费者急拉，不可用）
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!swapped) {
            swapped = true
            rmSync(uploadsDir(), { recursive: true, force: true })
            symlinkSync(outside, uploadsDir())
          }
          controller.enqueue(raw)
          controller.close()
        },
      }, { highWaterMark: 0 })
      await expect(
        processUpload(cwd, body, "multipart/form-data; boundary=testbound"),
      ).rejects.toThrow(/escape|symlink/i)
      expect(readdirSync(outside)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("enforces the 20MB single-file limit during streaming and cleans up", async () => {
    const { contentType, body } = multipartStream([
      { filename: "small.txt", type: "text/plain", chunks: [Buffer.from("ok")] },
      { filename: "big.bin", chunks: bigChunks(20 * MB + 1) },
    ])
    await expect(processUpload(cwd, body, contentType))
      .rejects.toMatchObject({ code: "upload_limit_exceeded" })
    expect(readdirSync(uploadsDir())).toEqual([]) // small.txt 也被清理（all-or-none）
  })

  it("enforces the 50MB request-total limit during streaming and cleans up", async () => {
    const part = (n: number) => ({ filename: `p${n}.bin`, chunks: bigChunks(17 * MB) })
    const { contentType, body } = multipartStream([part(1), part(2), part(3)]) // 3×17MB = 51MB，单文件 <20MB
    await expect(processUpload(cwd, body, contentType))
      .rejects.toMatchObject({ code: "upload_limit_exceeded" })
    expect(readdirSync(uploadsDir())).toEqual([])
  })

  it("does not leak orphan files from queued parts after a mid-request failure", async () => {
    const { contentType, body } = multipartStream([
      { filename: "big.bin", chunks: bigChunks(20 * MB + 1) },
      { filename: "trailing.txt", type: "text/plain", chunks: [Buffer.from("t")] },
    ])
    await expect(processUpload(cwd, body, contentType))
      .rejects.toMatchObject({ code: "upload_limit_exceeded" })
    expect(readdirSync(uploadsDir())).toEqual([])
  })

  it("rejects multipart content-type without boundary as invalid_multipart", async () => {
    const stream = Readable.toWeb(Readable.from([Buffer.from("x")])) as unknown as ReadableStream<Uint8Array>
    await expect(processUpload(cwd, stream, "multipart/form-data"))
      .rejects.toMatchObject({ code: "invalid_multipart" })
  })
})
