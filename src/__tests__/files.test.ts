import { describe, it, expect, beforeEach, afterEach } from "vitest"
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

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listDir, ListError } from "../files.js"

describe("listDir", () => {
  let tmpRoot: string

  beforeEach(() => {
    // realpathSync: on macOS, tmpdir() returns "/var/folders/..." but its
    // canonical form is "/private/var/folders/...". Symlink-target resolution
    // uses realpath, so the cwd itself must be canonicalized up-front for
    // in-cwd symlinks to be recognized as in-cwd.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "files-test-")))
    // 构造测试结构：
    // tmpRoot/
    //   agents.yaml
    //   src/
    //     index.ts
    //     router/
    //       agent.ts
    //   outputs/
    //     report.json
    //   inner-link -> outputs  (symlink 在 cwd 内)
    writeFileSync(join(tmpRoot, "agents.yaml"), "agents: []")
    mkdirSync(join(tmpRoot, "src"))
    writeFileSync(join(tmpRoot, "src", "index.ts"), "console.log('hi')")
    mkdirSync(join(tmpRoot, "src", "router"))
    writeFileSync(join(tmpRoot, "src", "router", "agent.ts"), "export {}")
    mkdirSync(join(tmpRoot, "outputs"))
    writeFileSync(join(tmpRoot, "outputs", "report.json"), "{}")
    symlinkSync(join(tmpRoot, "outputs"), join(tmpRoot, "inner-link"))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("lists top-level entries with file/directory type", async () => {
    const result = await listDir(tmpRoot)
    expect(result.path).toBe("")
    const names = result.entries.map((e) => e.name)
    expect(names).toContain("agents.yaml")
    expect(names).toContain("src")
    expect(names).toContain("outputs")
  })

  it("sorts directories before files, then alphabetical", async () => {
    const result = await listDir(tmpRoot)
    const types = result.entries.map((e) => e.type)
    const firstFileIdx = types.indexOf("file")
    const lastDirIdx = types.lastIndexOf("directory")
    // 所有 directory 都在 file 之前
    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx)
    }
  })

  it("includes size and mtime for each entry", async () => {
    const result = await listDir(tmpRoot)
    const yaml = result.entries.find((e) => e.name === "agents.yaml")!
    expect(yaml.size).toBe(10)  // "agents: []" 是 10 字节
    expect(yaml.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("includes mime for files only", async () => {
    const result = await listDir(tmpRoot)
    const yaml = result.entries.find((e) => e.name === "agents.yaml")!
    const src = result.entries.find((e) => e.name === "src")!
    expect(yaml.mime).toBe("text/yaml")
    expect(src.mime).toBeUndefined()
  })

  it("marks symlink as symlink type with target", async () => {
    const result = await listDir(tmpRoot)
    const link = result.entries.find((e) => e.name === "inner-link")!
    expect(link.type).toBe("symlink")
    expect(link.target).toBe("outputs")
  })

  it("supports ?path= to list a subdirectory", async () => {
    const result = await listDir(tmpRoot, { path: "src" })
    expect(result.path).toBe("src")
    const names = result.entries.map((e) => e.name)
    // sort spec = directories before files, then alphabetical
    expect(names).toEqual(["router", "index.ts"])
  })

  it("recursive mode returns entries with relative-to-cwd paths", async () => {
    const result = await listDir(tmpRoot, { recursive: true })
    const names = result.entries.map((e) => e.name)
    expect(names).toContain("src/index.ts")
    expect(names).toContain("src/router/agent.ts")
    expect(names).toContain("outputs/report.json")
  })

  it("recursive mode with depth=1 limits nesting", async () => {
    const result = await listDir(tmpRoot, { recursive: true, depth: 1 })
    const names = result.entries.map((e) => e.name)
    // depth=1 意味着顶层 + 直接子目录的内容（共 2 层）
    expect(names).toContain("src/index.ts")
    expect(names).toContain("src/router")  // 目录本身在，但其内部不再展开
    expect(names).not.toContain("src/router/agent.ts")
  })

  it("does not recurse into symlinked directories (avoid cycles)", async () => {
    const result = await listDir(tmpRoot, { recursive: true })
    const names = result.entries.map((e) => e.name)
    // inner-link 是 symlink，不递归进入（其 target 的内容已经通过 outputs 看到）
    expect(names).not.toContain("inner-link/report.json")
  })

  it("throws ListError('invalid_path') for path traversal", async () => {
    await expect(listDir(tmpRoot, { path: "../etc" })).rejects.toBeInstanceOf(ListError)
    await expect(listDir(tmpRoot, { path: "../etc" })).rejects.toMatchObject({ code: "invalid_path" })
  })

  it("throws ListError('not_found') for missing path", async () => {
    await expect(listDir(tmpRoot, { path: "does-not-exist" })).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("throws ListError('not_directory') when path is a file", async () => {
    await expect(listDir(tmpRoot, { path: "agents.yaml" })).rejects.toMatchObject({
      code: "not_directory",
    })
  })
})
