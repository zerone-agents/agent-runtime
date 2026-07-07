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
  // names are computed relative to the originally-listed directory (abs), so
  // non-recursive listings of a subdir show bare names, while recursive listings
  // at the cwd root show paths like "src/router/agent.ts".
  await walkDir(cwd, abs, abs, opts.recursive === true, opts.depth, 0, entries)

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
 * 递归遍历目录，把每个 entry（按相对 baseAbs 的路径命名）推入 out 数组。
 *
 * currentDepth 语义：
 *   - 0: 起始目录的直接 entries
 *   - N: 已经递归了 N 层子目录后到达的目录的 entries
 *
 * depth 限制：递归前检查 currentDepth+1 是否超过 maxDepth。
 */
async function walkDir(
  cwd: string,
  baseAbs: string,
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
    const entryRel = toForwardSlash(relative(baseAbs, entryAbs))

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
        await walkDir(cwd, baseAbs, entryAbs, true, maxDepth, currentDepth + 1, out)
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
