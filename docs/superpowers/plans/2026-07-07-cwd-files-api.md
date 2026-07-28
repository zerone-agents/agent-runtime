# cwd 文件列表与下载接口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 agent-runtime 新增 `/v1/files` 列表端点与 `/v1/files/content` 流式下载端点，让外部客户端可以通过 HTTP 浏览和下载 cwd 下的文件。

**Architecture:** 自写工具层（`src/files.ts`：路径安全 + 列表 + MIME）+ 路由层（`src/router/files.ts`：Hono 子路由），不引入新依赖。所有路径经 `safeResolve` + `realpath` 双重校验后才能被读取。

**Tech Stack:** TypeScript ESM, Hono 4.x, Node.js 内置 `node:fs` / `node:path` / `node:stream`, Vitest 3.x。

## Global Constraints

- ESM only：所有本地 import 必须用 `.js` 扩展名（即使源文件是 `.ts`）
- Node >= 18（package.json `engines`）
- 不引入新的运行时依赖（`dependencies` 字段保持现状）
- 不修改任何现有路由的行为
- 鉴权机制不变：新端点必须挂在 `/v1/files` 下，自动继承 `/v1/*` 的 `x-api-key` 保护
- TypeScript strict 模式：所有代码必须通过 `npx tsc --noEmit`
- 测试风格遵循 `src/__tests__/` 现有模式：Hono `app.request()`、vitest、不调真实 SDK
- 频繁提交：每个 Task 结束一次 commit，conventional commits 风格（`feat:`、`docs:` 等）
- 安全底线（spec 中明示）：所有 path 参数必须经 `safeResolve`；下载路径再过 `realpath` 防 symlink 逃逸

**Spec:** `docs/superpowers/specs/2026-07-07-cwd-files-api-design.md`

---

## File Structure

| 文件 | 角色 | 创建/修改 |
|---|---|---|
| `src/files.ts` | 工具层：`safeResolve`、`listDir`、`lookupMimeType`、`FileEntry` 类型、`ListError` | 创建 |
| `src/router/files.ts` | Hono 子路由：`GET /`、`GET /content`、`HEAD /content` | 创建 |
| `src/router/index.ts` | 主路由：挂载 `createFilesRouter()` | 修改（加 1 行 import + 1 行 route） |
| `src/__tests__/files.test.ts` | `src/files.ts` 单元测试（含真实临时目录） | 创建 |
| `src/__tests__/router-files.test.ts` | 路由测试（`app.request()`） | 创建 |
| `src/__tests__/auth.test.ts` | 鉴权集成测试（`/v1/files` 受保护） | 修改（追加用例） |
| `README.md` | Endpoints 表新增三行 | 修改 |
| `docs/api/files.md` | 完整 API 文档 | 创建 |

---

## Task 1: 工具层基础（safeResolve + lookupMimeType + 类型）

**Files:**
- Create: `src/files.ts`
- Test: `src/__tests__/files.test.ts`

**Interfaces:**
- Produces: `safeResolve(cwd, rel) => string | null`、`lookupMimeType(filename) => string`、`FileEntry` 类型（供后续 Task 使用）

- [ ] **Step 1: 写失败测试**

创建 `src/__tests__/files.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/__tests__/files.test.ts`
Expected: FAIL，错误信息提示 `Cannot find module '../files.js'` 或类似。

- [ ] **Step 3: 实现最小代码**

创建 `src/files.ts`：

```ts
/**
 * cwd 文件接口的工具层。
 *
 * 提供：
 *   - safeResolve: 路径安全解析（防 traversal、绝对路径、null byte）
 *   - lookupMimeType: 扩展名到 MIME 的查表
 *   - FileEntry: 列表条目类型
 *
 * 详见 docs/superpowers/specs/2026-07-07-cwd-files-api-design.md。
 */

import { resolve, isAbsolute, relative } from "node:path"

export interface FileEntry {
  /** 顶层模式=文件名；递归模式=相对 cwd 的路径（用 / 分隔） */
  name: string
  type: "file" | "directory" | "symlink" | "other"
  /** 字节数；目录与 broken symlink 为 0 */
  size: number
  /** ISO 8601 格式 */
  mtime: string
  /** 仅 file 类型返回 */
  mime?: string
  /** 仅 symlink 且 target 解析后仍在 cwd 内时返回 */
  target?: string
}

/**
 * 解析相对路径为绝对路径，拒绝一切 escape 尝试。
 *
 * 拒绝：
 *   - 含 null byte
 *   - 绝对路径（如 /etc/passwd）
 *   - 解析后落在 cwd 之外（如 ../、sub/../../）
 *
 * 返回 null 表示输入不安全；调用方应回 400。
 */
export function safeResolve(cwd: string, rel: string): string | null {
  if (rel.includes("\0")) return null
  if (isAbsolute(rel)) return null
  const abs = resolve(cwd, rel)
  const relBack = relative(cwd, abs)
  if (relBack === ".." || relBack.startsWith("../")) return null
  // relBack === "" 表示 abs === cwd 本身，合法
  return abs
}

const MIME_TABLE: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".xml": "application/xml",
  ".sh": "application/x-sh",
}

const DEFAULT_MIME = "application/octet-stream"

/**
 * 根据文件名扩展名推断 MIME。
 * 大小写不敏感；未知扩展名或无扩展名返回 application/octet-stream。
 */
export function lookupMimeType(filename: string): string {
  const dotIdx = filename.lastIndexOf(".")
  if (dotIdx < 0) return DEFAULT_MIME
  const ext = filename.slice(dotIdx).toLowerCase()
  return MIME_TABLE[ext] ?? DEFAULT_MIME
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/__tests__/files.test.ts`
Expected: PASS，所有用例通过。

- [ ] **Step 5: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/files.ts src/__tests__/files.test.ts
git commit -m "feat(files): add safeResolve and lookupMimeType utilities"
```

---

## Task 2: listDir 函数（列表逻辑）

**Files:**
- Modify: `src/files.ts`
- Test: `src/__tests__/files.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `safeResolve`、`lookupMimeType`、`FileEntry`
- Produces: `listDir(cwd, opts) => Promise<{path, entries}>`、`ListError` 类（供 Task 3 路由层 catch）

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/files.test.ts` 末尾追加：

```ts
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listDir, ListError } from "../files.js"

describe("listDir", () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "files-test-"))
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
    expect(yaml.size).toBe(11)  // "agents: []" 是 11 字节
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
    expect(names).toEqual(["index.ts", "router"])
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
```

并在 import 区追加：

```ts
import { beforeEach, afterEach } from "vitest"
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/__tests__/files.test.ts`
Expected: FAIL，`listDir` 和 `ListError` 未导出。

- [ ] **Step 3: 实现 listDir**

在 `src/files.ts` 末尾追加：

```ts
import { readdir, lstat, realpath, stat } from "node:fs/promises"
import { join } from "node:path"

export type ListErrorCode = "invalid_path" | "not_found" | "not_directory"

export class ListError extends Error {
  constructor(public code: ListErrorCode, message: string) {
    super(message)
    this.name = "ListError"
  }
}

export interface ListOptions {
  /** 相对 cwd 的子目录路径，默认 ""（cwd 根） */
  path?: string
  /** 是否递归整棵子树，默认 false */
  recursive?: boolean
  /** 限制递归深度（仅 recursive=true 生效；不填=无限）
   *  depth=N 表示展开 N 层子目录（共 N+1 层 entries）
   */
  depth?: number
}

export interface ListResult {
  path: string
  entries: FileEntry[]
}

/**
 * 列出 cwd（或其子目录）下的文件与目录。
 *
 * 抛出 ListError：
 *   - invalid_path: 路径非法（traversal / 绝对路径 / null byte）
 *   - not_found: 路径不存在
 *   - not_directory: 路径存在但不是目录
 */
export async function listDir(cwd: string, opts: ListOptions = {}): Promise<ListResult> {
  const rel = opts.path ?? ""
  const abs = safeResolve(cwd, rel)
  if (abs === null) {
    throw new ListError("invalid_path", "Invalid path")
  }

  const info = await stat(abs).catch(() => null)
  if (info === null) {
    throw new ListError("not_found", "Directory not found")
  }
  if (!info.isDirectory()) {
    throw new ListError("not_directory", "Not a directory")
  }

  const entries: FileEntry[] = []
  await walkDir(cwd, abs, opts.recursive === true, opts.depth, 0, entries)

  // 排序：directory 优先，然后按 name 字典序（区分大小写）
  entries.sort((a, b) => {
    const aIsDir = a.type === "directory"
    const bIsDir = b.type === "directory"
    if (aIsDir && !bIsDir) return -1
    if (!aIsDir && bIsDir) return 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  return { path: rel, entries }
}

/**
 * 递归遍历目录，把每个 entry（按相对 cwd 的路径命名）推入 out 数组。
 *
 * currentDepth 语义：
 *   - 0: 起始目录的直接 entries
 *   - N: 已经递归了 N 层子目录后到达的目录的 entries
 *
 * depth 限制：递归前检查 currentDepth+1 是否超过 maxDepth。
 */
async function walkDir(
  cwd: string,
  dirAbs: string,
  recursive: boolean,
  maxDepth: number | undefined,
  currentDepth: number,
  out: FileEntry[],
): Promise<void> {
  let dirents
  try {
    dirents = await readdir(dirAbs, { withFileTypes: true })
  } catch {
    return // 跳过不可读子目录（与现有 skills.ts 的容错策略一致）
  }

  for (const dirent of dirents) {
    const entryAbs = join(dirAbs, dirent.name)
    const entryRel = toForwardSlash(relative(cwd, entryAbs))

    const lstatInfo = await lstat(entryAbs).catch(() => null)
    if (lstatInfo === null) continue

    const entry: FileEntry = {
      name: entryRel,
      type: entryType(dirent, lstatInfo),
      size: lstatInfo.size,
      mtime: lstatInfo.mtime.toISOString(),
    }

    // symlink: 尝试解析 target，仅当 target 仍在 cwd 内时记录
    if (lstatInfo.isSymbolicLink()) {
      const resolved = await realpath(entryAbs).catch(() => null)
      if (resolved !== null) {
        const resolvedRel = relative(cwd, resolved)
        if (resolvedRel !== ".." && !resolvedRel.startsWith("../") && resolvedRel !== "") {
          entry.target = toForwardSlash(resolvedRel)
        }
      }
    }

    // file: 加上 MIME
    if (entry.type === "file") {
      entry.mime = lookupMimeType(dirent.name)
    }

    out.push(entry)

    // 递归：仅对真实目录（非 symlink），避免循环
    if (
      recursive &&
      entry.type === "directory" &&
      !lstatInfo.isSymbolicLink()
    ) {
      // depth 限制：currentDepth+1 表示要进入下一层
      if (maxDepth === undefined || currentDepth + 1 <= maxDepth) {
        await walkDir(cwd, entryAbs, true, maxDepth, currentDepth + 1, out)
      }
    }
  }
}

function entryType(dirent: any, lstat: any): FileEntry["type"] {
  if (lstat.isSymbolicLink()) return "symlink"
  if (dirent.isDirectory()) return "directory"
  if (dirent.isFile()) return "file"
  return "other"
}

/** 把 Windows 反斜杠路径转成 URL 友好的正斜杠 */
function toForwardSlash(p: string): string {
  return p.split(/[\\/]/).join("/")
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/__tests__/files.test.ts`
Expected: PASS，所有 listDir 用例通过。

- [ ] **Step 5: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/files.ts src/__tests__/files.test.ts
git commit -m "feat(files): add listDir with recursive and depth support"
```

---

## Task 3: 列表路由（GET /）

**Files:**
- Create: `src/router/files.ts`
- Test: `src/__tests__/router-files.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `listDir`、`ListError`
- Produces: `createFilesRouter(cwd?: string) => Hono`，挂载 `GET /` 端点

- [ ] **Step 1: 写失败测试**

创建 `src/__tests__/router-files.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFilesRouter } from "../router/files.js"

describe("Files Router", () => {
  let tmpRoot: string
  let app: Hono

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "router-files-test-"))
    writeFileSync(join(tmpRoot, "agents.yaml"), "agents: []")
    writeFileSync(join(tmpRoot, "README.md"), "# hi")
    mkdirSync(join(tmpRoot, "src"))
    writeFileSync(join(tmpRoot, "src", "index.ts"), "console.log('hi')")
    mkdirSync(join(tmpRoot, "src", "router"))
    writeFileSync(join(tmpRoot, "src", "router", "agent.ts"), "export {}")

    app = new Hono()
    app.route("/v1/files", createFilesRouter(tmpRoot))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe("GET /v1/files/", () => {
    it("returns top-level entries", async () => {
      const res = await app.request("http://localhost/v1/files/")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe("")
      const names = body.entries.map((e: any) => e.name)
      expect(names).toContain("agents.yaml")
      expect(names).toContain("README.md")
      expect(names).toContain("src")
    })

    it("supports ?path= to list subdirectory", async () => {
      const res = await app.request("http://localhost/v1/files/?path=src")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe("src")
      const names = body.entries.map((e: any) => e.name)
      expect(names).toEqual(["index.ts", "router"])
    })

    it("supports ?recursive=true with nested paths", async () => {
      const res = await app.request("http://localhost/v1/files/?recursive=true")
      expect(res.status).toBe(200)
      const body = await res.json()
      const names = body.entries.map((e: any) => e.name)
      expect(names).toContain("src/index.ts")
      expect(names).toContain("src/router/agent.ts")
    })

    it("supports ?recursive=true&depth=1", async () => {
      const res = await app.request(
        "http://localhost/v1/files/?recursive=true&depth=1",
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      const names = body.entries.map((e: any) => e.name)
      expect(names).toContain("src/index.ts")
      expect(names).toContain("src/router")
      expect(names).not.toContain("src/router/agent.ts")
    })

    it("returns 404 for missing path", async () => {
      const res = await app.request("http://localhost/v1/files/?path=does-not-exist")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Directory not found")
    })

    it("returns 400 when path is a file", async () => {
      const res = await app.request("http://localhost/v1/files/?path=agents.yaml")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Not a directory")
    })

    it("returns 400 for path traversal attempt", async () => {
      const res = await app.request("http://localhost/v1/files/?path=../etc")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Invalid path")
    })

    it("returns 400 for invalid depth (non-numeric)", async () => {
      const res = await app.request("http://localhost/v1/files/?recursive=true&depth=abc")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Invalid depth parameter")
    })

    it("returns 400 for negative depth", async () => {
      const res = await app.request("http://localhost/v1/files/?recursive=true&depth=-1")
      expect(res.status).toBe(400)
    })
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/__tests__/router-files.test.ts`
Expected: FAIL，`createFilesRouter` 未定义。

- [ ] **Step 3: 实现路由**

创建 `src/router/files.ts`：

```ts
import { Hono } from "hono"
import { listDir, ListError } from "../files.js"

/**
 * 创建 files 路由。cwd 默认为 process.cwd()，测试时可显式传入临时目录。
 *
 * 端点：
 *   GET  /              列表（?path & ?recursive & ?depth）
 *   GET  /content       单文件下载（Task 4 实现）
 *   HEAD /content       单文件元数据（Task 4 实现）
 */
export function createFilesRouter(cwd: string = process.cwd()): Hono {
  const router = new Hono()

  router.get("/", async (c) => {
    const path = c.req.query("path") ?? ""
    const recursive = c.req.query("recursive") === "true"
    const depthStr = c.req.query("depth")
    const depth =
      depthStr === undefined || depthStr === "" ? undefined : Number(depthStr)

    if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
      return c.json({ error: "Invalid depth parameter" }, 400)
    }

    try {
      const result = await listDir(cwd, { path, recursive, depth })
      return c.json(result)
    } catch (err) {
      if (err instanceof ListError) {
        const status = err.code === "not_found" ? 404 : 400
        return c.json({ error: err.message }, status)
      }
      throw err
    }
  })

  return router
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/__tests__/router-files.test.ts`
Expected: PASS，所有列表端点用例通过。

- [ ] **Step 5: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/router/files.ts src/__tests__/router-files.test.ts
git commit -m "feat(files): add GET /v1/files list endpoint"
```

---

## Task 4: 内容下载端点（GET /content + HEAD /content，无 Range）

**Files:**
- Modify: `src/router/files.ts`
- Test: `src/__tests__/router-files.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `safeResolve`、`lookupMimeType`
- Produces: `GET /content` 和 `HEAD /content` 端点

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/router-files.test.ts` 末尾追加：

```ts
describe("Files Router /content", () => {
  let tmpRoot: string
  let app: Hono

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "router-files-content-test-"))
    writeFileSync(join(tmpRoot, "hello.txt"), "Hello, World!")
    writeFileSync(join(tmpRoot, "data.json"), JSON.stringify({ ok: true }))
    mkdirSync(join(tmpRoot, "subdir"))
    // symlink 逃出 cwd：指向 tmpRoot 的父目录
    symlinkSync(tmpRoot, join(tmpRoot, "self-out"), "file")
    // symlink 逃出 cwd：指向 tmpRoot 的父目录
    symlinkSync(join(tmpRoot, ".."), join(tmpRoot, "escape"), "dir")

    app = new Hono()
    app.route("/v1/files", createFilesRouter(tmpRoot))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe("GET /v1/files/content", () => {
    it("streams file content with correct headers", async () => {
      const res = await app.request("http://localhost/v1/files/content?path=hello.txt")
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe("text/plain")
      expect(res.headers.get("Content-Disposition")).toContain("hello.txt")
      expect(res.headers.get("Content-Length")).toBe("13")
      expect(res.headers.get("Accept-Ranges")).toBe("bytes")
      expect(res.headers.get("Last-Modified")).toBeTruthy()
      const body = await res.text()
      expect(body).toBe("Hello, World!")
    })

    it("returns correct Content-Type for json", async () => {
      const res = await app.request("http://localhost/v1/files/content?path=data.json")
      expect(res.headers.get("Content-Type")).toBe("application/json")
    })

    it("handles URL-encoded filenames", async () => {
      writeFileSync(join(tmpRoot, "中文.txt"), "你好")
      const res = await app.request(
        "http://localhost/v1/files/content?path=" + encodeURIComponent("中文.txt"),
      )
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toBe("你好")
      expect(res.headers.get("Content-Disposition")).toContain("UTF-8''")
    })
  })

  describe("HEAD /v1/files/content", () => {
    it("returns same headers as GET but empty body", async () => {
      const res = await app.request("http://localhost/v1/files/content?path=hello.txt", {
        method: "HEAD",
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe("text/plain")
      expect(res.headers.get("Content-Length")).toBe("13")
      expect(res.headers.get("Accept-Ranges")).toBe("bytes")
      const body = await res.text()
      expect(body).toBe("")
    })
  })

  describe("error handling", () => {
    it("returns 400 for path traversal", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=../etc/passwd",
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Invalid path")
    })

    it("returns 400 for absolute path", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=" + encodeURIComponent("/etc/passwd"),
      )
      expect(res.status).toBe(400)
    })

    it("returns 400 for null byte", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=evil%00.txt",
      )
      expect(res.status).toBe(400)
    })

    it("returns 400 when path is a directory", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=subdir",
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Not a file")
    })

    it("returns 404 for missing file", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=does-not-exist.txt",
      )
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("File not found")
    })

    it("returns 400 when symlink escapes cwd", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=escape",
      )
      expect(res.status).toBe(400)
    })
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/__tests__/router-files.test.ts`
Expected: FAIL，`/content` 端点不存在（404）。

- [ ] **Step 3: 实现内容下载**

修改 `src/router/files.ts`，在 `router.get("/")` 之后追加：

```ts
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { realpath } from "node:fs/promises"
import { Readable } from "node:stream"
import { basename } from "node:path"
import type { Context } from "hono"
import { safeResolve, lookupMimeType } from "../files.js"
```

（注意：上面 `safeResolve` 和 `lookupMimeType` 已在 Task 3 import，这里只是补充 fs 相关。最终 import 区合并如下，避免重复：）

```ts
import { Hono } from "hono"
import type { Context } from "hono"
import { createReadStream } from "node:fs"
import { stat, realpath } from "node:fs/promises"
import { Readable } from "node:stream"
import { basename } from "node:path"
import { listDir, ListError, safeResolve, lookupMimeType } from "../files.js"
```

然后在 `createFilesRouter` 内部、`router.get("/")` 之后追加：

```ts
  router.get("/content", async (c) => handleContent(c, cwd, false))
  router.head("/content", async (c) => handleContent(c, cwd, true))

  return router
}

/**
 * 处理文件内容下载（GET 拉流，HEAD 仅返回头）。
 *
 * 安全检查链：
 *   1. safeResolve(cwd, rel) → 防 traversal / 绝对路径 / null byte
 *   2. realpath(abs) → 防 symlink 逃逸；解析后路径必须仍在 cwd 内
 *   3. stat → 确认是普通文件
 */
async function handleContent(c: Context, cwd: string, headOnly: boolean) {
  const rel = c.req.query("path") ?? ""
  const abs = safeResolve(cwd, rel)
  if (abs === null) {
    return c.json({ error: "Invalid path" }, 400)
  }

  // realpath 二次校验（防 symlink 逃逸）
  const realAbs = await realpath(abs).catch(() => null)
  if (realAbs === null) {
    return c.json({ error: "File not found" }, 404)
  }
  const realRel = relative(cwd, realAbs)
  if (realRel === ".." || realRel.startsWith("../")) {
    return c.json({ error: "Invalid path" }, 400)
  }

  const info = await stat(realAbs).catch(() => null)
  if (info === null) {
    return c.json({ error: "File not found" }, 404)
  }
  if (!info.isFile()) {
    return c.json({ error: "Not a file" }, 400)
  }

  const base = basename(realAbs)
  const mime = lookupMimeType(base)
  // RFC 5987 编码文件名，处理中文/特殊字符
  const encodedFilename = encodeURIComponent(base)

  c.header("Content-Type", mime)
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodedFilename}`)
  c.header("Content-Length", String(info.size))
  c.header("Accept-Ranges", "bytes")
  c.header("Last-Modified", info.mtime.toUTCString())

  if (headOnly) {
    return c.body(null)
  }

  // 流式响应：Node Readable → Web ReadableStream
  const stream = createReadStream(realAbs)
  return c.body(Readable.toWeb(stream) as ReadableStream)
}
```

补一行 import：

```ts
import { relative } from "node:path"
```

（合并到现有 `node:path` import：`import { basename, relative } from "node:path"`）

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/__tests__/router-files.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/router/files.ts src/__tests__/router-files.test.ts
git commit -m "feat(files): add GET/HEAD /v1/files/content streaming endpoint"
```

---

## Task 5: Range 请求支持

**Files:**
- Modify: `src/router/files.ts`
- Test: `src/__tests__/router-files.test.ts`

**Interfaces:**
- 扩展 Task 4 的 `handleContent`，识别 `Range: bytes=START-END` 请求头

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/router-files.test.ts` 的 `Files Router /content` describe 块内追加：

```ts
  describe("Range requests", () => {
    beforeEach(() => {
      // 写一个 100 字节的固定内容文件：0123456789 重复 10 次
      const content = "0123456789".repeat(10)
      writeFileSync(join(tmpRoot, "rangeable.dat"), content)
    })

    it("returns 206 with Content-Range for bytes=0-9", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { headers: { Range: "bytes=0-9" } },
      )
      expect(res.status).toBe(206)
      expect(res.headers.get("Content-Length")).toBe("10")
      expect(res.headers.get("Content-Range")).toBe("bytes 0-9/100")
      expect(res.headers.get("Accept-Ranges")).toBe("bytes")
      const body = await res.text()
      expect(body).toBe("0123456789")
    })

    it("returns 206 for middle range bytes=10-19", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { headers: { Range: "bytes=10-19" } },
      )
      expect(res.status).toBe(206)
      expect(res.headers.get("Content-Range")).toBe("bytes 10-19/100")
      const body = await res.text()
      expect(body).toBe("0123456789")
    })

    it("supports suffix range bytes=-10 (last 10 bytes)", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { headers: { Range: "bytes=-10" } },
      )
      expect(res.status).toBe(206)
      expect(res.headers.get("Content-Range")).toBe("bytes 90-99/100")
      const body = await res.text()
      expect(body).toBe("0123456789")
    })

    it("supports open-ended range bytes=90-", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { headers: { Range: "bytes=90-" } },
      )
      expect(res.status).toBe(206)
      expect(res.headers.get("Content-Range")).toBe("bytes 90-99/100")
      expect(res.headers.get("Content-Length")).toBe("10")
    })

    it("clamps end beyond file size", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { headers: { Range: "bytes=90-200" } },
      )
      expect(res.status).toBe(206)
      expect(res.headers.get("Content-Range")).toBe("bytes 90-99/100")
      expect(res.headers.get("Content-Length")).toBe("10")
    })

    it("returns 416 for start beyond file size", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { headers: { Range: "bytes=200-300" } },
      )
      expect(res.status).toBe(416)
      expect(res.headers.get("Content-Range")).toBe("bytes */100")
      const body = await res.json()
      expect(body.error).toBe("Range not satisfiable")
    })

    it("falls back to 200 full file for multi-range request", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { headers: { Range: "bytes=0-9,20-29" } },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Length")).toBe("100")
      const body = await res.text()
      expect(body.length).toBe(100)
    })

    it("HEAD with Range returns 206 headers without body", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=rangeable.dat",
        { method: "HEAD", headers: { Range: "bytes=0-9" } },
      )
      expect(res.status).toBe(206)
      expect(res.headers.get("Content-Range")).toBe("bytes 0-9/100")
      expect(res.headers.get("Content-Length")).toBe("10")
      const body = await res.text()
      expect(body).toBe("")
    })
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/__tests__/router-files.test.ts`
Expected: FAIL，Range 用例都返回 200 全文。

- [ ] **Step 3: 实现 Range 解析**

修改 `src/router/files.ts` 中的 `handleContent` 函数。在 `if (headOnly) { return c.body(null) }` 之前插入 Range 处理逻辑：

```ts
  // 检查 Range 头
  const rangeHeader = c.req.header("Range")
  if (rangeHeader && rangeHeader.startsWith("bytes=")) {
    const rangeSpec = rangeHeader.slice(6).trim()

    // 多段 Range（含逗号）：回退为 200 全文（业界惯例）
    if (!rangeSpec.includes(",")) {
      const match = rangeSpec.match(/^(\d*)-(\d*)$/)
      if (match) {
        const [, startStr, endStr] = match
        const size = info.size

        let start: number
        let end: number

        if (startStr === "" && endStr === "") {
          // bytes=- 无效，回退全文
        } else if (startStr === "") {
          // suffix: bytes=-N → 最后 N 字节
          const suffixLen = parseInt(endStr, 10)
          if (Number.isNaN(suffixLen) || suffixLen <= 0) {
            return rangeNotSatisfiable(c, size)
          }
          start = Math.max(0, size - suffixLen)
          end = size - 1
          return sendRangeResponse(c, realAbs, start, end, size, headOnly)
        } else if (endStr === "") {
          // bytes=N- → 从 N 到末尾
          start = parseInt(startStr, 10)
          if (Number.isNaN(start) || start >= size) {
            return rangeNotSatisfiable(c, size)
          }
          end = size - 1
          return sendRangeResponse(c, realAbs, start, end, size, headOnly)
        } else {
          start = parseInt(startStr, 10)
          end = parseInt(endStr, 10)
          if (
            Number.isNaN(start) ||
            Number.isNaN(end) ||
            start > end ||
            start >= size
          ) {
            return rangeNotSatisfiable(c, size)
          }
          // 钳制 end 到文件大小内
          if (end >= size) end = size - 1
          return sendRangeResponse(c, realAbs, start, end, size, headOnly)
        }
      }
    }
    // 如果没匹配上（语法错或未处理分支），继续走 200 全文逻辑
  }
```

然后在 `src/router/files.ts` 末尾追加两个辅助函数：

```ts
/**
 * 发送 206 Partial Content 响应。
 */
function sendRangeResponse(
  c: Context,
  absPath: string,
  start: number,
  end: number,
  size: number,
  headOnly: boolean,
) {
  const contentLength = end - start + 1
  c.header("Content-Length", String(contentLength))
  c.header("Content-Range", `bytes ${start}-${end}/${size}`)

  if (headOnly) {
    return c.body(null, 206)
  }

  const stream = createReadStream(absPath, { start, end })
  return c.body(Readable.toWeb(stream) as ReadableStream, 206)
}

/**
 * 发送 416 Range Not Satisfiable 响应。
 */
function rangeNotSatisfiable(c: Context, size: number) {
  c.header("Content-Range", `bytes */${size}`)
  return c.json({ error: "Range not satisfiable" }, 416)
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/__tests__/router-files.test.ts`
Expected: PASS，所有 Range 用例通过。

- [ ] **Step 5: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/router/files.ts src/__tests__/router-files.test.ts
git commit -m "feat(files): add HTTP Range support for /v1/files/content"
```

---

## Task 6: 挂载路由 + 鉴权集成测试

**Files:**
- Modify: `src/router/index.ts`
- Modify: `src/__tests__/auth.test.ts`

**Interfaces:**
- 在 `createApp` 中挂载 `createFilesRouter()`，自动继承 `/v1/*` 鉴权

- [ ] **Step 1: 挂载路由**

修改 `src/router/index.ts`：

```ts
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { RuntimeConfig } from "../config.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import { createHealthRouter, createMetricsRouter } from "./health.js"
import { createAgentRouter } from "./agent.js"
import { createSessionRouter } from "./session.js"
import { createFilesRouter } from "./files.js"
import { createAuthMiddleware } from "../auth.js"

export function createApp(config: RuntimeConfig, registry: AgentRegistry, metrics: MetricsCollector) {
  const app = new Hono()

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  app.route("/health", createHealthRouter(registry))

  const apiKey = process.env.OPENAGENT_HTTP_API_KEY ?? config.auth?.apiKey
  if (apiKey) {
    app.use("/v1/*", createAuthMiddleware(apiKey))
  }

  app.route("/v1/metrics", createMetricsRouter(metrics))
  app.route("/v1/agents", createAgentRouter(registry, metrics))
  app.route("/v1/sessions", createSessionRouter())
  app.route("/v1/files", createFilesRouter())

  return app
}
```

（实际只是加 1 行 import 和 1 行 `app.route`）

- [ ] **Step 2: 写鉴权集成测试**

在 `src/__tests__/auth.test.ts` 的 `createApp auth integration` describe 块内、最后一个 `it` 之后追加：

```ts
  it("Key configured, GET /v1/files without header → 401", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/files")
    expect(res.status).toBe(401)
  })

  it("Key configured, GET /v1/files with correct key → 200", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/files", {
      headers: { "x-api-key": "secret-key" },
    })
    expect(res.status).toBe(200)
  })

  it("Key configured, GET /v1/files/content without header → 401", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request(
      "http://localhost/v1/files/content?path=agents.yaml",
    )
    expect(res.status).toBe(401)
  })
```

- [ ] **Step 3: 运行所有测试**

Run: `npx vitest run`
Expected: PASS，所有现有测试 + 新增测试全部通过。

- [ ] **Step 4: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/router/index.ts src/__tests__/auth.test.ts
git commit -m "feat(files): mount /v1/files router with auth integration"
```

---

## Task 7: 文档（README + docs/api/files.md）

**Files:**
- Modify: `README.md`
- Create: `docs/api/files.md`

- [ ] **Step 1: 更新 README endpoints 表**

在 `README.md` 的 `### Endpoints` 表格中、`| DELETE | /v1/sessions/:id | Delete session |` 之后追加三行：

```markdown
| `GET` | `/v1/files` | List files in cwd (`?path`、`?recursive`、`?depth`) |
| `GET` | `/v1/files/content` | Download a file (`?path=`) |
| `HEAD` | `/v1/files/content` | File headers only (`?path=`) |
```

并在 `README.md` 末尾、`## License` 之前追加 "File Browsing" 段落：

```markdown
## File Browsing

`/v1/files` exposes the runtime's working directory over HTTP. Useful for debugging and observation by external clients (frontend consoles, ops dashboards).

**Trust model:** any caller with a valid API key has full read access to everything under cwd — including `agents.yaml`, `.env`, and any secrets. Configure `OPENAGENT_HTTP_API_KEY` before deploying to production.

### List files

```bash
# Top-level entries
curl http://localhost:3000/v1/files

# Subdirectory
curl "http://localhost:3000/v1/files?path=src"

# Recursive tree (limit depth to 2 levels)
curl "http://localhost:3000/v1/files?recursive=true&depth=2"
```

### Download a file

```bash
# Full file
curl "http://localhost:3000/v1/files/content?path=outputs/report.json" -o report.json

# Range request (first 100 bytes)
curl -H "Range: bytes=0-99" \
     "http://localhost:3000/v1/files/content?path=logs/app.log" -o partial.log

# HEAD to inspect size/type without downloading body
curl -I "http://localhost:3000/v1/files/content?path=outputs/report.json"
```

See [`docs/api/files.md`](docs/api/files.md) for full API reference.
```

- [ ] **Step 2: 创建 docs/api/files.md**

```bash
touch docs/api/files.md
```

写入以下内容（参考 `docs/api/agent-detail.md` 的中文文档风格）：

````markdown
# Files API

`GET /v1/files` 系列 —— 对外暴露 runtime 工作目录（cwd）下的文件清单和单文件下载。

用于运维 / 调试 / 控制台展示——让外部客户端通过 HTTP 浏览 agent 的工作区，无需 SSH。

> **安全提示**：任何持有有效 API key 的调用方都可以读取 cwd 下的**全部**内容，包括 `agents.yaml`、`.env`、MCP server 凭证。生产部署前必须配置 `OPENAGENT_HTTP_API_KEY`。

---

## 端点一览

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/files` | 列出 cwd 下的文件与目录 |
| `GET` | `/v1/files/content` | 单文件流式下载（支持 Range） |
| `HEAD` | `/v1/files/content` | 单文件元数据（响应头，无 body） |

所有端点：
- 受 `/v1/*` 的 `x-api-key` 鉴权保护（如配置）
- 路径参数 `path` 是相对 cwd 的子路径，禁止 `..` 逃逸、绝对路径、null byte
- cwd 内的 symlink 若解析后逃出 cwd，会返回 400 拒绝

---

## `GET /v1/files`

### Query 参数

| 参数 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `path` | string | `""`（cwd 根） | 相对 cwd 的子目录路径 |
| `recursive` | `"true"` \| `"false"` | `false` | 是否递归整棵子树 |
| `depth` | number | 不限 | 限制递归深度（仅 `recursive=true` 时生效）；`depth=N` 表示展开 N 层子目录 |

### 响应（200）

```json
{
  "path": "",
  "entries": [
    {
      "name": "agents.yaml",
      "type": "file",
      "size": 482,
      "mtime": "2026-07-07T10:00:00.000Z",
      "mime": "text/yaml"
    },
    {
      "name": "src",
      "type": "directory",
      "size": 0,
      "mtime": "2026-07-07T09:30:00.000Z"
    },
    {
      "name": "outputs-link",
      "type": "symlink",
      "size": 0,
      "mtime": "2026-07-07T09:30:00.000Z",
      "target": "outputs"
    }
  ]
}
```

### Entry 字段

| 字段 | 类型 | 必返回 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 顶层模式=文件名；递归模式=相对 cwd 的路径（用 `/` 分隔） |
| `type` | `"file"` \| `"directory"` \| `"symlink"` \| `"other"` | ✅ | `other` 用于 FIFO/socket 等非常规类型 |
| `size` | number | ✅ | 字节数；目录与 broken symlink 为 `0` |
| `mtime` | string (ISO 8601) | ✅ | 最后修改时间 |
| `mime` | string | 仅 file | 由扩展名推断 |
| `target` | string | 仅 symlink 且 target 解析后仍在 cwd 内 | 链接目标的相对路径 |

### 排序规则

entries 数组排序稳定：**directory 优先 → name 字典序（区分大小写）**。

### 错误响应

| 状态 | 触发 | 响应体 |
|---|---|---|
| 400 | 路径非法（绝对路径、`..` 逃逸、null byte） | `{ "error": "Invalid path" }` |
| 400 | `path` 指向文件而非目录 | `{ "error": "Not a directory" }` |
| 400 | `depth` 不是非负整数 | `{ "error": "Invalid depth parameter" }` |
| 404 | `path` 不存在 | `{ "error": "Directory not found" }` |

### curl 示例

```bash
# 顶层
curl -H "x-api-key: $KEY" http://localhost:3000/v1/files

# 子目录
curl -H "x-api-key: $KEY" "http://localhost:3000/v1/files?path=src"

# 递归整棵树
curl -H "x-api-key: $KEY" "http://localhost:3000/v1/files?recursive=true"

# 限制深度（顶层 + 1 层子目录）
curl -H "x-api-key: $KEY" "http://localhost:3000/v1/files?recursive=true&depth=1"
```

---

## `GET /v1/files/content`

单文件流式下载，支持 HTTP Range。

### Query 参数

| 参数 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `path` | string | ✅ | 相对 cwd 的文件路径 |

### 成功响应（200）

响应头：

```
Content-Type: <由扩展名推断>
Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>
Content-Length: <文件字节数>
Accept-Ranges: bytes
Last-Modified: <RFC 1123 格式>
```

不设大小上限——任何大小的文件都会被流式返回（`fs.createReadStream` + Web ReadableStream）。

### Range 请求

支持单段 Range：

```bash
curl -H "Range: bytes=0-99" \
     -H "x-api-key: $KEY" \
     "http://localhost:3000/v1/files/content?path=logs/app.log"
```

返回 206 Partial Content：

```
HTTP/1.1 206 Partial Content
Content-Type: text/plain
Content-Length: 100
Content-Range: bytes 0-99/48200
Accept-Ranges: bytes
```

支持的 Range 格式：

| 格式 | 含义 |
|---|---|
| `bytes=0-99` | 第 0 到 99 字节 |
| `bytes=100-` | 第 100 字节到文件末尾 |
| `bytes=-100` | 最后 100 字节 |

多段 Range（`bytes=0-99,200-299`）回退为 200 全文件返回。

### 错误响应

| 状态 | 触发 | 响应体 |
|---|---|---|
| 400 | 路径非法、path 指向目录、symlink 逃出 cwd | `{ "error": "Invalid path" }` 或 `{ "error": "Not a file" }` |
| 404 | 文件不存在 | `{ "error": "File not found" }` |
| 416 | Range 不可满足（start ≥ size） | `{ "error": "Range not satisfiable" }` + `Content-Range: bytes */<size>` |

### curl 示例

```bash
# 全文下载
curl -H "x-api-key: $KEY" \
     "http://localhost:3000/v1/files/content?path=outputs/report.json" \
     -o report.json

# Range 下载（前 1KB）
curl -H "x-api-key: $KEY" \
     -H "Range: bytes=0-1023" \
     "http://localhost:3000/v1/files/content?path=logs/app.log" \
     -o partial.log
```

---

## `HEAD /v1/files/content`

与 `GET` 相同的 query 参数和响应头，但**没有响应体**。

用于下载前预查 `Content-Length` / `Content-Type`，或验证文件是否存在（404 ↔ 200）。

### curl 示例

```bash
curl -I -H "x-api-key: $KEY" \
     "http://localhost:3000/v1/files/content?path=outputs/report.json"
```

输出：

```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Disposition: attachment; filename*=UTF-8''report.json
Content-Length: 482
Accept-Ranges: bytes
Last-Modified: Tue, 07 Jul 2026 10:00:00 GMT
```

---

## 路径安全

所有 `path` 参数都会经过统一的 `safeResolve` 检查：

1. **拒绝 null byte**：`path` 含 `\0` → 400
2. **拒绝绝对路径**：`/etc/passwd` → 400
3. **拒绝路径遍历**：`../`、`sub/../../` → 400
4. **拒绝 symlink 逃逸**：cwd 内的符号链接若解析后指向 cwd 外，下载时返回 400；列表时 `target` 字段省略

这些是底层一致性约束，与是否配置鉴权无关。

---

## 不做的事（YAGNI）

- 文件上传 / 写入 / 删除（只读）
- 文件搜索 / glob
- 目录打包（tar/zip）
- 文件变更通知
- 内容脱敏
- 多根目录（cwd 是唯一根）

---

## 相关

- 设计文档：[`docs/superpowers/specs/2026-07-07-cwd-files-api-design.md`](../superpowers/specs/2026-07-07-cwd-files-api-design.md)
- 鉴权设计：[`docs/superpowers/specs/2026-06-17-x-api-key-auth-design.md`](../superpowers/specs/2026-06-17-x-api-key-auth-design.md)
- Agent 详情端点（同类只读 API）：[`docs/api/agent-detail.md`](agent-detail.md)
````

- [ ] **Step 3: 验证文档可读性**

```bash
# 检查 markdown 没有明显格式问题
ls -la docs/api/files.md
wc -l docs/api/files.md README.md
```

Expected: 文件创建成功，README 行数增加。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/api/files.md
git commit -m "docs(files): add README endpoints table and full API reference"
```

---

## 完成验证

执行以下命令，确认全部通过：

```bash
npx tsc --noEmit          # 类型检查通过
npm test                  # 所有测试通过
npm run build             # 构建成功，dist/ 生成
```

确认以下事实：

- `/v1/files`、`/v1/files/content`、`HEAD /v1/files/content` 三个端点都存在且行为符合 spec
- 路径遍历、绝对路径、null byte、symlink 逃逸都返回 400
- Range 请求返回 206，416 返回正确 Content-Range
- 鉴权未通过时返回 401
- 不引入新的运行时依赖（`package.json` 的 `dependencies` 字段未变化）
- 文档与代码一致（README 表格 + docs/api/files.md）

## Self-Review Notes

**Spec coverage**：spec 中所有章节都在本计划中有对应实现：
- §信任模型 → Global Constraints + 各 Task 的安全检查
- §端点 1 列表 → Task 1+2+3
- §端点 2 下载 → Task 4
- §Range → Task 5
- §路径安全 → Task 1 (safeResolve) + Task 4 (realpath)
- §MIME 表 → Task 1
- §测试覆盖 → 每个 Task 的 Step 1
- §README + docs/api → Task 7

**Placeholder scan**：无 TBD/TODO；每个 Step 都有完整代码或可执行命令。

**Type consistency**：
- `FileEntry.type` 在 Task 1 定义为 `"file" | "directory" | "symlink" | "other"`，Task 2 walkDir 中 `entryType()` 返回值与此一致
- `ListError.code` 在 Task 2 定义为 `"invalid_path" | "not_found" | "not_directory"`，Task 3 路由层据此映射 HTTP 状态
- `createFilesRouter(cwd?: string)` 签名贯穿 Task 3、4、5、6
- `handleContent(c, cwd, headOnly)` 在 Task 4 定义，Task 5 扩展（不重命名）

**关键依赖链**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7。Task 1-2 是工具层，Task 3-5 是路由层，Task 6 是挂载集成，Task 7 是文档。每个 Task 都有独立可验证的 deliverable。
