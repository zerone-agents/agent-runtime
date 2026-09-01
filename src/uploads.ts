/**
 * 聊天附件上传域服务（issue #43）。
 *
 * 职责：文件名安全化、原子化目标分配（wx + -N 后缀）、流式 multipart
 * 处理（processUpload，见 Task 3 追加）。文件落在 <cwd>/.zerone-uploads，
 * 扁平目录，生命周期跟随容器。
 */
import { randomUUID } from "node:crypto"
import { open, mkdir, rm, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web"
import busboy from "busboy"
import { lookupMimeType } from "./files.js"

const MB = 1024 * 1024

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

export interface UploadedFileMeta {
  id: string
  name: string
  mime: string
  size: number
  path: string
}

/**
 * 流式处理 multipart 上传：边读边执行 个数/单文件/总量 三限额，任何
 * 失败都清理本请求已创建的全部文件（all-or-none）。成功返回元数据数组。
 * 禁止把整个请求读入内存——所有计数都在 chunk 到达时进行。
 */
export async function processUpload(
  cwd: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<UploadedFileMeta[]> {
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new UploadError("invalid_multipart", "Content-Type must be multipart/form-data")
  }
  const dir = join(cwd, UPLOADS_DIR)
  await mkdir(dir, { recursive: true })

  const created: string[] = []
  const metas: UploadedFileMeta[] = []
  let fileCount = 0
  let totalBytes = 0

  const cleanup = async (): Promise<void> => {
    await Promise.all(created.map((p) => rm(p, { force: true }).catch(() => {})))
  }

  let bb: ReturnType<typeof busboy>
  try {
    bb = busboy({
      headers: { "content-type": contentType },
      // files 上限放宽一个，让第 11 个 part 仍触发 file 事件，由自维护计数报错
      limits: { files: MAX_FILE_COUNT + 1, fileSize: MAX_FILE_BYTES, fields: 5 },
    })
  } catch (err) {
    throw new UploadError(
      "invalid_multipart",
      `Malformed multipart headers: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return await new Promise<UploadedFileMeta[]>((resolve, reject) => {
    let settled = false

    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      bb.destroy()
      source.destroy()
      void cleanup().then(
        () => reject(err),
        () => reject(err),
      )
    }

    let work: Promise<void> = Promise.resolve()

    bb.on("file", (_fieldName, stream, info) => {
      work = work.then(() =>
        (async () => {
          if (settled) return
          fileCount += 1
          if (fileCount > MAX_FILE_COUNT) {
            throw new UploadError(
              "upload_limit_exceeded",
              `Too many files: limit is ${MAX_FILE_COUNT}`,
            )
          }
          const dest = await allocateDestination(dir, info.filename)
          created.push(dest.absPath)
          let fileBytes = 0
          let truncated = false
          // busboy fileSize 截断信号（双保险的另一半是我们自己的 fileBytes 计数）
          stream.on("limit", () => { truncated = true })
          try {
            for await (const chunk of stream) {
              const buf = chunk as Buffer
              fileBytes += buf.length
              totalBytes += buf.length
              if (totalBytes > MAX_TOTAL_BYTES) {
                throw new UploadError(
                  "upload_limit_exceeded",
                  `Total upload size exceeds the ${MAX_TOTAL_BYTES / MB}MB request limit`,
                )
              }
              await dest.handle.write(buf)
            }
          } finally {
            await dest.handle.close().catch(() => {})
          }
          if (truncated || fileBytes > MAX_FILE_BYTES) {
            throw new UploadError(
              "upload_limit_exceeded",
              `File "${info.filename}" exceeds the ${MAX_FILE_BYTES / MB}MB single-file limit`,
            )
          }
          metas.push({
            id: randomUUID(),
            name: dest.name,
            // 偏离 brief 原文（info.mimeType || lookupMimeType(...)）：busboy 对缺省
            // Content-Type 的 file part 一律填 "text/plain"（multipart.js 硬编码默认，
            // 不暴露原始 part 头，无法与真实声明区分），|| 回退分支实为死代码。
            // 故将 "text/plain" 视为未声明 → 按扩展名回查（未知扩展名 →
            // application/octet-stream，与 files.ts DEFAULT_MIME 策略一致）。
            mime: info.mimeType !== "text/plain" ? info.mimeType : lookupMimeType(dest.name),
            size: fileBytes,
            path: `${UPLOADS_DIR}/${dest.name}`,
          })
        })().catch((err: unknown) => {
          fail(err)
        }),
      )
    })

    bb.on("finish", () => {
      work
        .then(() => {
          if (settled) return
          if (metas.length === 0) {
            throw new UploadError("invalid_multipart", "No files in request")
          }
          resolve(metas)
        })
        .catch(fail)
    })

    bb.on("error", (err: unknown) => {
      fail(
        new UploadError(
          "invalid_multipart",
          `Malformed multipart body: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
    })

    const source = Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>)
    source.on("error", (err: Error) => {
      fail(new UploadError("invalid_multipart", `Request stream error: ${err.message}`))
    })
    source.pipe(bb)
  })
}
