import { describe, it, expect, vi, beforeEach } from "vitest"
import { createApp } from "../router/index.js"
import { createAuthMiddleware, safeCompare } from "../auth.js"
import type { RuntimeConfig } from "../config.js"

function createTestConfig(auth?: { apiKey?: string }): RuntimeConfig {
  return {
    server: { host: "0.0.0.0", port: 3000 },
    agents: [{ id: "assistant", model: "claude-sonnet-4-6", maxTurns: 10 }],
    auth,
  }
}

const mockRegistry = {
  list: vi.fn().mockReturnValue([{ id: "assistant", status: "ready" }]),
  create: vi.fn(),
  getStatus: vi.fn().mockReturnValue("ready"),
}

const mockMetrics = {
  getSnapshot: vi.fn().mockReturnValue({
    totalRequests: 0,
    totalTokens: { input: 0, output: 0 },
    totalCost: 0,
    agentMetrics: {},
    uptime: 0,
  }),
  recordRun: vi.fn(),
}

describe("safeCompare", () => {
  it("returns true for identical strings", () => {
    expect(safeCompare("secret", "secret")).toBe(true)
  })

  it("returns false for different strings", () => {
    expect(safeCompare("secret", "wrong")).toBe(false)
  })

  it("returns false for different-length strings without throwing", () => {
    expect(safeCompare("short", "much-longer-string")).toBe(false)
  })

  it("handles multi-byte characters correctly", () => {
    expect(safeCompare("🔐secret", "🔐secret")).toBe(true)
    expect(safeCompare("🔐secret", "🔐wrong")).toBe(false)
  })
})

describe("createAuthMiddleware", () => {
  it("allows request with correct key", async () => {
    const middleware = createAuthMiddleware("my-key")
    const c = {
      req: { header: vi.fn().mockReturnValue("my-key") },
      json: vi.fn(),
    } as any
    const next = vi.fn().mockResolvedValue(undefined)

    await middleware(c, next)
    expect(next).toHaveBeenCalled()
    expect(c.json).not.toHaveBeenCalled()
  })

  it("rejects request without header with 401 + correct reason", async () => {
    const middleware = createAuthMiddleware("my-key")
    const c = {
      req: { header: vi.fn().mockReturnValue(undefined) },
      json: vi.fn().mockReturnValue(new Response()),
    } as any
    const next = vi.fn().mockResolvedValue(undefined)

    await middleware(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(c.json).toHaveBeenCalledWith(
      { error: "Unauthorized", reason: "missing x-api-key header" },
      401,
    )
  })

  it("rejects request with wrong key with 401 + correct reason", async () => {
    const middleware = createAuthMiddleware("my-key")
    const c = {
      req: { header: vi.fn().mockReturnValue("wrong-key") },
      json: vi.fn().mockReturnValue(new Response()),
    } as any
    const next = vi.fn().mockResolvedValue(undefined)

    await middleware(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(c.json).toHaveBeenCalledWith(
      { error: "Unauthorized", reason: "invalid api key" },
      401,
    )
  })
})

describe("createApp auth integration", () => {
  beforeEach(() => {
    delete process.env.OPENAGENT_HTTP_API_KEY
    vi.clearAllMocks()
  })

  it("No key configured — all /v1/* routes open, no auth required", async () => {
    const config = createTestConfig()
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/agents")
    expect(res.status).toBe(200)

    const resMetrics = await app.request("http://localhost/v1/metrics")
    expect(resMetrics.status).toBe(200)
  })

  it("Key configured, request with correct x-api-key → 200", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "secret-key" },
    })
    expect(res.status).toBe(200)
  })

  it("Key configured, request with wrong x-api-key → 401, reason: invalid api key", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "wrong-key" },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("Unauthorized")
    expect(body.reason).toBe("invalid api key")
  })

  it("Key configured, request without x-api-key → 401, reason: missing x-api-key header", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/agents")
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("Unauthorized")
    expect(body.reason).toBe("missing x-api-key header")
  })

  it("Key configured, GET /health without header → 200 (root, unauthenticated)", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/health")
    expect(res.status).toBe(200)
  })

  it("Key configured, GET /v1/metrics without header → 401", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/metrics")
    expect(res.status).toBe(401)
  })

  it("Key configured, GET /v1/agents without header → 401", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/agents")
    expect(res.status).toBe(401)
  })

  it("Key configured, GET /v1/sessions without header → 401", async () => {
    const config = createTestConfig({ apiKey: "secret-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/sessions")
    expect(res.status).toBe(401)
  })

  it("Env var OPENAGENT_HTTP_API_KEY set, yaml auth.apiKey set → Env var wins", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "env-key"
    const config = createTestConfig({ apiKey: "yaml-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    // Should accept env key, reject yaml key
    const resEnv = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "env-key" },
    })
    expect(resEnv.status).toBe(200)

    const resYaml = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "yaml-key" },
    })
    expect(resYaml.status).toBe(401)
    const body = await resYaml.json()
    expect(body.reason).toBe("invalid api key")
  })

  it("Env var unset, yaml auth.apiKey set → yaml value used", async () => {
    delete process.env.OPENAGENT_HTTP_API_KEY
    const config = createTestConfig({ apiKey: "yaml-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    const res = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "yaml-key" },
    })
    expect(res.status).toBe(200)

    const resWrong = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "wrong-key" },
    })
    expect(resWrong.status).toBe(401)
  })

  it("Empty env var OPENAGENT_HTTP_API_KEY disables auth (no middleware mounted)", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = ""
    const config = createTestConfig({ apiKey: "yaml-key" })
    const app = createApp(config, mockRegistry as any, mockMetrics as any)

    // Empty string env var means no apiKey is set, so no auth middleware is mounted
    const res = await app.request("http://localhost/v1/agents")
    expect(res.status).toBe(200)
  })
})
