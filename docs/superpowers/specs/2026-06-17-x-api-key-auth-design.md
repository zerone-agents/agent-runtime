# Design: `x-api-key` Authentication for HTTP Server

**Date:** 2026-06-17
**Status:** Spec — pending implementation plan

## 1. Goal

Add HTTP-level authentication to the `agent-runtime` HTTP server via the `x-api-key` request header. Prevent unauthorized access to agent execution, session data, and metrics.

## 2. Non-Goals

- Per-client identity, RBAC, or audit logging (single shared key only).
- Rate limiting, IP allowlisting, or mTLS.
- Key rotation tooling or admin API for key management.
- Authentication for SDK-internal or programmatic (`createApp`) callers — they bypass HTTP entirely.

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Key granularity | **Single shared key** | Matches small-team / personal deployment; simplest schema. |
| Key source | **Config file + env var override** | Local dev convenience via yaml; production secret via env, never committed. |
| Env var name | `OPENAGENT_HTTP_API_KEY` | Disambiguated from `OPENAGENT_API_KEY`, which the SDK uses for upstream LLM calls. The `_HTTP_` segment scopes this var to the runtime HTTP layer. |
| Protected routes | **All `/v1/*` routes.** `/health` is moved out of `/v1` to root (no auth). | Auth middleware becomes `app.use("/v1/*", auth)` — no skip logic. `/metrics` stays under `/v1/metrics` (may leak call data), `/health` is the only unauthenticated endpoint. |
| Failure response | `401` JSON `{ error, reason }` | Consistent with existing error shape. |
| Auth disabled when | **No key configured** (env + config both absent) | Local dev zero-friction; production can't accidentally bypass since they must set a key. |

## 4. Configuration Schema

Extend `RuntimeConfigSchema` with an optional `auth` section.

### 4.1 Zod Schema (`src/config.ts`)

```ts
const AuthConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
})

export const RuntimeConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  cors: CorsConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),       // NEW
  agents: z.array(AgentDefinitionSchema).min(1),
})
```

### 4.2 YAML Example

```yaml
auth:
  apiKey: "local-dev-key-keep-secret"
```

### 4.3 Resolution Rule

The effective API key is computed at startup, **not per-request**:

```
effectiveApiKey = process.env.OPENAGENT_HTTP_API_KEY ?? config.auth?.apiKey
```

- If neither is set → `effectiveApiKey` is `undefined` → **auth middleware is not installed**.
- If either is set → middleware installed, every protected request must present a matching `x-api-key`.

This means: setting env var in production automatically enables auth without touching yaml.

## 5. Authentication Middleware

Single Hono middleware applied once in `createApp` before route registration.

### 5.1 Implementation Sketch (`src/auth.ts` — new file)

```ts
import type { MiddlewareHandler } from "hono"

export function createAuthMiddleware(apiKey: string): MiddlewareHandler {
  return async (c, next) => {
    const provided = c.req.header("x-api-key")
    if (!provided) {
      return c.json({ error: "Unauthorized", reason: "missing x-api-key header" }, 401)
    }
    if (provided !== apiKey) {
      return c.json({ error: "Unauthorized", reason: "invalid api key" }, 401)
    }
    await next()
  }
}
```

### 5.2 Comparison: constant-time

Use `crypto.timingSafeEqual` to prevent timing attacks. Both buffers must be same length; if not, fail fast (do not disclose length via timing).

```ts
import { timingSafeEqual } from "node:crypto"

function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
```

### 5.3 Wiring (`src/router/index.ts`)

Mount `/health` at root level (no auth). All `/v1/*` routes are protected by a single `app.use("/v1/*", auth)` middleware — no skip logic, no exemptions. New `/v1/*` routes are protected by default.

```ts
import { createAuthMiddleware } from "../auth.js"
import { createHealthRouter, createMetricsRouter } from "./health.js"

export function createApp(config, registry, metrics) {
  const app = new Hono()

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  // Unauthenticated health probe at root level
  app.route("/", createHealthRouter(registry))

  const apiKey = process.env.OPENAGENT_HTTP_API_KEY ?? config.auth?.apiKey
  if (apiKey) {
    app.use("/v1/*", createAuthMiddleware(apiKey))
  }

  // All v1 routes (authed if key configured)
  app.route("/v1/metrics", createMetricsRouter(metrics))
  app.route("/v1/agents", createAgentRouter(registry, metrics))
  app.route("/v1/sessions", createSessionRouter())

  return app
}
```

**Rationale:** Separating `/health` from `/v1/*` eliminates the per-request skip check. New `/v1/*` routes are protected automatically. Prometheus/LB probes hit `/health` without credentials.

## 6. Error Response Shape

Consistent with existing errors in `src/router/agent.ts`:

```json
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Unauthorized",
  "reason": "missing x-api-key header"   // or "invalid api key"
}
```

No `WWW-Authenticate` header — this isn't HTTP Basic; custom header scheme has no standard challenge.

## 7. Module Layout

```
src/
├── auth.ts                  ← NEW: createAuthMiddleware, safeCompare
├── config.ts                ← MODIFIED: add AuthConfigSchema
└── router/
    ├── index.ts             ← MODIFIED: install auth middleware, restructure route mounts
    └── health.ts            ← MODIFIED: split into createHealthRouter (/health) + createMetricsRouter (/metrics)
```

No changes to `agent.ts`, `session.ts`, `metrics.ts`, `registry.ts`, `sse.ts`.

## 8. Testing

Vitest, no config file, mocks SDK and fs. Use `app.request()` directly.

### 8.1 New test file: `src/__tests__/auth.test.ts`

Test matrix:

| Scenario | Expected |
|---|---|
| No key configured (`apiKey` undefined) | All routes open, middleware not installed |
| Key configured, request with correct `x-api-key` | 200 |
| Key configured, request with wrong `x-api-key` | 401, `reason: "invalid api key"` |
| Key configured, request without `x-api-key` | 401, `reason: "missing x-api-key header"` |
| Key configured, `GET /health` without header | 200 (root, unauthenticated) |
| Key configured, `GET /v1/metrics` without header | 401 |
| Key configured, `GET /v1/agents` without header | 401 |
| Env var `OPENAGENT_HTTP_API_KEY` set, yaml `auth.apiKey` set | Env var wins |
| Env var unset, yaml `auth.apiKey` set | yaml value used |

### 8.2 Test setup pattern

```ts
beforeEach(() => {
  delete process.env.OPENAGENT_HTTP_API_KEY
})

it("rejects request without header when key configured", async () => {
  const app = createApp(configWithAuth({ apiKey: "secret" }), registry, metrics)
  const res = await app.request("/v1/agents", { headers: {} })
  expect(res.status).toBe(401)
})
```

## 9. Documentation Updates

- `README.md`: add "Authentication" section showing both yaml and env var usage; update any route examples that reference `/v1/health` to use `/health`.
- `AGENTS.md`: replace the existing line *"Health router is mounted at `/v1` (not `/v1/health`) because its routes are `/health` and `/metrics`"* with the new mounting scheme: `/health` at root (no auth), `/v1/metrics` under `/v1`; add a Key Fact that auth is opt-in via `OPENAGENT_HTTP_API_KEY` / `auth.apiKey`.

## 10. Migration / Backward Compatibility

- **Auth behavior is backward compatible.** Default behavior (no `auth` config, no env var) is identical to current open server.
- **Route path change is BREAKING for `/health` consumers.** `/v1/health` → `/health`. Any existing LB/K8s probes, monitoring dashboards, or curl scripts pointing at `/v1/health` must be updated to `/health`. `/v1/metrics` is unchanged.
- Users adopting auth simply set `OPENAGENT_HTTP_API_KEY` or add `auth:` block.

## 11. Open Questions

None remaining. All deferred items (multi-key, RBAC, rate limit, mTLS) are explicit non-goals.

## 12. Implementation Order (suggested for the plan phase)

1. Split `src/router/health.ts` into `createHealthRouter` (`/health`) + `createMetricsRouter` (`/metrics`); mount `/health` at root and `/v1/metrics` under `/v1` in `src/router/index.ts`. Update `src/__tests__/` health/metrics assertions to new paths.
2. Add `AuthConfigSchema` to `src/config.ts`.
3. Create `src/auth.ts` with `createAuthMiddleware` + `safeCompare`.
4. Wire `app.use("/v1/*", createAuthMiddleware(apiKey))` into `src/router/index.ts` when key is present.
5. Write `src/__tests__/auth.test.ts`.
6. Update README (new `/health` path + auth section) and AGENTS.md (mount-point change).
7. `tsc --noEmit` → `npm test` → commit.
