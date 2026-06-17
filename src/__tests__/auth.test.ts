import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { createAuthMiddleware, safeCompare } from "../auth.js"

function createApp(apiKey: string) {
  const app = new Hono()
  app.use("/v1/*", createAuthMiddleware(apiKey))
  app.get("/v1/ping", (c) => c.json({ ok: true }))
  return app
}

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("secret", "secret")).toBe(true)
  })

  it("returns false for different strings of same length", () => {
    expect(safeCompare("secret", "secreX")).toBe(false)
  })

  it("returns false for different-length strings without throwing", () => {
    expect(safeCompare("short", "much-longer-string")).toBe(false)
  })

  it("returns true for empty strings", () => {
    expect(safeCompare("", "")).toBe(true)
  })
})

describe("createAuthMiddleware", () => {
  it("allows request with correct x-api-key header", async () => {
    const app = createApp("my-key")
    const res = await app.request("http://localhost/v1/ping", {
      headers: { "x-api-key": "my-key" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("rejects request without x-api-key header with 401", async () => {
    const app = createApp("my-key")
    const res = await app.request("http://localhost/v1/ping")
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("Unauthorized")
    expect(body.reason).toBe("missing x-api-key header")
  })

  it("rejects request with wrong x-api-key header with 401", async () => {
    const app = createApp("my-key")
    const res = await app.request("http://localhost/v1/ping", {
      headers: { "x-api-key": "wrong-key" },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("Unauthorized")
    expect(body.reason).toBe("invalid api key")
  })

  it("does not protect routes outside /v1/*", async () => {
    const app = createApp("my-key")
    app.get("/health", (c) => c.json({ ok: true }))
    const res = await app.request("http://localhost/health")
    expect(res.status).toBe(200)
  })
})
