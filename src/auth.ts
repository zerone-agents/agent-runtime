import { timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"

export function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

export function createAuthMiddleware(apiKey: string): MiddlewareHandler {
  return async (c, next) => {
    const provided = c.req.header("x-api-key")
    if (!provided) {
      return c.json(
        { error: "Unauthorized", reason: "missing x-api-key header" },
        401,
      )
    }
    if (!safeCompare(provided, apiKey)) {
      return c.json(
        { error: "Unauthorized", reason: "invalid api key" },
        401,
      )
    }
    await next()
  }
}
