import { Hono } from "hono"
import type { Context } from "hono"
import { createReadStream } from "node:fs"
import { stat, realpath } from "node:fs/promises"
import { Readable } from "node:stream"
import { basename, relative } from "node:path"
import { listDir, ListError, safeResolve, lookupMimeType } from "../files.js"
import { processUpload, UploadError } from "../uploads.js"
import { EXPECTED_CONTAINER_ID_HEADER, GenerationError, assertExpectedGeneration, generationErrorPayload } from "../container-id.js"

/**
 * 创建 files 路由。cwd 默认为 process.cwd()，测试时可显式传入临时目录。
 *
 * 端点：
 *   POST /uploads       multipart 上传（201 { files }；400 invalid_multipart / 413 upload_limit_exceeded）
 *   GET  /              列表（?path & ?recursive & ?depth）
 *   GET  /content       单文件下载（Task 4 实现）
 *   HEAD /content       单文件元数据（Task 4 实现）
 */
export function createFilesRouter(cwd: string = process.cwd()): Hono {
  const router = new Hono()

  router.post("/uploads", async (c) => {
    const body = c.req.raw.body
    const contentType = c.req.header("Content-Type") ?? ""
    try {
      // 代次原子校验（issue #61）：任何上传写入之前
      const expectedGen = c.req.header(EXPECTED_CONTAINER_ID_HEADER)
      if (expectedGen !== undefined) await assertExpectedGeneration(expectedGen)
      if (!body) throw new UploadError("invalid_multipart", "Request has no body")
      const files = await processUpload(cwd, body, contentType)
      return c.json({ files }, 201)
    } catch (err) {
      if (err instanceof GenerationError) {
        const { status, body } = generationErrorPayload(err)
        return c.json(body, status)
      }
      if (err instanceof UploadError) {
        const status = err.code === "upload_limit_exceeded" ? 413 : 400
        return c.json({ error: err.message, code: err.code }, status)
      }
      throw err
    }
  })

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

  router.get("/content", async (c) => handleContent(c, cwd, false))
  router.on("HEAD", "/content", async (c) => handleContent(c, cwd, true))

  return router
}

/**
 * 处理文件内容下载（GET 拉流，HEAD 仅返回头）。
 *
 * 安全检查链：
 *   1. safeResolve(cwd, rel) → 防 traversal / 绝对路径 / null byte
 *   2. realpath(abs) → 防 symlink 逃逸；解析后路径必须仍在 cwd 内
 *   3. stat → 确认是普通文件
 *
 * 注：cwd 自身可能位于符号链接之下（如 macOS 的 /tmp → /private/tmp），
 * 因此比较前需对 cwd 也做 realpath，保证两侧均为解析后形式。
 */
async function handleContent(c: Context, cwd: string, headOnly: boolean) {
  // 代次原子校验（issue #61）：任何文件读取之前
  const expectedGen = c.req.header(EXPECTED_CONTAINER_ID_HEADER)
  if (expectedGen !== undefined) {
    try {
      await assertExpectedGeneration(expectedGen)
    } catch (err) {
      if (err instanceof GenerationError) {
        const { status, body } = generationErrorPayload(err)
        return c.json(body, status)
      }
      throw err
    }
  }
  const rel = c.req.query("path") ?? ""
  const abs = safeResolve(cwd, rel)
  if (abs === null) {
    return c.json({ error: "Invalid path" }, 400)
  }

  // realpath 二次校验（防 symlink 逃逸）
  const [realAbs, realCwd] = await Promise.all([
    realpath(abs).catch(() => null),
    realpath(cwd).catch(() => cwd),
  ])
  if (realAbs === null) {
    return c.json({ error: "File not found" }, 404)
  }
  const realRel = relative(realCwd, realAbs)
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

  if (headOnly) {
    return c.body(null)
  }

  // 流式响应：Node Readable → Web ReadableStream
  const stream = createReadStream(realAbs)
  return c.body(Readable.toWeb(stream) as ReadableStream)
}

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
