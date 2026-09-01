/**
 * 聊天附件上传域服务（issue #43）。
 *
 * 职责：文件名安全化、原子化目标分配（wx + -N 后缀）、流式 multipart
 * 处理（processUpload，见 Task 3 追加）。文件落在 <cwd>/.zerone-uploads，
 * 扁平目录，生命周期跟随容器。
 */
import { open, type FileHandle } from "node:fs/promises"
import { join } from "node:path"

export const UPLOADS_DIR = ".zerone-uploads"
export const MAX_FILE_COUNT = 10
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024
export const MAX_NAME_BYTES = 200
export const MAX_SUFFIX_ATTEMPTS = 1000

export type UploadErrorCode = "invalid_multipart" | "upload_limit_exceeded"

export class UploadError extends Error {
  constructor(public code: UploadErrorCode, message: string) {
    super(message)
    this.name = "UploadError"
  }
}

const UNSAFE_CHARS = /[/\\?%*:|"<>\x00-\x1f]/g

/** 拆 stem/ext；ext 含前导 `.`。无扩展名或 dotfile 时 ext 为空。 */
export function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return { stem: name, ext: "" }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * 文件名安全化：非法字符与控制字符替换为 `_`，去除首尾空白；
 * 空 / `.` / `..` 回退为 `file`；UTF-8 字节长度上限 200（保留扩展名，
 * 扩展名截断到 16 字符）。非 ASCII（中文等）保留。
 */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw.replace(UNSAFE_CHARS, "_").trim()
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file"
  if (Buffer.byteLength(cleaned, "utf8") <= MAX_NAME_BYTES) return cleaned
  const { stem, ext } = splitExt(cleaned)
  const extPart = ext.slice(0, 16)
  let stemPart = stem
  while (
    stemPart.length > 1 &&
    Buffer.byteLength(stemPart, "utf8") + Buffer.byteLength(extPart, "utf8") > MAX_NAME_BYTES
  ) {
    stemPart = stemPart.slice(0, -1)
  }
  return stemPart + extPart
}

export interface AllocatedDestination {
  /** 最终文件名（不含目录） */
  name: string
  /** 绝对路径 */
  absPath: string
  /** 已以 "wx" 独占创建打开的句柄；调用方负责 close */
  handle: FileHandle
}

/**
 * 原子化分配目标文件：首次尝试 sanitize 后的原名，EEXIST 则依次
 * `base-2.ext`、`base-3.ext` …（"wx" 保证并发/跨请求不覆盖）。
 * 超过 MAX_SUFFIX_ATTEMPTS 次抛普通 Error（路由层映射 500）。
 */
export async function allocateDestination(
  dir: string,
  desiredName: string,
): Promise<AllocatedDestination> {
  const { stem, ext } = splitExt(sanitizeFilename(desiredName))
  for (let attempt = 1; attempt <= MAX_SUFFIX_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? `${stem}${ext}` : `${stem}-${attempt}${ext}`
    try {
      const handle = await open(join(dir, name), "wx")
      return { name, absPath: join(dir, name), handle }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue
      throw err
    }
  }
  throw new Error(
    `Failed to allocate a unique filename for "${desiredName}" after ${MAX_SUFFIX_ATTEMPTS} attempts`,
  )
}
