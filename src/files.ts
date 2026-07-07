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
