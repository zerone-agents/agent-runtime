# Per-Request Agent Factory Design

Date: 2026-06-11

## Problem

Current runtime creates Agent instances at startup and reuses them across all requests. This causes:

1. **sessionId override is broken** — runtime passes `sessionId` as a per-query override to `agent.query()`, but the SDK ignores it for session management. The agent's internal `this.sid` and history are never reset between requests.
2. **No real session isolation** — all requests to the same agent share the same growing history. There's no way to resume a specific session.
3. **SDK resume vs sessionId confusion** — SDK uses `resume` to load history and `sessionId` to set ID. Runtime passes `sessionId` but should pass `resume`.

## Decision

**Only modify the runtime side.** Use the SDK's existing `resume` field to achieve per-request session isolation.

## Design

### Registry → Pure Factory

**Before:** `AgentRegistry` stores live `Agent` instances created at startup.

**After:** `AgentRegistry` stores agent definitions and pre-computed `createAgent()` parameters. A new `create(agentId, sessionId?)` method builds a fresh Agent per request.

```ts
class AgentRegistry {
  private defs = new Map<string, AgentDefinition>()
  private createOpts = new Map<string, CreateAgentOptions>()

  loadFromConfig(config, configDir)   // stores definitions only, no Agent creation
  register(id, definition, createOpts) // programmatic registration
  create(agentId, sessionId?: string)  // creates new Agent per request
  list()                               // based on defs
  getStatus(agentId)                   // based on defs existence
}
```

**`create()` method:**
1. Get pre-computed options from `createOpts`
2. If `sessionId` provided, merge `{ resume: sessionId }`
3. Call `createAgent(mergedOpts)`
4. Return new Agent instance (caller is responsible for `close()`)

**`loadFromConfig()` change:**
- No longer calls `createAgent()`
- Parses definitions → computes createAgent options → stores in maps
- Failed agents (e.g., missing systemPromptFile) marked as unavailable

### Router → Per-Request Lifecycle

**`POST /v1/agents/:agentId/runs` flow:**

```
1. registry.create(agentId, sessionId)  →  new Agent
2. agent.query(message, overrides)      →  execute (no sessionId in overrides)
3. stream or collect response
4. finally: agent.close()               →  release resources
```

- **Streaming mode:** close after SSE stream ends (in `streamAgentResponse` completion callback)
- **Blocking mode:** close after `agent.prompt()` returns
- **Response:** always includes `sessionId: agent.getSessionId()` for client to pass back on next request
- **Overrides:** `sessionId` removed from overrides; only `includePartialMessages` and other SDK-supported overrides remain

### Metrics

- Streaming mode now records a request count in finally block (previously it didn't)
- Blocking mode metrics unchanged (token count, duration, etc.)

### Unchanged

- `src/router/session.ts` — continues using SDK global session methods
- `src/router/health.ts` — unchanged
- `src/sse.ts` — unchanged
- `src/config.ts` — unchanged
- `src/metrics.ts` — unchanged
- Public API exports — `register()` signature changes, rest unchanged

## Trade-offs

- **Proper session isolation** — each request gets its own Agent + history
- **Clean resume semantics** — `sessionId` from response → `sessionId` in next request → auto-resume
- **Cold start per request** — MCP connections and skill loading happen on each request. Acceptable for current scale (millisecond-level overhead).
- **No more shared state bugs** — eliminates the `overrides.sessionId` being silently ignored

## Files to Modify

1. `src/registry.ts` — refactor to factory pattern
2. `src/router/agent.ts` — per-request create/close lifecycle
3. `src/index.ts` — adapt `loadFromConfig` call, update public API types
4. `src/__tests__/registry.test.ts` — rewrite tests for factory pattern
5. `src/__tests__/router-agent.test.ts` — update tests for per-request lifecycle
6. `examples/` — update if any example relies on current registry API
