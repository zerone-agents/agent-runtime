/**
 * 聊天附件上传域服务（issue #43）。
 *
 * 职责：文件名安全化、原子化目标分配（wx + -N 后缀）、流式 multipart
 * 处理（processUpload，见 Task 3 追加）。文件落在 <cwd>/.zerone-uploads，
 * 扁平目录，生命周期跟随容器。
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { open, mkdir, rm, realpath, lstat, type FileHandle } from "node:fs/promises"
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

const UNSAFE_CHARS = /[/\\?%*:|"<>\x00-\x1f\x7f]/g

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
  // 防 symlink 逃逸（review PR #48 P1a）：mkdir(recursive) 对已存在的
  // symlink 静默成功，上传目录必须真实解析为 <cwd>/.zerone-uploads。
  const realCwd = await realpath(cwd)
  const realUploadsDir = await realpath(dir)
  if (realUploadsDir !== join(realCwd, UPLOADS_DIR)) {
    throw new Error(`${UPLOADS_DIR} must be a real directory inside the working directory`)
  }

  // 固定目录句柄（review PR #48 R3 复盘）：Linux 下 create 与 cleanup 全部经
  // /proc/self/fd/<dirFd>/ 解析——内核 fd 表不受词法路径换链影响（实证：
  // 换链后经 fd 路径仍可读到原目录内容、inode 比对一致、unlink 不触外部）。
  // 非 Linux 回退到 resolved 词法路径 + bracket 复检（残余窗口见 PR 说明）。
  const dirHandle = await open(realUploadsDir, "r")
  const pinned = await dirHandle.stat() // fd 自身 stat：受信目录身份
  const pathSt = await lstat(realUploadsDir).catch(() => null)
  if (!pathSt || pathSt.isSymbolicLink() || pathSt.dev !== pinned.dev || pathSt.ino !== pinned.ino) {
    await dirHandle.close().catch(() => {})
    throw new Error("uploads directory changed — possible symlink swap")
  }
  const trustedDir = existsSync("/proc/self/fd")
    ? `/proc/self/fd/${dirHandle.fd}`
    : realUploadsDir

  interface CreatedFile {
    canonicalPath: string
    handle: FileHandle
    dev: number
    ino: number
  }
  const created: CreatedFile[] = []
  const metas: UploadedFileMeta[] = []
  let fileCount = 0
  let totalBytes = 0

  /** inode 复核的 unlink：路径当前解析结果与记录的 dev/ino 一致才删除；
   * 换链后宁留（已清零的）自有文件也不误删他人文件。 */
  const unlinkIfNodeMatches = async (path: string, dev: number, ino: number): Promise<void> => {
    const st = await lstat(path).catch(() => null)
    if (st !== null && st.dev === dev && st.ino === ino) {
      await rm(path, { force: true }).catch(() => {})
    }
  }

  // fd 钉住清理（review PR #48 R3）：句柄全程保持打开直至请求终结，
  // truncate 只作用于自身 inode（不可被路径重定向）；失败时逐文件
  // 先清零、再关闭、最后做 inode 复核 unlink。
  const cleanup = async (): Promise<void> => {
    for (const f of created) {
      await f.handle.truncate(0).catch(() => {})
      await f.handle.close().catch(() => {})
      await unlinkIfNodeMatches(f.canonicalPath, f.dev, f.ino)
    }
    created.length = 0
    await dirHandle.close().catch(() => {})
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
      try {
        bb.destroy()
      } catch {
        // busboy Multipart._destroy 在未完成解析被销毁时会经 checkEndState
        // 同步抛 "Unexpected end of file"——已在失败路径，吞掉以免逃逸为
        // uncaught exception（vitest 会以非零码中断整个测试运行）
      }
      source.destroy()
      void cleanup().then(
        () => reject(err),
        () => reject(err),
      )
    }

    let work: Promise<void> = Promise.resolve()

    bb.on("file", (_fieldName, stream, info) => {
      // busboy 被销毁时会向进行中的 part 流注入 error（checkEndState 的
      // "Unexpected end of file"）——若此刻无人迭代该流（如探针在 for-await
      // 前抛错），无监听器的 error 会逃逸为 uncaught exception。
      // no-op 监听仅阻断逃逸；迭代中的错误仍由 for-await 正常抛出。
      stream.on("error", () => {})
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
          // 探针：canonical 路径此刻仍钉在受信目录（dev/ino 一致）
          const dirSt = await lstat(realUploadsDir).catch(() => null)
          if (dirSt === null || dirSt.dev !== pinned.dev || dirSt.ino !== pinned.ino) {
            throw new Error("uploads directory changed — possible symlink swap")
          }
          const dest = await allocateDestination(trustedDir, info.filename)
          const fst = await dest.handle.stat()
          // bracket 复检：open 后再核一次 canonical 路径——探针→open 窗口内
          // 的换链在此抓住（Linux 下 create 本身经 fd 表，数据不会逃逸）
          const bracketSt = await lstat(realUploadsDir).catch(() => null)
          if (bracketSt === null || bracketSt.dev !== pinned.dev || bracketSt.ino !== pinned.ino) {
            await dest.handle.truncate(0).catch(() => {})
            await dest.handle.close().catch(() => {})
            await unlinkIfNodeMatches(dest.absPath, fst.dev, fst.ino)
            throw new Error("uploads directory changed — possible symlink swap")
          }
          // canonical inode 复核：经受信路径（Linux=内核 fd 表，免疫换链）
          // 再开一次并比对 dev/ino——不一致或不可达即落点逃逸；在任何
          // 字节写入之前中止，逃逸文件清零后仅在 inode 匹配时 unlink。
          const canonicalPath = join(trustedDir, dest.name)
          const verify = await open(canonicalPath, "r").catch(() => null)
          let contained = false
          if (verify !== null) {
            const vst = await verify.stat().catch(() => null)
            contained = vst !== null && vst.dev === fst.dev && vst.ino === fst.ino
            await verify.close().catch(() => {})
          }
          if (!contained) {
            await dest.handle.truncate(0).catch(() => {})
            await dest.handle.close().catch(() => {})
            await unlinkIfNodeMatches(dest.absPath, fst.dev, fst.ino)
            throw new Error("upload destination escaped .zerone-uploads — possible symlink swap")
          }
          created.push({ canonicalPath, handle: dest.handle, dev: fst.dev, ino: fst.ino })
          let fileBytes = 0
          let truncated = false
          // busboy fileSize 截断信号（双保险的另一半是我们自己的 fileBytes 计数）
          stream.on("limit", () => { truncated = true })
          // 句柄保持打开直至请求终结（成功：finish 统一关闭；失败：cleanup
          // 经句柄清零自身 inode 后再做 inode 复核 unlink）
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
        .then(async () => {
          if (settled) return
          if (metas.length === 0) {
            throw new UploadError("invalid_multipart", "No files in request")
          }
          // 终态一致性：请求全程 canonical 路径必须钉在受信 inode 上
          const endSt = await lstat(realUploadsDir).catch(() => null)
          if (!endSt || endSt.isSymbolicLink() || endSt.dev !== pinned.dev || endSt.ino !== pinned.ino) {
            throw new Error("uploads directory changed during upload — possible symlink swap")
          }
          // 成功路径：统一关闭本请求持有的全部句柄
          await Promise.all(created.map((f) => f.handle.close().catch(() => {})))
          await dirHandle.close().catch(() => {})
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
