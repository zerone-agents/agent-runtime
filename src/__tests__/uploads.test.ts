import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, closeSync, openSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  UPLOADS_DIR, MAX_FILE_COUNT, MAX_FILE_BYTES, MAX_TOTAL_BYTES,
  UploadError, splitExt, sanitizeFilename, allocateDestination,
} from "../uploads.js"

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
