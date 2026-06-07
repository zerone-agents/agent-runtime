# AGENTS.md

## Commands

```bash
npm run build          # tsc → dist/
npm run start          # node --import tsx src/index.ts (dev, no build needed)
npm test               # vitest (all tests)
npx vitest run src/__tests__/config.test.ts  # single test file
npx tsc --noEmit       # typecheck only
```

Run order before committing: `tsc --noEmit` → `npm test`

## Architecture

HTTP Server runtime wrapping `@zerone-agent/open-agent-sdk`. Single package, no monorepo.

- `src/config.ts` — YAML + TS config loading (`agent.config.ts` loaded via `tsx/esm` + dynamic import)
- `src/registry.ts` — `AgentRegistry` holds SDK `Agent` instances, created at startup and reused across requests
- `src/router/` — Hono routes: agent runs (SSE + blocking), session CRUD, health/metrics
- `src/sse.ts` — bridges `AsyncGenerator<SDKMessage>` to Hono SSE stream
- `src/metrics.ts` — in-memory counters, no persistence
- `src/index.ts` — CLI entry + public API exports; `main()` only runs when invoked directly (not on import)

## Key Facts

- ESM only (`"type": "module"`, `NodeNext` module resolution) — all local imports must use `.js` extension
- `discoverConfig()` is async — it dynamically imports `agent.config.ts`
- `AgentRegistry.register(id, agent)` exists for programmatic use; `loadFromConfig()` is the YAML path
- Config priority: `agent.config.ts` > `agents.yaml` > cwd > `~/.openagent/`
- Health router is mounted at `/v1` (not `/v1/health`) because its routes are `/health` and `/metrics`
- `defineConfig` is exported for TS config users — provides `RuntimeConfig` type inference
- The `bin` field points to `dist/index.js` — requires `npm run build` before publish
- `prepublishOnly` runs build automatically
- Sibling SDK at `@zerone-agent/open-agent-sdk` is the only runtime dependency on our own packages

## Testing

- Vitest, no config file (uses defaults)
- Tests mock `@zerone-agent/open-agent-sdk` and `node:fs` — no real API calls or file I/O
- Hono routes tested via `app.request()` (no HTTP server needed)
- `src/__tests__/` only — vitest picks up this pattern by default
