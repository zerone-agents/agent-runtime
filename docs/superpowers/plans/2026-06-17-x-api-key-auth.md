# `x-api-key` Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional `x-api-key` header authentication to the HTTP server. When a key is configured (via env var `OPENAGENT_HTTP_API_KEY` or `auth.apiKey` in config), all `/v1/*` routes require it; `/health` moves out of `/v1` and stays unauthenticated.

**Architecture:** A Hono middleware mounted under `/v1/*` checks the `x-api-key` header using constant-time comparison. The `/health` route moves to root (`/health`) so it sits outside the protected prefix and needs no skip logic. The effective key is resolved once at server startup: `process.env.OPENAGENT_HTTP_API_KEY ?? config.auth?.apiKey`. If neither is set, the middleware is not installed at all — preserving current open-by-default behavior.

**Tech Stack:** Hono, Zod, Vitest, Node.js `crypto.timingSafeEqual`.

**Spec:** `docs/superpowers/specs/2026-06-17-x-api-key-auth-design.md`

## Global Constraints

- ESM only — every local import uses `.js` extension (e.g. `./auth.js`).
- NodeNext module resolution; TypeScript strict.
- Tests use Vitest with no config file; patterns picked up from `src/__tests__/`.
- All Hono route tests use `app.request(url, options)` — no live HTTP server.
- Test file naming: `src/__tests__/<module>.test.ts`.
- Commit messages: conventional commits (`feat:`, `refactor:`, `test:`, `docs:`).
- Run order before each commit: `npx tsc --noEmit` → `npm test`.

## File Structure

```
src/
├── auth.ts                        ← NEW: createAuthMiddleware, safeCompare
├── config.ts                      ← MODIFIED: AuthConfigSchema + field on RuntimeConfigSchema
├── router/
│   ├── index.ts                   ← MODIFIED: split health mount, install auth middleware
│   └── health.ts                  ← MODIFIED: split into createHealthRouter + createMetricsRouter
├── __tests__/
│   ├── auth.test.ts               ← NEW: unit tests for auth module
│   ├── auth-integration.test.ts   ← NEW: integration tests for createApp + middleware wiring
│   ├── config.test.ts             ← MODIFIED: add AuthConfigSchema tests
│   └── router-health.test.ts      ← MODIFIED: update paths after split
```

No changes to `agent.ts`, `session.ts`, `metrics.ts`, `registry.ts`, `sse.ts`, `index.ts`.

---

## Task 1: Split health router and move `/health` to root

This is a standalone refactor that produces the route structure the auth middleware depends on. No auth logic yet. **This is a breaking change** (`/v1/health` → `/health`), called out in the spec.

**Files:**
- Modify: `src/router/health.ts`
- Modify: `src/router/index.ts`
- Modify: `src/__tests__/router-health.test.ts`

**Interfaces:**
- Produces: `createHealthRouter(registry)` — returns Hono router with route `GET /` (mounted at root → `/health`)
- Produces: `createMetricsRouter(metrics)` — returns Hono router with route `GET /` (mounted at `/v1/metrics`)
- Consumes: existing `AgentRegistry.list()` and `MetricsCollector.getSnapshot()` shapes (unchanged)

- [ ] **Step 1: Update `src/router/health.ts` to split into two factories**

Replace the entire file content with:

```ts
import { Hono } from "hono"
import type { AgentRegistry } from "../registry.js"
import type { MetricsCollector } from "../metrics.js"

export function createHealthRouter(registry: AgentRegistry) {
  const router = new Hono()

  router.get("/", (c) => {
    const agents = registry.list()
    const allReady = agents.every((a) => a.status === "ready")
    return c.json({
      status: allReady ? "ok" : "degraded",
      agents: agents.length,
      uptime: Date.now(),
    })
  })

  return router
}

export function createMetricsRouter(metrics: MetricsCollector) {
  const router = new Hono()

  router.get("/", (c) => {
    return c.json(metrics.getSnapshot())
  })

  return router
}
```

- [ ] **Step 2: Update `src/router/index.ts` to mount `/health` at root and `/v1/metrics` under `/v1`**

Replace the file content with:

```ts
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { RuntimeConfig } from "../config.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import { createHealthRouter, createMetricsRouter } from "./health.js"
import { createAgentRouter } from "./agent.js"
import { createSessionRouter } from "./session.js"

export function createApp(config: RuntimeConfig, registry: AgentRegistry, metrics: MetricsCollector) {
  const app = new Hono()

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  app.route("/health", createHealthRouter(registry))
  app.route("/v1/metrics", createMetricsRouter(metrics))
  app.route("/v1/agents", createAgentRouter(registry, metrics))
  app.route("/v1/sessions", createSessionRouter())

  return app
}
```

- [ ] **Step 3: Update `src/__tests__/router-health.test.ts` to use new factory signatures and paths**

Replace the file content with:

```ts
import { describe, it, expect, vi } from "vitest"
import { Hono } from "hono"
import { createHealthRouter, createMetricsRouter } from "../router/health.js"

function createHealthApp(registry: any) {
  const app = new Hono()
  app.route("/health", createHealthRouter(registry))
  return app
}

function createMetricsApp(metrics: any) {
  const app = new Hono()
  app.route("/v1/metrics", createMetricsRouter(metrics))
  return app
}

describe("Health Router", () => {
  describe("GET /health", () => {
    it("returns ok when all agents are ready", async () => {
      const registry = {
        list: vi.fn().mockReturnValue([
          { id: "a1", status: "ready" },
          { id: "a2", status: "ready" },
        ]),
      }
      const app = createHealthApp(registry)

      const res = await app.request("http://localhost/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("ok")
      expect(body.agents).toBe(2)
    })

    it("returns degraded when some agents are unavailable", async () => {
      const registry = {
        list: vi.fn().mockReturnValue([
          { id: "a1", status: "ready" },
          { id: "a2", status: "unavailable" },
        ]),
      }
      const app = createHealthApp(registry)

      const res = await app.request("http://localhost/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("degraded")
      expect(body.agents).toBe(2)
    })

    it("returns ok when there are no agents", async () => {
      const registry = { list: vi.fn().mockReturnValue([]) }
      const app = createHealthApp(registry)

      const res = await app.request("http://localhost/health")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("ok")
      expect(body.agents).toBe(0)
    })
  })
})

describe("Metrics Router", () => {
  describe("GET /v1/metrics", () => {
    it("returns the metrics snapshot", async () => {
      const snapshot = {
        totalRequests: 42,
        totalTokens: { input: 100, output: 200 },
        totalCost: 0.5,
        agentMetrics: {},
        uptime: 9999,
      }
      const metrics = { getSnapshot: vi.fn().mockReturnValue(snapshot) }
      const app = createMetricsApp(metrics)

      const res = await app.request("http://localhost/v1/metrics")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(snapshot)
      expect(metrics.getSnapshot).toHaveBeenCalledOnce()
    })
  })
})
```

- [ ] **Step 4: Typecheck and run tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: all tests pass. If any other test references `/v1/health`, it must be updated to `/health`.

- [ ] **Step 5: Commit**

```bash
git add src/router/health.ts src/router/index.ts src/__tests__/router-health.test.ts
git commit -m "refactor(router): move /health to root, split metrics into own router

BREAKING CHANGE: /v1/health is now /health (unauthenticated mount point).
/v1/metrics unchanged. Prepares route structure for x-api-key middleware
under /v1/* without per-route skip logic."
```

---

## Task 2: Add `AuthConfigSchema` to config

Adds the optional `auth.apiKey` field to `RuntimeConfigSchema`. No runtime behavior change yet — the field is parsed but not consumed.

**Files:**
- Modify: `src/config.ts:6-9` (add `AuthConfigSchema` near `ServerConfigSchema`)
- Modify: `src/config.ts:48-53` (add `auth` field to `RuntimeConfigSchema`)
- Modify: `src/__tests__/config.test.ts` (add auth schema tests)

**Interfaces:**
- Produces: `RuntimeConfig.auth?: { apiKey?: string }` (zod-validated)

- [ ] **Step 1: Add failing test for `auth` config field in `src/__tests__/config.test.ts`**

Insert this `describe` block immediately after the `describe("RuntimeConfigSchema", ...)` block (after its closing `})` on line 115):

```ts
describe("AuthConfigSchema", () => {
  it("accepts config with auth.apiKey", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "a1" }],
      auth: { apiKey: "my-secret" },
    })
    expect(result.auth?.apiKey).toBe("my-secret")
  })

  it("accepts config without auth field", () => {
    const result = RuntimeConfigSchema.parse({ agents: [{ id: "a1" }] })
    expect(result.auth).toBeUndefined()
  })

  it("accepts auth object with no apiKey (optional)", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "a1" }],
      auth: {},
    })
    expect(result.auth).toEqual({})
  })

  it("rejects empty string apiKey", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [{ id: "a1" }],
        auth: { apiKey: "" },
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/config.test.ts`
Expected: 4 tests fail with errors about unknown `auth` key or undefined `result.auth`.

- [ ] **Step 3: Add `AuthConfigSchema` and wire into `RuntimeConfigSchema`**

In `src/config.ts`, insert after the `ServerConfigSchema` definition (after line 9):

```ts
const AuthConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
})
```

Then in `RuntimeConfigSchema` (currently lines 48-53), add `auth: AuthConfigSchema.optional(),` between `logging` and `agents`. The final schema should read:

```ts
export const RuntimeConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  cors: CorsConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  agents: z.array(AgentDefinitionSchema).min(1),
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/config.test.ts`
Expected: all 4 new tests pass, existing tests still pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(config): add optional auth.apiKey field

Parsed but not yet consumed. Prepares for x-api-key middleware wiring."
```

---

## Task 3: Create `src/auth.ts` module

Standalone auth middleware factory with constant-time comparison. No Hono wiring yet — pure unit-tested module.

**Files:**
- Create: `src/auth.ts`
- Create: `src/__tests__/auth.test.ts`

**Interfaces:**
- Produces: `createAuthMiddleware(apiKey: string): MiddlewareHandler` — Hono middleware that reads `x-api-key` header and either calls `next()` or returns `401 { error, reason }`
- Produces: `safeCompare(a: string, b: string): boolean` — timing-safe string equality (returns `false` immediately if lengths differ)

- [ ] **Step 1: Write failing tests in `src/__tests__/auth.test.ts`**

Create the file with:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/auth.test.ts`
Expected: all tests fail with module not found / undefined imports.

- [ ] **Step 3: Create `src/auth.ts` with implementation**

Create the file with:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/auth.test.ts`
Expected: all 8 tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/__tests__/auth.test.ts
git commit -m "feat(auth): add createAuthMiddleware with timing-safe comparison

Standalone module, not yet wired into createApp."
```

---

## Task 4: Wire middleware into `createApp`

Install the auth middleware conditionally based on env var + config. Covers all integration scenarios from the spec's test matrix.

**Files:**
- Modify: `src/router/index.ts`
- Create: `src/__tests__/auth-integration.test.ts`

**Interfaces:**
- Consumes: `createAuthMiddleware` from `src/auth.ts`
- Consumes: `config.auth?.apiKey` (added in Task 2)
- Produces: `createApp(config, registry, metrics)` that conditionally protects `/v1/*` based on `process.env.OPENAGENT_HTTP_API_KEY ?? config.auth?.apiKey`

- [ ] **Step 1: Write failing integration tests in `src/__tests__/auth-integration.test.ts`**

Create the file with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createApp } from "../router/index.js"

vi.mock("@zerone-agent/open-agent-sdk", () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
}))

function makeConfig(auth?: { apiKey?: string }) {
  return {
    server: { host: "0.0.0.0", port: 3000 },
    agents: [{ id: "a1", model: "test-model", maxTurns: 1 }],
    ...(auth ? { auth } : {}),
  } as any
}

const registry = {
  list: vi.fn().mockReturnValue([{ id: "a1", status: "ready" }]),
  getStatus: vi.fn().mockReturnValue("ready"),
  create: vi.fn(),
} as any

const metrics = { getSnapshot: vi.fn().mockReturnValue({}), recordRun: vi.fn() } as any

describe("createApp auth integration", () => {
  beforeEach(() => {
    delete process.env.OPENAGENT_HTTP_API_KEY
  })

  afterEach(() => {
    delete process.env.OPENAGENT_HTTP_API_KEY
  })

  it("does not protect /v1 when no key is configured (env + config)", async () => {
    const app = createApp(makeConfig(), registry, metrics)
    const res = await app.request("http://localhost/v1/agents")
    expect(res.status).toBe(200)
  })

  it("does not protect /health even when key is configured", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "secret"
    const app = createApp(makeConfig(), registry, metrics)
    const res = await app.request("http://localhost/health")
    expect(res.status).toBe(200)
  })

  it("protects /v1/agents when env var is set, rejects without header", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "secret"
    const app = createApp(makeConfig(), registry, metrics)
    const res = await app.request("http://localhost/v1/agents")
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.reason).toBe("missing x-api-key header")
  })

  it("protects /v1/agents, rejects wrong key", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "secret"
    const app = createApp(makeConfig(), registry, metrics)
    const res = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "wrong" },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.reason).toBe("invalid api key")
  })

  it("allows /v1/agents with correct key from env var", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "secret"
    const app = createApp(makeConfig(), registry, metrics)
    const res = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "secret" },
    })
    expect(res.status).toBe(200)
  })

  it("allows /v1/agents with correct key from config.auth.apiKey", async () => {
    const app = createApp(makeConfig({ apiKey: "config-key" }), registry, metrics)
    const res = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "config-key" },
    })
    expect(res.status).toBe(200)
  })

  it("env var takes precedence over config.auth.apiKey", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "env-key"
    const app = createApp(makeConfig({ apiKey: "config-key" }), registry, metrics)
    const envRes = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "env-key" },
    })
    expect(envRes.status).toBe(200)

    const configRes = await app.request("http://localhost/v1/agents", {
      headers: { "x-api-key": "config-key" },
    })
    expect(configRes.status).toBe(401)
  })

  it("protects /v1/metrics when key is set", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "secret"
    const app = createApp(makeConfig(), registry, metrics)
    const res = await app.request("http://localhost/v1/metrics")
    expect(res.status).toBe(401)
  })

  it("protects /v1/sessions when key is set", async () => {
    process.env.OPENAGENT_HTTP_API_KEY = "secret"
    const app = createApp(makeConfig(), registry, metrics)
    const res = await app.request("http://localhost/v1/sessions")
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/auth-integration.test.ts`
Expected: tests for protected routes fail with status `200` (no auth enforced) because middleware is not yet wired.

- [ ] **Step 3: Wire middleware into `src/router/index.ts`**

Replace the file content with:

```ts
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { RuntimeConfig } from "../config.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import { createAuthMiddleware } from "../auth.js"
import { createHealthRouter, createMetricsRouter } from "./health.js"
import { createAgentRouter } from "./agent.js"
import { createSessionRouter } from "./session.js"

export function createApp(config: RuntimeConfig, registry: AgentRegistry, metrics: MetricsCollector) {
  const app = new Hono()

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  app.route("/health", createHealthRouter(registry))

  const apiKey = process.env.OPENAGENT_HTTP_API_KEY ?? config.auth?.apiKey
  if (apiKey) {
    app.use("/v1/*", createAuthMiddleware(apiKey))
  }

  app.route("/v1/metrics", createMetricsRouter(metrics))
  app.route("/v1/agents", createAgentRouter(registry, metrics))
  app.route("/v1/sessions", createSessionRouter())

  return app
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npx vitest run src/__tests__/auth-integration.test.ts`
Expected: all 9 tests pass.

Run: `npm test`
Expected: entire test suite passes.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/router/index.ts src/__tests__/auth-integration.test.ts
git commit -m "feat(auth): wire x-api-key middleware into createApp

Mounts createAuthMiddleware under /v1/* when OPENAGENT_HTTP_API_KEY or
config.auth.apiKey is set. /health remains unauthenticated at root.
Default (no key configured) preserves current open behavior."
```

---

## Task 5: Update README and AGENTS.md

Reflect the route change (`/v1/health` → `/health`) and document the new auth feature.

**Files:**
- Modify: `README.md` (endpoint table + new Authentication section)
- Modify: `AGENTS.md` (mount-point Key Fact + auth opt-in note)

- [ ] **Step 1: Update `README.md` endpoint table**

Find lines 96-105 (the endpoints table). Replace with:

```markdown
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (no auth) |
| `GET` | `/v1/metrics` | Token usage, request counts, costs |
| `GET` | `/v1/agents` | List registered agents |
| `GET` | `/v1/agents/:id` | Agent detail |
| `POST` | `/v1/agents/:id/runs` | Run agent (SSE or blocking) |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/:id` | Session detail with messages |
| `DELETE` | `/v1/sessions/:id` | Delete session |
```

- [ ] **Step 2: Add `## Authentication` section to `README.md`**

Insert this section immediately after the `### Endpoints` subsection (right after the table closing line). The section goes before the existing `## Configuration` heading:

```markdown
## Authentication

The HTTP server supports optional `x-api-key` header authentication. When enabled, all `/v1/*` routes require a matching key; `/health` is always open.

### Enable via environment variable

```bash
OPENAGENT_HTTP_API_KEY=your-secret-key npm start
```

### Enable via config file

```yaml
auth:
  apiKey: your-secret-key
```

When both are set, the environment variable takes precedence. If neither is set, authentication is disabled (default — useful for local development).

### Example authenticated request

```bash
curl -H "x-api-key: your-secret-key" http://localhost:3000/v1/agents
```

Unauthenticated requests to protected routes return `401`:

```json
{ "error": "Unauthorized", "reason": "missing x-api-key header" }
```
```

- [ ] **Step 3: Update `AGENTS.md` Key Facts**

Find the line:

```
- Health router is mounted at `/v1` (not `/v1/health`) because its routes are `/health` and `/metrics`
```

Replace with two lines:

```
- Health router (`/health`) is mounted at root (no auth); metrics router is mounted at `/v1/metrics`
- `x-api-key` auth is opt-in: enabled when `OPENAGENT_HTTP_API_KEY` env var or `auth.apiKey` config field is set. Covers all `/v1/*` routes, `/health` exempt.
```

- [ ] **Step 4: Run full verification**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: entire test suite passes.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document /health move and x-api-key auth

- README: update endpoint table, add Authentication section
- AGENTS.md: replace stale mount-point note, add auth opt-in Key Fact"
```

---

## Self-Review Checklist (filled in by plan author)

**Spec coverage:**
- §3 Decisions — single key, env var name, `/health` exempt, 401 JSON: ✓ Tasks 2, 3, 4
- §4 Config Schema — `AuthConfigSchema`: ✓ Task 2
- §4.3 Resolution rule (env ?? config, undefined = no middleware): ✓ Task 4 step 3
- §5 Auth Middleware + timingSafeEqual: ✓ Task 3
- §5.3 Wiring: ✓ Task 4 step 3
- §6 Error shape `{ error, reason }`: ✓ Task 3 (asserted in auth.test.ts + auth-integration.test.ts)
- §7 Module Layout: ✓ matches file structure above
- §8 Testing matrix (9 scenarios): ✓ Task 4 step 1 covers all 9 rows from spec table
- §9 Documentation updates: ✓ Task 5
- §10 Migration note: covered via Task 1 BREAKING commit message and README update
- §12 Implementation order: ✓ Tasks 1→5 match spec order (with health split first)

**Type consistency:** `createAuthMiddleware(apiKey: string)` signature used identically in Task 3 (definition) and Task 4 (wiring). `safeCompare(a, b)` consistent. `createHealthRouter(registry)` and `createMetricsRouter(metrics)` signatures consistent across Task 1 (definition, mount, tests) and Task 4 (re-mounted).

**No placeholders:** Every step contains complete code, exact commands, expected output. No "TODO", "TBD", or "similar to Task N" references.
