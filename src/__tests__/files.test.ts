import { describe, it, expect } from "vitest"
import { safeResolve, lookupMimeType } from "../files.js"

describe("safeResolve", () => {
  const cwd = "/tmp/test-cwd"

  it("returns cwd when rel is empty string", () => {
    expect(safeResolve(cwd, "")).toBe(cwd)
  })

  it("resolves a simple relative path", () => {
    expect(safeResolve(cwd, "file.txt")).toBe("/tmp/test-cwd/file.txt")
  })

  it("resolves nested relative path", () => {
    expect(safeResolve(cwd, "sub/dir/file.txt")).toBe("/tmp/test-cwd/sub/dir/file.txt")
  })

  it("normalizes internal .. if result still within cwd", () => {
    expect(safeResolve(cwd, "sub/../file.txt")).toBe("/tmp/test-cwd/file.txt")
  })

  it("rejects .. that escapes cwd (single)", () => {
    expect(safeResolve(cwd, "..")).toBeNull()
  })

  it("rejects ../etc/passwd", () => {
    expect(safeResolve(cwd, "../etc/passwd")).toBeNull()
  })

  it("rejects deeply nested escape attempt", () => {
    expect(safeResolve(cwd, "sub/../../etc/passwd")).toBeNull()
  })

  it("rejects absolute paths", () => {
    expect(safeResolve(cwd, "/etc/passwd")).toBeNull()
  })

  it("rejects paths with null bytes", () => {
    expect(safeResolve(cwd, "file\0.txt")).toBeNull()
  })

  it("rejects paths with null byte at start", () => {
    expect(safeResolve(cwd, "\0evil")).toBeNull()
  })
})

describe("lookupMimeType", () => {
  it("returns text/typescript for .ts", () => {
    expect(lookupMimeType("file.ts")).toBe("text/typescript")
  })

  it("returns application/json for .json", () => {
    expect(lookupMimeType("file.json")).toBe("application/json")
  })

  it("returns text/markdown for .md", () => {
    expect(lookupMimeType("file.md")).toBe("text/markdown")
  })

  it("returns text/yaml for .yaml and .yml", () => {
    expect(lookupMimeType("file.yaml")).toBe("text/yaml")
    expect(lookupMimeType("file.yml")).toBe("text/yaml")
  })

  it("is case-insensitive on extension", () => {
    expect(lookupMimeType("FILE.TS")).toBe("text/typescript")
    expect(lookupMimeType("file.JSON")).toBe("application/json")
  })

  it("returns octet-stream for no extension", () => {
    expect(lookupMimeType("Makefile")).toBe("application/octet-stream")
  })

  it("returns octet-stream for unknown extension", () => {
    expect(lookupMimeType("file.xyz123")).toBe("application/octet-stream")
  })

  it("handles filenames with multiple dots", () => {
    expect(lookupMimeType("archive.tar.gz")).toBe("application/gzip")
  })
})
