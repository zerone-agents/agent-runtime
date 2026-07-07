import { Hono } from "hono"
import type { Context } from "hono"
import { createReadStream } from "node:fs"
import { stat, realpath } from "node:fs/promises"
import { Readable } from "node:stream"
import { basename, relative } from "node:path"
import { listDir, ListError, safeResolve, lookupMimeType } from "../files.js"

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

  if (headOnly) {
    return c.body(null)
  }

  // 流式响应：Node Readable → Web ReadableStream
  const stream = createReadStream(realAbs)
  return c.body(Readable.toWeb(stream) as ReadableStream)
}
