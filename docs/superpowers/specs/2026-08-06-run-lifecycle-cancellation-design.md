# Run Lifecycle & Cancellation API Design

**Issue**: [#5 — feat: add addressable run lifecycle and cancellation API](https://github.com/zerone-agents/agent-runtime/issues/5)
**Date**: 2026-08-06
**Status**: Design approved, ready for implementation plan

## Goal

Give every agent execution a stable `runId` and add an idempotent
cancellation endpoint, so an external orchestrator (e.g. Runtime Gateway)
can correlate events and reliably stop an in-flight run via a separate
control-plane request.

## Scope

**In scope** (transport-level only):
- Stable `runId` per execution, exposed on SSE header/events and JSON body
- `POST /v1/runs/:runId/cancel` — idempotent cancellation endpoint
- Minimal in-memory lifecycle state machine
- Bounded terminal-state cache for idempotent repeat cancellation

**Out of scope** (per issue non-goals):
- Persistent run history
- Retry / failover policy
- Durable event replay (no reconnect mid-stream)
- GET status endpoint (terminal state is conveyed via the response itself)
- Multi-tenant / Gateway-specific task semantics

## Background — what already exists

| Capability | Location |
|---|---|
| SDK `agent.interrupt()` triggers `abortCtrl.abort()` | `agent-sdk/src/agent.ts:686-688` |
| `abortSignal` propagates to provider fetch and tool executor | `agent-sdk/src/engine.ts:212, 292, 314, 549` |
| `/v1/*` auth middleware already covers new endpoint | `src/router/index.ts:35-36` |
| Per-run `Agent` instance (1:1 with run) | `src/router/agent.ts:52`, `:130` |

**No SDK changes required.** Pure runtime-side implementation.

## Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| runId generation | Runtime-generated UUID (caller cannot supply) | Orchestrator maintains its own correlation; avoids duplicate-detection complexity and runId guessing attacks |
| SSE client disconnect | Treated as silent cancel (`agent.interrupt()`) | Cost-first: no client means no reason to keep burning tokens |
| Terminal-state cache | Bounded TTL map (5 min) | Covers client retry / network重发 window; bounded to prevent memory leak |
| Cancelled SSE event | New independent `event: cancelled` | Distinguishes unambiguously; does not pollute SDK's `result.subtype` |
| RunRegistry location | Standalone `src/runs.ts` module | Single responsibility; testable in isolation; natural extension point |

## Architecture

### Module organization

```
src/
├── runs.ts                       ★ new — RunRegistry (state machine + TTL cache)
├── registry.ts                   unchanged (only manages AgentDefinition)
├── sse.ts                        modified — injects cancelled event based on run state
├── router/
│   ├── agent.ts                  modified — registers runId, calls markTerminal
│   ├── runs.ts                   ★ new — POST /v1/runs/:runId/cancel
│   └── index.ts                  modified — wires RunRegistry + new router
└── __tests__/
    ├── runs.test.ts              ★ new — RunRegistry unit tests
    ├── router-runs.test.ts       ★ new — cancel endpoint integration
    ├── router-agent.test.ts      modified — runId assertions + cancel integration
    └── sse.test.ts               ★ new — cancelled event injection
```

### End-to-end data flow — SSE mode

```
Client                      Runtime                     SDK Agent
  │                            │                            │
  │ POST /v1/agents/X/runs     │                            │
  │ Accept: text/event-stream  │                            │
  ├───────────────────────────>│                            │
  │                            │ 1. registry.create()       │
  │                            │ 2. runsRegistry.register() │
  │                            │    → runId = uuid()        │
  │                            │ 3. agent.query()           │
  │                            ├───────────────────────────>│
  │ X-Run-ID: <uuid>           │                            │
  │ event: system              │ ◀── init system event      │
  │   data: { ..., runId }     │     decorate with runId    │
  │<───────────────────────────┤                            │
  │                            │                            │
  │ event: assistant           │ ◀── partial chunks         │
  │<───────────────────────────┤                            │
  │                            │                            │
  │ POST /v1/runs/<runId>/cancel                           │
  ├───────────────────────────>│                            │
  │                            │ 4. runsRegistry.cancel()   │
  │                            │    → state: cancelling     │
  │ 202 { runId, state }       │ 5. agent.interrupt()       │
  │<───────────────────────────┤───────────────────────────>│
  │                            │                            │ abort
  │                            │ ◀── result (success/error) │ SDK reports
  │ event: result              │                            │ inaccurately;
  │<───────────────────────────┤                            │ runtime does
  │                            │ 6. for-await exits         │ NOT trust it
  │                            │    check runState          │
  │ event: cancelled           │    write cancelled event   │
  │   data: { runId, reason }  │                            │
  │<───────────────────────────┤                            │
  │                            │ 7. markTerminal(cancelled) │
  │ event: done                │    agent.close()           │
  │<───────────────────────────┤                            │
```

### End-to-end data flow — JSON mode

```
Client                      Runtime                     SDK Agent
  │ POST /v1/agents/X/runs     │                            │
  │ Accept: application/json   │                            │
  ├───────────────────────────>│                            │
  │                            │ 1-3. same as SSE           │
  │                            │    await agent.prompt()    │
  │                            ├───────────────────────────>│
  │                            │                            │
  │ POST /v1/runs/<runId>/cancel                           │
  ├───────────────────────────>│                            │
  │                            │ agent.interrupt()          │
  │ 202 { runId, state }       │                            │
  │<───────────────────────────┤                            │
  │                            │                            │ abort
  │                            │ ◀── resolve partial        │
  │                            │   runState === cancelling  │
  │                            │   → not reported as success│
  │ 200 { runId, sessionId,    │                            │
  │      state: "cancelled",   │                            │
  │      reason, ...partial }  │                            │
  │<───────────────────────────┤                            │
```

**Pending-prompt observation**: `agent.prompt()` internally iterates
the query generator and aggregates events (`agent.ts:639-671`). When
`agent.interrupt()` fires, the SDK's abort path swallows the error
internally (`engine.ts:360-365, 426-435`) and yields a `result` event,
so `prompt()` always resolves — with partial content if cancelled
mid-stream. The JSON handler therefore does not need any special
"force-resolve" mechanism.

### Key invariants

- `runId` is generated and registered **before** any SDK call, so a
  cancel arriving before the first LLM token can still be served
- `Agent` instances are held by `RunRegistry`, not `AgentRegistry`
  (latter manages definitions only; Agents are per-run)
- `agent.close()` is called exactly once across all trigger paths
  (cancel API / SDK completion / SSE disconnect), guarded by
  `closePromise` field on the run record

## Component design

### `RunRegistry` (`src/runs.ts`)

#### Data structures

```ts
type RunState = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed'
type TerminalState = 'cancelled' | 'completed' | 'failed'
type CancelReason = 'client_request' | 'disconnect'
type TerminalReason = CancelReason | 'stream_end' | 'error' | 'shutdown'

interface RunRecord {
  runId: string
  agentId: string
  sessionId: string
  agent: Agent                  // strong ref for cancel-time interrupt()
  state: RunState
  startedAt: number             // Date.now()
  terminalAt?: number           // for TTL calculation
  terminalReason?: TerminalReason
  closePromise?: Promise<void>  // double-close guard
}

interface TerminalEntry {
  state: TerminalState
  terminalAt: number
  reason?: string
}
```

#### State machine

```
                       register()
                          │
                          ▼
                     ┌─────────┐
        ┌────────────│ running │────────────┐
        │            └────┬────┘            │
        │                 │                 │
   cancel()         markTerminal()     markTerminal()
        │            (stream_end)         (error)
        ▼                 │                 │
   ┌────────────┐         │                 │
   │ cancelling │         │                 │
   └─────┬──────┘         │                 │
         │                 │                 │
   markTerminal()          ▼                 ▼
   (client_request)   ┌──────────┐     ┌────────┐
         │            │completed │     │ failed │
         ▼            └──────────┘     └────────┘
   ┌──────────┐             ▲              ▲
   │cancelled │             │              │
   └──────────┘             │              │
        │                   │              │
        └───────────────────┴──────────────┘
                       moved to terminal map
                          │
                       TTL 5 min
                          │
                          ▼
                       auto sweep
```

**State transition rules**:
- `running → cancelling`: only by `cancel()`
- `cancelling → cancelled`: by `markTerminal('cancelled')` when SDK stream ends
- `running → completed | failed`: by `markTerminal` when SDK ends naturally
- `cancelling → completed | failed` is **forbidden** — `markTerminal` forces
  the new state to `cancelled` if the current state is `cancelling`,
  regardless of what the SDK reports (SDK misreports success on abort;
  see "SDK abort behaviour" appendix)
- Cancellation is irreversible

#### Public API

```ts
class RunRegistry {
  private readonly TTL_MS = 5 * 60 * 1000
  private active = new Map<string, RunRecord>()
  private terminal = new Map<string, TerminalEntry>()
  private sweepTimer?: NodeJS.Timeout

  constructor() {
    // Periodic sweep prevents terminal map from growing unboundedly.
    // unref() so timer never blocks process exit.
    this.sweepTimer = setInterval(() => this.sweep(), 60_000)
    this.sweepTimer.unref?.()
  }

  /** Register a new run; auto-generates runId. */
  register(rec: Omit<RunRecord, 'runId' | 'state' | 'startedAt'>): string

  /** Get run; active map takes precedence over terminal map. */
  get(runId: string): { state: RunState; agentId: string; sessionId: string; reason?: string } | undefined

  /**
   * Trigger cancellation.
   *
   * Returns:
   *   - { state: 'cancelling' }     — interrupt fired, transitioning
   *   - { state: 'cancelling' | 'cancelled', reason } — idempotent repeat
   *   - { state: 'completed' | 'failed', reason }     — non-cancel terminal (409)
   *   - undefined                                      — unknown / TTL expired (404)
   */
  cancel(runId: string, reason: CancelReason = 'client_request'):
    { state: RunState; reason?: string } | undefined

  /**
   * Mark terminal state. Moves run from active to terminal map.
   * Forces state to 'cancelled' if current state is 'cancelling',
   * regardless of newState argument.
   * Closes the Agent exactly once via closePromise guard.
   */
  markTerminal(runId: string, newState: TerminalState, reason?: string): void

  /** Test/shutdown: interrupt + markTerminal all active runs. */
  async closeAll(): Promise<void>
}
```

#### `cancel()` implementation

```ts
cancel(runId: string, reason: CancelReason = 'client_request') {
  const rec = this.active.get(runId)
  if (rec) {
    if (rec.state === 'running') {
      rec.state = 'cancelling'
      rec.terminalReason = reason
      // Fire-and-forget: cancel API returns 202 immediately,
      // does not wait for abort to actually propagate
      rec.agent.interrupt().catch(() => {})
      return { state: 'cancelling' }
    }
    if (rec.state === 'cancelling') {
      return { state: 'cancelling', reason: rec.terminalReason }
    }
    // After cancelling, run is moved to terminal map; not here.
  }

  const term = this.terminal.get(runId)
  if (term) {
    return { state: term.state, reason: term.reason }
  }

  return undefined  // 404
}
```

#### `markTerminal()` implementation

```ts
markTerminal(runId: string, newState: TerminalState, reason?: string) {
  const rec = this.active.get(runId)
  if (!rec) return  // Already terminal; idempotent no-op

  // Force-cancelled invariant: once cancelling, terminal state MUST be cancelled
  if (rec.state === 'cancelling' && newState !== 'cancelled') {
    newState = 'cancelled'
    reason = rec.terminalReason ?? 'client_request'
  }

  rec.state = newState
  rec.terminalAt = Date.now()
  rec.terminalReason = reason

  this.active.delete(runId)
  this.terminal.set(runId, {
    state: newState,
    terminalAt: rec.terminalAt,
    reason: rec.terminalReason,
  })

  // Agent close exactly once
  if (!rec.closePromise) {
    rec.closePromise = rec.agent.close()
  }
}
```

#### `sweep()`

```ts
private sweep() {
  const now = Date.now()
  for (const [id, entry] of this.terminal) {
    if (now - entry.terminalAt > this.TTL_MS) {
      this.terminal.delete(id)
    }
  }
}
```

#### `closeAll()` — graceful shutdown

```ts
async closeAll(): Promise<void> {
  clearInterval(this.sweepTimer!)

  // Snapshot active runs (markTerminal mutates the map during iteration)
  const activeRuns = [...this.active.values()]

  // Trigger cancel on each — fires agent.interrupt() and moves to terminal map
  for (const rec of activeRuns) {
    this.cancel(rec.runId, 'client_request')
    // markTerminal called by the SSE/JSON handler when SDK stream ends;
    // but in shutdown we may not wait for that, so force it here.
    this.markTerminal(rec.runId, 'cancelled', 'shutdown')
  }

  // Await any closePromises that were created during this sweep
  // (closePromise is set by markTerminal when agent.close() is first invoked)
  const closePromises = activeRuns
    .map(r => r.closePromise)
    .filter((p): p is Promise<void> => Boolean(p))
  await Promise.allSettled(closePromises)

  this.active.clear()
  this.terminal.clear()
}
```

### Router changes

#### Existing endpoint: `POST /v1/agents/:agentId/runs`

Backwards-compatible changes only:

| Mode | New content |
|---|---|
| All modes | Response header `X-Run-ID: <uuid>` |
| SSE `system` init event | `{ ..., runId }` (decorated by `sse.ts`) |
| SSE `cancelled` event | `{ runId, reason }` (conditional) |
| SSE `done` event | unchanged (`{}`) |
| JSON body | top-level `runId`; when cancelled, add `state: 'cancelled'` + `reason`; otherwise no schema change |

Handler pseudo-code:

```ts
router.post("/:agentId/runs", async (c) => {
  // ... existing message validation, agentId status checks ...

  const agent = registry.create(agentId, sessionId)
  if (!agent) return c.json({ error: "Agent not found" }, 404)

  // Register run BEFORE any SDK call, so early cancels are addressable
  const runId = runsRegistry.register({
    agent, agentId,
    sessionId: agent.getSessionId(),
  })
  c.header("X-Run-ID", runId)

  // ... existing aigc/audit prep ...

  if (responseMode === "sse-block" || responseMode === "sse-raw") {
    const agentStream = agent.query(message, { /* existing */ })
    return streamAgentResponse(c, agentStream, runId, runsRegistry, metrics, agentId, {
      aigc: aigcLabel, explicitHint,
      onTerminal: (state, reason, usage) => {
        // New: SSE mode now records metrics (previously SSE had no metrics call).
        // `usage` is undefined for cancelled runs where SDK reported result(error)
        // without usage data; metrics layer treats undefined as zero-cost.
        if (usage) metrics.recordRun(agentId, usage, undefined)
        runsRegistry.markTerminal(runId, state, reason)
      },
    })
  }

  // JSON mode
  try {
    const result = await agent.prompt(message, { /* existing */ })

    const runInfo = runsRegistry.get(runId)
    const runState = runInfo?.state
    if (runState === 'cancelling' || runState === 'cancelled') {
      // Reason comes from registry: 'client_request' (explicit API) or
      // 'disconnect' (SSE closed before prompt resolved — only possible
      // if client opened a JSON request and then closed the underlying
      // socket, which the runtime still observes via c.req.raw.signal)
      metrics.recordRun(agentId, result.usage, undefined)
      recordAudit(result.text)
      return c.json({
        runId,
        sessionId: agent.getSessionId(),
        state: 'cancelled',
        reason: runInfo?.reason ?? 'client_request',
        text: result.text,            // partial
        usage: result.usage,
        numTurns: result.num_turns,
        durationMs: result.duration_ms,
      })
    }

    metrics.recordRun(agentId, result.usage, undefined)
    recordAudit(result.text)
    return c.json({
      runId,                          // ★ new
      sessionId: agent.getSessionId(),
      text: result.text,
      // ... existing fields unchanged ...
    })
  } catch (err) {
    runsRegistry.markTerminal(runId, 'failed', 'error')
    throw err
  } finally {
    // Guard: if still running (no cancel, no error), mark completed
    // markTerminal itself is idempotent; guard is for readability
    if (runsRegistry.get(runId)?.state === 'running') {
      runsRegistry.markTerminal(runId, 'completed', 'stream_end')
    }
  }
})
```

**Note on finally guard**: the guard handles scenario ① (normal
completion); scenarios ② (cancel) and ③ (error) skip the conditional.
`markTerminal` itself is internally idempotent (no-op on second call),
so the guard is defensive — not load-bearing.

#### New endpoint: `POST /v1/runs/:runId/cancel`

New file `src/router/runs.ts`:

```ts
import { Hono } from "hono"
import type { RunRegistry } from "../runs.js"

export function createRunsRouter(runsRegistry: RunRegistry) {
  const router = new Hono()

  router.post("/:runId/cancel", (c) => {
    const { runId } = c.req.param()

    const outcome = runsRegistry.cancel(runId)
    if (!outcome) {
      return c.json({ error: "Run not found" }, 404)
    }

    if (outcome.state === 'cancelling' || outcome.state === 'cancelled') {
      return c.json({ runId, state: outcome.state, reason: outcome.reason }, 202)
    }

    // completed / failed
    return c.json({ runId, state: outcome.state, reason: outcome.reason }, 409)
  })

  return router
}
```

No `GET /v1/runs/:runId` status endpoint. Orchestrators obtain terminal
state from the response itself (SSE terminal event / JSON body). YAGNI:
issue acceptance criteria do not require it.

#### `router/index.ts` wiring

```ts
const runsRegistry = new RunRegistry()
app.route("/v1/runs", createRunsRouter(runsRegistry))
app.route("/v1/agents", createAgentRouter(registry, runsRegistry, metrics, { aigc, auditLog }))
```

`/v1/runs/*` automatically inherits the existing `/v1/*` auth middleware.

### SSE handler changes (`src/sse.ts`)

```ts
return streamSSE(c, async (stream) => {
  let cancelled = false
  try {
    for await (const event of agentStream) {
      // When agent.interrupt() fires, abortSignal propagates to engine;
      // engine breaks out of loop, generator naturally returns,
      // for-await exits normally (no throw)
      await stream.writeSSE({ event: event.type, data: JSON.stringify(decorateEvent(event, options)) })
    }
  } catch (err: any) {
    await stream.writeSSE({ event: "error", data: JSON.stringify({ error: err.message }) })
  }

  // After SDK stream ends, inspect run state to inject cancelled event
  const runInfo = runsRegistry.get(runId)
  if (runInfo?.state === 'cancelling' || runInfo?.state === 'cancelled') {
    cancelled = true
    await stream.writeSSE({
      event: "cancelled",
      data: JSON.stringify({ runId, reason: runInfo.reason ?? 'client_request' }),
    })
  }

  await stream.writeSSE({ event: "done", data: "{}" })
  await onDone?.(cancelled ? 'cancelled' : 'normal')
})

// Client disconnect = silent cancel
stream.onAbort?.(() => {
  runsRegistry.cancel(runId, 'disconnect')
})
```

**Spike required**: confirm `hono/streaming`'s `streamSSE` callback
exposes `stream.onAbort()`. If unavailable, fall back to
`c.req.raw.signal` (Web standard `Request.signal`, aborted on client
disconnect). Decision deferred to implementation phase.

## Edge cases

All covered by the idempotent state machine design; no special-case code:

| # | Scenario | Expected behaviour |
|---|---|---|
| 1 | Cancel before first LLM token | state → cancelling; SDK fetch rejects immediately (chunks=0 → rethrow → `result(error)`); handlers route through cancelled path |
| 2 | Cancel during LLM stream | state → cancelling; partial chunks retained; `result(success)` misreported; cancelled event injected |
| 3 | Cancel during tool execution | state → cancelling; tool executor breaks; `result(success)` misreported; cancelled event injected |
| 4 | Cancel after run completed/failed (race) | 409 Conflict with terminal state |
| 5 | Repeat cancel after run cancelled | 202 + state: cancelled (idempotent) |
| 6 | Repeat cancel during cancelling | 202 + state: cancelling (idempotent) |
| 7 | Unknown runId (typo / process restart) | 404 |
| 8 | Cancel after TTL expiry | 404 (terminal map cleared) |
| 9 | Cancel different runs of same agentId | Independent (each run has own Agent instance) |
| 10 | Cancel across different agentIds | Independent |
| 11 | SSE disconnect + cancel API within 5ms | JS single-threaded: first arrival sets `terminalReason`; both calls return `state: cancelling` with the first writer's reason (idempotent) |
| 12 | Cancel fires, SSE doesn't end immediately | 202 returned immediately; SSE writes cancelled once abort propagates |
| 13 | `RunRegistry.closeAll()` (graceful shutdown) | All active runs interrupted + marked cancelled; all closePromises awaited |
| 14 | Process crash | All active runs lost (no persistence) — per issue non-goal |

### Double-close guards (three trigger paths)

All converge on `markTerminal()`'s `closePromise` field:

| Trigger | Path |
|---|---|
| ① Explicit cancel API | `cancel()` → `markTerminal('cancelled')` → close |
| ② SDK natural end | SSE/JSON handler → `markTerminal('completed' / 'failed')` → close |
| ③ SSE disconnect | `stream.onAbort` → `cancel('disconnect')` → same as ① |

Plus the `finally` block in JSON handler that calls `markTerminal('completed')`
as a fallback. `markTerminal`'s `if (!rec) return` makes a second call a no-op;
`closePromise` field makes `agent.close()` strictly once.

### Metrics & audit integration

Original `metrics.recordRun(agentId, result.usage, undefined)` in JSON
success path is preserved. New behaviour by terminal state:

| Terminal state | metrics | audit |
|---|---|---|
| completed | `recordRun` (usage from result) | `recordAudit(result.text)` |
| cancelled | `recordRun` (usage from partial result; still billable) | `recordAudit(result.text)` (partial has audit value) |
| failed | not called (result may lack usage); consider `metrics.recordFailure` | not called |

**Metrics/audit stay in router handler**, not in `markTerminal`. Registry
manages state machine + close only.

## Testing

### Test file layout

```
src/__tests__/
├── runs.test.ts              ★ RunRegistry unit tests
├── router-runs.test.ts       ★ cancel endpoint integration
├── router-agent.test.ts      modified — runId assertions + cancel integration
└── sse.test.ts               ★ cancelled event injection
```

### `runs.test.ts` — RunRegistry unit

Mock Agent (only `interrupt` / `close` / `getSessionId` needed):

```ts
function makeMockAgent() {
  let _interrupted = false, _closed = false
  return {
    agent: {
      interrupt: async () => { _interrupted = true },
      close: async () => { _closed = true },
      getSessionId: () => 'test-session',
    } as any,
    interrupted: () => _interrupted,
    closed: () => _closed,
  }
}

describe("RunRegistry", () => {
  // register / get
  it("register() returns unique runId and exposes state=running")
  it("get() returns undefined for unknown runId")

  // state machine core transitions
  it("cancel() transitions running → cancelling, calls agent.interrupt()")
  it("cancel() is idempotent: 2nd call returns state=cancelling")
  it("markTerminal('completed') moves run from active to terminal map")
  it("markTerminal forces 'cancelled' when current state is cancelling")
  it("markTerminal('failed') records failure state")

  // boundaries
  it("cancel() returns cancelled for already-cancelled run (terminal map)")
  it("cancel() returns completed/failed for non-cancel terminal")
  it("cancel() returns undefined for unknown runId (404)")
  it("cancel() returns undefined after TTL expires")

  // guards
  it("markTerminal() is idempotent (2nd call is no-op)")
  it("agent.close() is called exactly once across multiple markTerminal invocations")
  it("cancel() with reason='disconnect' vs 'client_request' is recorded in terminal entry")

  // TTL
  it("sweep() removes terminal entries older than TTL_MS")
  it("sweepTimer.unref() does not block process exit")  // smoke test

  // shutdown
  it("closeAll() interrupts and marks all active runs as cancelled")
})
```

### `router-runs.test.ts` — cancel endpoint integration

Maps directly to issue acceptance criteria:

```ts
describe("POST /v1/runs/:runId/cancel", () => {
  it("returns 202 and state=cancelling for an active running run")
  it("triggers agent.interrupt() exactly once")
  it("returns 202 cancelling for 2nd cancel during cancelling state")
  it("returns 202 cancelled for cancel after run has terminated as cancelled")
  it("returns 404 for unknown runId")
  it("returns 404 after TTL expires")
  it("returns 409 with state=completed when run already completed")
  it("returns 409 with state=failed when run already failed")
  it("cancelling one run does not affect another concurrent run")
  it("cancelling one run does not affect another session")
  it("requires same API key as /v1/* endpoints (401 without key)")
})
```

### `router-agent.test.ts` additions

Existing tests unchanged. Add:

```ts
describe("run lifecycle integration", () => {
  it("X-Run-ID header is present on SSE response")
  it("X-Run-ID header is present on JSON response")
  it("SSE init system event includes runId")
  it("JSON response body includes runId")
  it("X-Run-ID header, SSE init event, and JSON body all expose the same runId")
  it("emits explicit cancelled event before done when run is cancelled")
  it("cancelled event contains runId and reason")
  it("agent.close() is called exactly once when client disconnects mid-stream")
  it("agent.close() is called exactly once when cancel API fires during SSE stream")
})
```

### `sse.test.ts`

```ts
describe("streamAgentResponse with run lifecycle", () => {
  it("injects cancelled event when run state is cancelling after SDK stream ends")
  it("does not inject cancelled event when run state is running (normal completion)")
  it("does not inject cancelled event when run state is completed")
  it("calls onTerminal(state, reason) after writing terminal events")
})
```

## Documentation

Update `README.md` and `README.zh-CN.md` with a new section
"Run lifecycle & cancellation":

- runId exposure (header / SSE init event / JSON body)
- Cancel endpoint: request/response shapes, status code matrix
- SSE cancelled event format
- Client disconnect = silent cancel (cost-first rationale)
- Terminal-state cache TTL (5 min)
- Explicit non-goals (no persistent history, no reconnect)

## Appendix: SDK abort behaviour reference

SDK's abort path was traced to confirm runtime does not need to modify SDK.
Key files: `agent-sdk/src/engine.ts`, `agent-sdk/src/agent.ts`.

When `agent.interrupt()` fires `abortCtrl.abort()`:

| Timing | Engine path | SDK result event |
|---|---|---|
| Before LLM stream starts | `:212` break out of while loop | `result(success)` (mislabeled) |
| During LLM stream, no chunks yet | fetch rejects → `:360` catch, chunks.length=0 → rethrow → `:404` outer catch | `result(error_type)` |
| During LLM stream, partial chunks | fetch rejects → `:360` catch, chunks>0 → swallow, streamTruncated=true | `result(success)` (mislabeled) |
| During tool execution | `:549` break → next turn `:212` break | `result(success)` (mislabeled) |

**Critical**: `result.subtype` (`:563-567`) only considers budget/maxTurns,
never inspects `abortSignal`. So SDK's terminal event is **unreliable**
for distinguishing abort from success. Runtime MUST inject its own
`cancelled` SSE event based on run registry state — never trust
`result.subtype` for cancellation semantics.

**Side effect (not addressed in this design)**: SDK still pushes a
partial assistant message to conversation history (`:457`) after abort.
Session resume will include this partial message. This is SDK behaviour,
outside this issue's scope (issue explicitly excludes persistent storage
concerns).
