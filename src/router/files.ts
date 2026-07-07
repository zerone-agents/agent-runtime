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
