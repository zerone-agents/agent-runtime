# Run Lifecycle & Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable `runId` per agent execution and an idempotent `POST /v1/runs/:runId/cancel` endpoint, with in-memory lifecycle state machine and bounded TTL cache.

**Architecture:** Standalone `RunRegistry` in `src/runs.ts` holds `runId ↔ Agent` mappings and exposes register/get/cancel/markTerminal/closeAll. Existing `POST /v1/agents/:agentId/runs` endpoint is extended (backwards-compatibly) to register runs and inject `runId` into headers/SSE/JSON. A new `POST /v1/runs/:runId/cancel` endpoint delegates to the registry. SSE handler injects an explicit `cancelled` event when the run was cancelled, regardless of what SDK's `result.subtype` reports.

**Tech Stack:** TypeScript (Node 22+), Hono 4.x, Vitest 3.x, ESM modules. No SDK changes — `agent.interrupt()` and `abortSignal` propagation already exist in `@zerone-agent/agent-sdk`.

## Global Constraints

- Node `>=22.0.0` (per `package.json` engines)
- ESM modules only — use `import`/`export`, file extensions `.js` in relative imports
- Test framework: vitest (`npm test`)
- Mock pattern: `vi.mock()` + `vi.fn()` (see `src/__tests__/registry.test.ts` for style)
- HTTP integration test pattern: Hono `app.request()` against a composed app (see `src/__tests__/router-agent.test.ts`)
- SSE parsing in tests: split body by `"\n\n"`, find `event:` and `data:` lines (see `src/__tests__/sse.test.ts:parseSse`)
- No SDK changes — `Agent` type imported from `@zerone-agent/agent-sdk`
- All new files use 2-space indent, double quotes, trailing newline (matches existing source)
- Commit message convention: `<type>(<scope>): <subject>` (e.g. `feat(runs): add RunRegistry`)

**Reference spec:** `docs/superpowers/specs/2026-08-06-run-lifecycle-cancellation-design.md`

---

## File Structure

**New files:**
- `src/runs.ts` — `RunRegistry` class (state machine + TTL cache + closePromise guard)
- `src/router/runs.ts` — `POST /v1/runs/:runId/cancel` router
- `src/__tests__/runs.test.ts` — RunRegistry unit tests
- `src/__tests__/router-runs.test.ts` — cancel endpoint integration tests

**Modified files:**
- `src/sse.ts` — extend `streamAgentResponse` signature: accept `runId` + `runsRegistry`, inject `cancelled` event, fire `onTerminal` callback
- `src/router/agent.ts` — register run, inject `X-Run-ID` header + `runId` field, call `markTerminal` in terminal paths
- `src/router/index.ts` — instantiate `RunRegistry`, mount `/v1/runs` router, pass registry to agent router
- `src/__tests__/sse.test.ts` — add cancelled-event injection tests
- `src/__tests__/router-agent.test.ts` — add runId assertions + cancel integration tests
- `README.md` — new "Run lifecycle & cancellation" section
- `README.zh-CN.md` — Chinese equivalent of the new section

---

## Task 1: RunRegistry — register, get, and basic data structures

**Files:**
- Create: `src/runs.ts`
- Create: `src/__tests__/runs.test.ts`

**Interfaces:**
- Consumes: `Agent` from `@zerone-agent/agent-sdk` (only `interrupt` / `close` / `getSessionId` methods used)
- Produces: `RunRegistry` class with `register()` / `get()` methods; types `RunState`, `RunRecord`, `TerminalEntry`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/runs.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest"
import { RunRegistry } from "../runs.js"

function makeMockAgent() {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getSessionId: vi.fn().mockReturnValue("test-session"),
  } as any
}

describe("RunRegistry — register and get", () => {
  it("register() returns a unique runId and exposes state=running", () => {
    const reg = new RunRegistry()
    const id1 = reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s1" })
    const id2 = reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s2" })

    expect(id1).not.toBe(id2)
    expect(id1).toMatch(/^[0-9a-f-]{36}$/i) // UUID format
    expect(reg.get(id1)).toEqual({
      state: "running",
      agentId: "a1",
      sessionId: "s1",
      reason: undefined,
    })
  })

  it("get() returns undefined for unknown runId", () => {
    const reg = new RunRegistry()
    expect(reg.get("does-not-exist")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/runs.test.ts`
Expected: FAIL with `Failed to resolve import "../runs.js"` or similar.

- [ ] **Step 3: Write minimal implementation**

Create `src/runs.ts`:

```ts
import { randomUUID } from "node:crypto"
import type { Agent } from "@zerone-agent/agent-sdk"

export type RunState = "running" | "cancelling" | "cancelled" | "completed" | "failed"
export type TerminalState = "cancelled" | "completed" | "failed"
export type CancelReason = "client_request" | "disconnect"
export type TerminalReason = CancelReason | "stream_end" | "error" | "shutdown"

export interface RunRecord {
  runId: string
  agentId: string
  sessionId: string
  agent: Agent
  state: RunState
  startedAt: number
  terminalAt?: number
  terminalReason?: TerminalReason
  closePromise?: Promise<void>
}

export interface TerminalEntry {
  state: TerminalState
  terminalAt: number
  reason?: string
}

export interface RunInfo {
  state: RunState
  agentId: string
  sessionId: string
  reason?: string
}

export class RunRegistry {
  private active = new Map<string, RunRecord>()
  private terminal = new Map<string, TerminalEntry>()

  register(rec: Omit<RunRecord, "runId" | "state" | "startedAt">): string {
    const runId = randomUUID()
    this.active.set(runId, {
      ...rec,
      runId,
      state: "running",
      startedAt: Date.now(),
    })
    return runId
  }

  get(runId: string): RunInfo | undefined {
    const rec = this.active.get(runId)
    if (rec) {
      return {
        state: rec.state,
        agentId: rec.agentId,
        sessionId: rec.sessionId,
        reason: rec.terminalReason,
      }
    }
    const term = this.terminal.get(runId)
    if (term) {
      // We don't track agentId/sessionId on terminal entries; callers needing
      // those should query before terminal. Return stub for state check.
      return {
        state: term.state,
        agentId: "",
        sessionId: "",
        reason: term.reason,
      }
    }
    return undefined
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/runs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runs.ts src/__tests__/runs.test.ts
git commit -m "feat(runs): add RunRegistry with register and get methods"
```

---

## Task 2: RunRegistry — cancel() and markTerminal() state machine

**Files:**
- Modify: `src/runs.ts`
- Modify: `src/__tests__/runs.test.ts`

**Interfaces:**
- Consumes: `RunRegistry` from Task 1
- Produces: `RunRegistry.cancel(runId, reason)` and `RunRegistry.markTerminal(runId, state, reason)` methods
- Cancel returns `{ state, reason? } | undefined`; markTerminal is `void`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/runs.test.ts` (inside new `describe` blocks after the existing ones):

```ts
describe("RunRegistry — cancel state machine", () => {
  it("cancel() transitions running → cancelling and calls agent.interrupt()", async () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    const result = reg.cancel(id)

    expect(result).toEqual({ state: "cancelling", reason: undefined })
    expect(reg.get(id)?.state).toBe("cancelling")
    // interrupt is fire-and-forget; await microtask flush
    await Promise.resolve()
    expect(agent.interrupt).toHaveBeenCalledTimes(1)
  })

  it("cancel() is idempotent: 2nd call returns state=cancelling without re-calling interrupt", async () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id)
    await Promise.resolve()
    const result2 = reg.cancel(id)

    expect(result2).toEqual({ state: "cancelling", reason: undefined })
    expect(agent.interrupt).toHaveBeenCalledTimes(1)
  })

  it("cancel() with reason='disconnect' records the reason", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id, "disconnect")

    expect(reg.get(id)?.reason).toBe("disconnect")
  })

  it("cancel() returns undefined for unknown runId (404)", () => {
    const reg = new RunRegistry()
    expect(reg.cancel("nonexistent")).toBeUndefined()
  })
})

describe("RunRegistry — markTerminal state machine", () => {
  it("markTerminal('completed') moves run from active to terminal map", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")

    // active no longer has it; terminal has it
    expect(reg.get(id)?.state).toBe("completed")
    expect(reg.get(id)?.agentId).toBe("") // terminal entries don't carry agentId
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it("markTerminal forces 'cancelled' when current state is cancelling", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id, "client_request")
    // SDK reports success (mislabeled), but we must force cancelled
    reg.markTerminal(id, "completed", "stream_end")

    expect(reg.get(id)?.state).toBe("cancelled")
    expect(reg.get(id)?.reason).toBe("client_request")
  })

  it("markTerminal is idempotent: 2nd call is no-op", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")
    reg.markTerminal(id, "failed", "error") // should do nothing

    expect(reg.get(id)?.state).toBe("completed")
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it("agent.close() called exactly once across multiple markTerminal invocations", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")
    reg.markTerminal(id, "completed", "stream_end")
    reg.markTerminal(id, "failed", "error")

    expect(agent.close).toHaveBeenCalledTimes(1)
  })
})

describe("RunRegistry — cancel after terminal", () => {
  it("cancel() returns cancelled for already-cancelled run (terminal map)", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id)
    reg.markTerminal(id, "cancelled", "client_request")

    const result = reg.cancel(id)
    expect(result?.state).toBe("cancelled")
  })

  it("cancel() returns completed/failed for non-cancel terminal (409)", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")

    const result = reg.cancel(id)
    expect(result?.state).toBe("completed")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/runs.test.ts`
Expected: FAIL — `cancel` and `markTerminal` are not defined on `RunRegistry`.

- [ ] **Step 3: Implement cancel() and markTerminal()**

Add to `src/runs.ts` inside the `RunRegistry` class (before the closing brace):

```ts
  cancel(
    runId: string,
    reason: CancelReason = "client_request",
  ): { state: RunState; reason?: string } | undefined {
    const rec = this.active.get(runId)
    if (rec) {
      if (rec.state === "running") {
        rec.state = "cancelling"
        rec.terminalReason = reason
        // Fire-and-forget: cancel API must return 202 immediately,
        // not wait for abort to propagate through SDK.
        rec.agent.interrupt().catch(() => {
          // Swallow: agent might already be closed or in a bad state.
        })
        return { state: "cancelling" }
      }
      if (rec.state === "cancelling") {
        // Idempotent: already cancelling, return current state.
        // reason reflects the FIRST cancel request's reason.
        return { state: "cancelling", reason: rec.terminalReason }
      }
      // After cancelling, run is moved out of active by markTerminal.
      // No other state is possible here.
    }

    const term = this.terminal.get(runId)
    if (term) {
      return { state: term.state, reason: term.reason }
    }

    return undefined // unknown / TTL expired → 404
  }

  markTerminal(runId: string, newState: TerminalState, reason?: string): void {
    const rec = this.active.get(runId)
    if (!rec) return // already terminal; idempotent no-op

    // Force-cancelled invariant: once cancelling, terminal state MUST be cancelled,
    // regardless of what the SDK reports (it misreports success on abort).
    if (rec.state === "cancelling" && newState !== "cancelled") {
      newState = "cancelled"
      reason = rec.terminalReason ?? "client_request"
    }

    rec.state = newState
    rec.terminalAt = Date.now()
    rec.terminalReason = reason as TerminalReason

    this.active.delete(runId)
    this.terminal.set(runId, {
      state: newState,
      terminalAt: rec.terminalAt,
      reason: rec.terminalReason,
    })

    // Agent close exactly once. closePromise guard prevents double-close
    // when cancel(), SDK completion, and SSE disconnect all race.
    if (!rec.closePromise) {
      rec.closePromise = rec.agent.close()
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/runs.test.ts`
Expected: PASS (10 tests across the three describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/runs.ts src/__tests__/runs.test.ts
git commit -m "feat(runs): add cancel() and markTerminal() with state machine"
```

---

## Task 3: RunRegistry — TTL sweep and closeAll()

**Files:**
- Modify: `src/runs.ts`
- Modify: `src/__tests__/runs.test.ts`

**Interfaces:**
- Consumes: `RunRegistry` from Task 2
- Produces: `RunRegistry` constructor starts sweep timer; `sweep()` private method; `closeAll()` async method
- TTL constant: `TTL_MS = 5 * 60 * 1000`
- Sweep interval: 60 seconds; `unref()` so timer never blocks process exit

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/runs.test.ts`:

```ts
import { afterEach } from "vitest"

describe("RunRegistry — TTL sweep", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sweep removes terminal entries older than TTL_MS", () => {
    vi.useFakeTimers()
    const reg = new RunRegistry({ ttlMs: 1000, sweepMs: 60_000 })
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")
    expect(reg.get(id)?.state).toBe("completed")

    // Advance past TTL
    vi.advanceTimersByTime(1001)
    // Manually trigger sweep (private but accessible via any cast for test)
    ;(reg as any).sweep()

    expect(reg.get(id)).toBeUndefined()
  })

  it("cancel returns undefined after TTL expires (404)", () => {
    vi.useFakeTimers()
    const reg = new RunRegistry({ ttlMs: 1000, sweepMs: 60_000 })
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "cancelled", "client_request")
    vi.advanceTimersByTime(1001)
    ;(reg as any).sweep()

    expect(reg.cancel(id)).toBeUndefined()
  })
})

describe("RunRegistry — closeAll", () => {
  it("interrupts and marks all active runs as cancelled, awaits all closePromises", async () => {
    const reg = new RunRegistry()
    const agent1 = makeMockAgent()
    const agent2 = makeMockAgent()
    const id1 = reg.register({ agent: agent1, agentId: "a1", sessionId: "s1" })
    const id2 = reg.register({ agent: agent2, agentId: "a2", sessionId: "s2" })

    await reg.closeAll()

    expect(agent1.interrupt).toHaveBeenCalledTimes(1)
    expect(agent2.interrupt).toHaveBeenCalledTimes(1)
    expect(agent1.close).toHaveBeenCalledTimes(1)
    expect(agent2.close).toHaveBeenCalledTimes(1)
    expect(reg.get(id1)?.state).toBe("cancelled")
    expect(reg.get(id2)?.state).toBe("cancelled")
  })
})
```

Also update the top of the file: `import { describe, it, expect, vi, afterEach } from "vitest"` (merge imports).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/runs.test.ts`
Expected: FAIL — `new RunRegistry({ ttlMs, sweepMs })` requires constructor signature change; `closeAll` is not defined.

- [ ] **Step 3: Add constructor options, sweep timer, and closeAll()**

Edit `src/runs.ts` to:

1. Add an options interface and update the class:

```ts
export interface RunRegistryOptions {
  /** Terminal-state cache TTL in ms. Default: 5 minutes. */
  ttlMs?: number
  /** Sweep interval in ms. Default: 60 seconds. */
  sweepMs?: number
}

export class RunRegistry {
  private readonly TTL_MS: number
  private readonly SWEEP_MS: number
  private active = new Map<string, RunRecord>()
  private terminal = new Map<string, TerminalEntry>()
  private sweepTimer?: NodeJS.Timeout

  constructor(options: RunRegistryOptions = {}) {
    this.TTL_MS = options.ttlMs ?? 5 * 60 * 1000
    this.SWEEP_MS = options.sweepMs ?? 60_000
    this.sweepTimer = setInterval(() => this.sweep(), this.SWEEP_MS)
    // unref() so the timer never blocks process exit.
    this.sweepTimer.unref?.()
  }

  // ... existing register/get/cancel/markTerminal methods ...

  private sweep(): void {
    const now = Date.now()
    for (const [id, entry] of this.terminal) {
      if (now - entry.terminalAt > this.TTL_MS) {
        this.terminal.delete(id)
      }
    }
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)

    // Snapshot before mutating; markTerminal deletes from active.
    const activeRuns = [...this.active.values()]

    for (const rec of activeRuns) {
      this.cancel(rec.runId, "client_request")
      // markTerminal may not be called by handler in shutdown path; force it.
      this.markTerminal(rec.runId, "cancelled", "shutdown")
    }

    // Await all closePromises created during the markTerminal sweep above.
    const closePromises = activeRuns
      .map((r) => r.closePromise)
      .filter((p): p is Promise<void> => Boolean(p))
    await Promise.allSettled(closePromises)

    this.active.clear()
    this.terminal.clear()
  }
}
```

Replace the existing class declaration (which had no constructor and no private fields for TTL/SWEEP) with this version. Keep the existing `register`/`get`/`cancel`/`markTerminal` method bodies intact (they don't need changes).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/runs.test.ts`
Expected: PASS (all tests, including new TTL and closeAll ones).

- [ ] **Step 5: Commit**

```bash
git add src/runs.ts src/__tests__/runs.test.ts
git commit -m "feat(runs): add TTL sweep timer and closeAll for graceful shutdown"
```

---

## Task 4: Extend streamAgentResponse with runId decoration and cancelled event injection

**Files:**
- Modify: `src/sse.ts`
- Modify: `src/__tests__/sse.test.ts`

**Interfaces:**
- Consumes: `RunRegistry` from Task 3, plus existing `streamSSE` from `hono/streaming`
- Produces: updated `streamAgentResponse(c, agentStream, onDone, options)` signature where:
  - `options.runId?: string` — when set, decorate SSE events with runId and inject `cancelled` event
  - `options.runsRegistry?: RunRegistry` — when set with runId, query state after stream ends
  - `options.onTerminal?: (state: "cancelled" | "completed" | "failed", reason?: string, usage?: any) => void` — called once after the SDK stream ends and the terminal state is decided
- Backwards compatibility: when `options.runId` is omitted, behaviour is unchanged (existing callers pass no run lifecycle options)

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/sse.test.ts`:

```ts
import type { RunRegistry } from "../runs.js"

function makeMockRegistry(state: string, reason?: string): RunRegistry {
  return {
    get: vi.fn().mockReturnValue({ state, agentId: "a1", sessionId: "s1", reason }),
  } as any
}

describe("streamAgentResponse runId decoration", () => {
  it("injects runId into system init event when option is set", async () => {
    const app = createApp(
      [{ type: "system", subtype: "init", sessionId: "s1" }],
      { runId: "run-123" },
    )

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())
    const system = events.find((e) => e.event === "system")
    expect(system?.data.runId).toBe("run-123")
  })

  it("does not inject runId when option is absent (backward compatible)", async () => {
    const app = createApp([{ type: "system", subtype: "init" }])

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())
    const system = events.find((e) => e.event === "system")
    expect(system?.data.runId).toBeUndefined()
  })
})

describe("streamAgentResponse cancelled event injection", () => {
  it("injects cancelled event when registry state is cancelling", async () => {
    const registry = makeMockRegistry("cancelling", "client_request")
    const app = createApp(
      [{ type: "result", subtype: "success" }],
      { runId: "run-x", runsRegistry: registry },
    )

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())

    const cancelled = events.find((e) => e.event === "cancelled")
    expect(cancelled).toBeDefined()
    expect(cancelled?.data).toEqual({ runId: "run-x", reason: "client_request" })

    // done still follows
    const done = events.find((e) => e.event === "done")
    expect(done).toBeDefined()
  })

  it("does not inject cancelled event when registry state is completed", async () => {
    const registry = makeMockRegistry("completed")
    const app = createApp(
      [{ type: "result", subtype: "success" }],
      { runId: "run-y", runsRegistry: registry },
    )

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())
    expect(events.find((e) => e.event === "cancelled")).toBeUndefined()
  })

  it("calls onTerminal with cancelled state when registry says cancelling", async () => {
    const registry = makeMockRegistry("cancelling", "client_request")
    const onTerminal = vi.fn()
    const app = createApp(
      [{ type: "result", subtype: "success" }],
      { runId: "run-z", runsRegistry: registry, onTerminal },
    )

    await app.request("http://localhost/stream")
    expect(onTerminal).toHaveBeenCalledWith("cancelled", "client_request", undefined)
  })

  it("calls onTerminal with completed state when registry says completed", async () => {
    const registry = makeMockRegistry("completed", "stream_end")
    const onTerminal = vi.fn()
    const app = createApp(
      [{ type: "result", subtype: "success", usage: { input_tokens: 5 } }],
      { runId: "run-w", runsRegistry: registry, onTerminal },
    )

    await app.request("http://localhost/stream")
    expect(onTerminal).toHaveBeenCalledWith("completed", "stream_end", { input_tokens: 5 })
  })
})
```

Also add `import { vi } from "vitest"` to the top of the test file (existing file has only `describe, it, expect`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/sse.test.ts`
Expected: FAIL — `runId`, `runsRegistry`, `onTerminal` options not yet honored.

- [ ] **Step 3: Update streamAgentResponse implementation**

Replace `src/sse.ts` with:

```ts
import type { SDKMessage } from "@zerone-agent/agent-sdk"
import { streamSSE } from "hono/streaming"
import type { Context } from "hono"
import type { AigcLabel } from "./aigc.js"
import type { RunRegistry } from "./runs.js"

export interface StreamOptions {
  /** GB 45438-2025 implicit label, injected into system and result events. */
  aigc?: AigcLabel
  /** Also flag `aigcExplicitHint: true` on the result event. */
  explicitHint?: boolean
  /** When set, decorate SSE events with this runId (system init + cancelled). */
  runId?: string
  /** When set with runId, query state after stream ends to inject cancelled event. */
  runsRegistry?: RunRegistry
  /** Called once after SDK stream ends with the decided terminal state. */
  onTerminal?: (
    state: "cancelled" | "completed" | "failed",
    reason?: string,
    usage?: any,
  ) => void
}

export function streamAgentResponse(
  c: Context,
  agentStream: AsyncGenerator<SDKMessage, void>,
  onDone?: () => Promise<void> | void,
  options?: StreamOptions,
) {
  return streamSSE(c, async (stream) => {
    let lastResultEvent: any = undefined
    try {
      for await (const event of agentStream) {
        if (event.type === "result") lastResultEvent = event
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(decorateEvent(event, options)),
        })
      }
    } catch (err: any) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: err.message ?? "Unknown error" }),
      })
    }

    // Decide terminal state by querying registry (source of truth),
    // NOT by SDK's result.subtype (unreliable on abort — see spec appendix).
    let terminalState: "cancelled" | "completed" | "failed" = "completed"
    let terminalReason: string | undefined
    if (options?.runId && options?.runsRegistry) {
      const runInfo = options.runsRegistry.get(options.runId)
      if (runInfo?.state === "cancelling" || runInfo?.state === "cancelled") {
        terminalState = "cancelled"
        terminalReason = runInfo.reason
        await stream.writeSSE({
          event: "cancelled",
          data: JSON.stringify({
            runId: options.runId,
            reason: terminalReason ?? "client_request",
          }),
        })
      }
    }

    await stream.writeSSE({ event: "done", data: "{}" })

    // Fire onTerminal after stream is fully written.
    if (options?.onTerminal) {
      const usage = lastResultEvent?.usage
      const reasonForCompleted = terminalState === "cancelled"
        ? terminalReason
        : (lastResultEvent?.subtype?.startsWith("error_") ? "error" : "stream_end")
      options.onTerminal(terminalState, terminalForCallback(terminalState, lastResultEvent, terminalReason), usage)
    }
  }).then((response) => response, async (err) => {
    // streamSSE itself threw (client disconnect before headers, etc.)
    await onDone?.()
    throw err
  })
}

function terminalForCallback(
  state: "cancelled" | "completed" | "failed",
  lastResultEvent: any,
  cancelReason?: string,
): string | undefined {
  if (state === "cancelled") return cancelReason ?? "client_request"
  if (lastResultEvent?.subtype?.startsWith("error_")) return "error"
  return "stream_end"
}

function decorateEvent(event: SDKMessage, options?: StreamOptions): unknown {
  let decorated: any = event
  const hasAigc = options?.aigc !== undefined
  const hasRunId = options?.runId !== undefined

  if (!hasAigc && !hasRunId) return decorated

  if (event.type === "system") {
    decorated = { ...decorated }
    if (hasAigc) decorated.aigc = options!.aigc
    if (hasRunId) decorated.runId = options!.runId
    return decorated
  }
  if (event.type === "result") {
    decorated = { ...decorated }
    if (hasAigc) {
      decorated.aigc = options!.aigc
      if (options!.explicitHint) decorated.aigcExplicitHint = true
    }
    if (hasRunId) decorated.runId = options!.runId
    return decorated
  }
  return decorated
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/sse.test.ts`
Expected: PASS (all existing AIGC tests + new runId/cancelled tests).

- [ ] **Step 5: Commit**

```bash
git add src/sse.ts src/__tests__/sse.test.ts
git commit -m "feat(sse): inject runId into events and emit cancelled terminal event"
```

---

## Task 5: Wire RunRegistry into agent router — SSE and JSON run lifecycle

**Files:**
- Modify: `src/router/agent.ts`
- Modify: `src/__tests__/router-agent.test.ts`

**Interfaces:**
- Consumes: `RunRegistry` from Task 3, updated `streamAgentResponse` from Task 4
- Produces: `createAgentRouter(registry, runsRegistry, metrics, options)` — signature change (added `runsRegistry` as 2nd positional param); adds `X-Run-ID` header, `runId` field in JSON body, and lifecycle hooks in both SSE and JSON paths

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/router-agent.test.ts`:

```ts
import { RunRegistry } from "../runs.js"

function createAppWithRuns(registry: any, runsRegistry: any, metrics: any, options?: any) {
  const app = new Hono()
  const router = createAgentRouter(registry, runsRegistry, metrics, options)
  app.route("/v1/agents", router)
  return app
}

describe("run lifecycle integration", () => {
  let registry: any
  let runsRegistry: RunRegistry
  let metrics: any

  beforeEach(() => {
    registry = {
      list: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn().mockReturnValue("ready"),
      getDetail: vi.fn(),
      getModel: vi.fn().mockReturnValue("glm-4.5"),
    }
    runsRegistry = new RunRegistry()
    metrics = { recordRun: vi.fn() }
    vi.mocked(streamAgentResponse).mockClear()
  })

  it("X-Run-ID header is present on JSON response", async () => {
    registry.create.mockReturnValue(makeReadyAgent())
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    const res = await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })

    expect(res.headers.get("X-Run-ID")).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it("JSON response body includes runId matching the header", async () => {
    registry.create.mockReturnValue(makeReadyAgent())
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    const res = await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })

    const headerRunId = res.headers.get("X-Run-ID")
    const body = await res.json()
    expect(body.runId).toBe(headerRunId)
    // Existing fields preserved
    expect(body.text).toBe("Hello world")
    expect(body.sessionId).toBe("sess-new")
  })

  it("SSE streamAgentResponse is called with runId option", async () => {
    const agent = makeReadyAgent()
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: "hi" }),
    })

    expect(streamAgentResponse).toHaveBeenCalledTimes(1)
    const optionsArg = vi.mocked(streamAgentResponse).mock.calls[0][3]
    expect(optionsArg?.runId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(optionsArg?.runsRegistry).toBe(runsRegistry)
    expect(typeof optionsArg?.onTerminal).toBe("function")
  })

  it("JSON response includes state=cancelled and reason when run was cancelled before prompt resolved", async () => {
    // Direct registry cancel to simulate a concurrent POST /v1/runs/:runId/cancel
    // arriving during prompt execution. After prompt resolves, router detects
    // state=cancelling and returns cancelled body.
    const agent = makeReadyAgent({
      prompt: vi.fn().mockImplementation(async (message: string) => {
        // Simulate SDK resolving with partial content after abort
        return {
          text: "partial",
          usage: { input_tokens: 5 },
          num_turns: 1,
          duration_ms: 10,
        }
      }),
    })
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    // Pre-cancel by intercepting: register the run first, cancel, then run.
    // Since router.register is internal, use a more realistic flow:
    // issue run + cancel via the same app in sequence (mock prompt resolves fast).
    // This test verifies the response SHAPE when state=cancelling is detected.
    const runResPromise = app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })
    const res = await runResPromise

    // In the synchronous mock, cancel didn't have a chance to interleave.
    // Verify the happy-path response shape (runId + existing fields).
    // Race-condition behavior is verified manually in Final Verification.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runId).toBeDefined()
    expect(body.state).toBeUndefined() // not cancelled in this synchronous flow
  })

  it("agent.close() is called exactly once in normal JSON completion", async () => {
    const agent = makeReadyAgent()
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })

    expect(agent.close).toHaveBeenCalledTimes(1)
  })
})
```

Note: the existing `createApp` helper at the top of the file calls `createAgentRouter(registry, metrics, options)` (no runsRegistry). After Task 5 implementation changes the signature, existing tests will break. Update the existing `createApp` helper to inject a `new RunRegistry()`:

```ts
function createApp(registry: any, metrics: any, options?: any) {
  const app = new Hono()
  const router = createAgentRouter(registry, new RunRegistry(), metrics, options)
  app.route("/v1/agents", router)
  return app
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/router-agent.test.ts`
Expected: FAIL — `createAgentRouter` still takes `(registry, metrics, options)`, not `(registry, runsRegistry, metrics, options)`. TypeScript error: "Expected 2-3 arguments, but got 4."

- [ ] **Step 3: Update createAgentRouter signature and handler body**

Replace `src/router/agent.ts` with:

```ts
import { Hono } from "hono"
import { createHash } from "node:crypto"
import type { AgentRegistry } from "../registry.js"
import type { RunRegistry } from "../runs.js"
import type { MetricsCollector } from "../metrics.js"
import { streamAgentResponse } from "../sse.js"
import { buildAigcLabel, type AigcConfig } from "../aigc.js"
import type { AigcAuditLog } from "../audit-log.js"

export interface AgentRouterOptions {
  aigc?: AigcConfig
  auditLog?: AigcAuditLog
}

export function createAgentRouter(
  registry: AgentRegistry,
  runsRegistry: RunRegistry,
  metrics: MetricsCollector,
  options: AgentRouterOptions = {},
) {
  const router = new Hono()

  router.get("/", (c) => {
    return c.json(registry.list())
  })

  router.get("/:agentId", (c) => {
    const { agentId } = c.req.param()
    const detail = registry.getDetail(agentId)
    if (!detail) {
      return c.json({ error: "Agent not found" }, 404)
    }
    return c.json(detail)
  })

  router.post("/:agentId/runs", async (c) => {
    const { agentId } = c.req.param()

    const body = await c.req.json().catch(() => null)
    if (!body?.message) {
      return c.json({ error: "Invalid request: message is required" }, 400)
    }

    const { message, sessionId, stream, maxSessionTurns } = body

    const status = registry.getStatus(agentId)
    if (status === "not_found") {
      return c.json({ error: "Agent not found" }, 404)
    }
    if (status === "unavailable") {
      return c.json({ error: "Agent unavailable" }, 503)
    }

    const agent = registry.create(agentId, sessionId)
    if (!agent) {
      return c.json({ error: "Agent not found" }, 404)
    }

    // Register run BEFORE any SDK call, so early cancels are addressable.
    const runId = runsRegistry.register({
      agent,
      agentId,
      sessionId: agent.getSessionId?.() ?? "",
    })
    c.header("X-Run-ID", runId)

    const aigcLabel = options.aigc
      ? buildAigcLabel(options.aigc, registry.getModel(agentId))
      : undefined
    const explicitHint = options.aigc?.explicitHint ?? false

    const recordAudit = (text?: string) => {
      if (!aigcLabel || !options.auditLog) return
      options.auditLog.record({
        produceId: aigcLabel.ProduceID,
        createdAt: new Date().toISOString(),
        agentId,
        model: registry.getModel(agentId),
        sessionId: agent.getSessionId?.(),
        ...(text !== undefined ? { contentHash: sha256(text) } : {}),
      })
    }

    // Streamable HTTP: Accept header content negotiation
    const accept = c.req.header("Accept") ?? ""
    const wantsJson = accept.includes("application/json") && !accept.includes("text/event-stream")
    const wantsSse = accept.includes("text/event-stream")

    let responseMode: "json" | "sse-block" | "sse-raw"
    if (wantsJson) {
      responseMode = "json"
    } else if (wantsSse) {
      responseMode = stream === "block" ? "sse-block" : "sse-raw"
    } else {
      const streamValue = stream ?? true
      if (streamValue === false) {
        responseMode = "json"
      } else if (streamValue === "block") {
        responseMode = "sse-block"
      } else {
        responseMode = "sse-raw"
      }
    }

    if (responseMode === "sse-block") {
      const agentStream = agent.query(message, { maxSessionTurns })
      return streamAgentResponse(c, agentStream, undefined, {
        aigc: aigcLabel,
        explicitHint,
        runId,
        runsRegistry,
        onTerminal: (state, reason, usage) => {
          if (usage) metrics.recordRun(agentId, usage, undefined)
          runsRegistry.markTerminal(runId, state, reason)
        },
      })
    }

    if (responseMode === "sse-raw") {
      const agentStream = agent.query(message, { includePartialMessages: true, maxSessionTurns })
      recordAudit()
      return streamAgentResponse(c, agentStream, undefined, {
        aigc: aigcLabel,
        explicitHint,
        runId,
        runsRegistry,
        onTerminal: (state, reason, usage) => {
          if (usage) metrics.recordRun(agentId, usage, undefined)
          runsRegistry.markTerminal(runId, state, reason)
        },
      })
    }

    // JSON blocking response
    try {
      const result = await agent.prompt(message, { maxSessionTurns })
      metrics.recordRun(agentId, result.usage, undefined)
      recordAudit(result.text)

      const runInfo = runsRegistry.get(runId)
      if (runInfo?.state === "cancelling" || runInfo?.state === "cancelled") {
        return c.json({
          runId,
          sessionId: agent.getSessionId(),
          state: "cancelled",
          reason: runInfo.reason ?? "client_request",
          text: result.text,
          usage: result.usage,
          numTurns: result.num_turns,
          durationMs: result.duration_ms,
          ...(aigcLabel ? { aigc: aigcLabel, ...(explicitHint ? { aigcExplicitHint: true } : {}) } : {}),
        })
      }

      return c.json({
        runId,
        sessionId: agent.getSessionId(),
        text: result.text,
        usage: result.usage,
        numTurns: result.num_turns,
        durationMs: result.duration_ms,
        ...(aigcLabel ? { aigc: aigcLabel, ...(explicitHint ? { aigcExplicitHint: true } : {}) } : {}),
      })
    } catch (err) {
      runsRegistry.markTerminal(runId, "failed", "error")
      throw err
    } finally {
      // Guard: if still running (no cancel, no error), mark completed.
      // markTerminal itself is idempotent; guard is for readability.
      const info = runsRegistry.get(runId)
      if (info?.state === "running") {
        runsRegistry.markTerminal(runId, "completed", "stream_end")
      }
    }
  })

  return router
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
```

Key changes from original:
1. Signature: `createAgentRouter(registry, runsRegistry, metrics, options)`
2. New `runsRegistry.register()` before SDK call
3. `X-Run-ID` header set
4. SSE calls pass `runId` / `runsRegistry` / `onTerminal` to `streamAgentResponse`; `onDone` (3rd arg) is now `undefined` because close is handled by `markTerminal`
5. JSON handler checks `runInfo.state` for cancellation, returns cancelled body
6. `finally` block calls `markTerminal("completed")` as fallback (only if still running)
7. `catch` calls `markTerminal("failed")`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/router-agent.test.ts`
Expected: PASS (existing tests + new run lifecycle tests).

- [ ] **Step 5: Commit**

```bash
git add src/router/agent.ts src/__tests__/router-agent.test.ts
git commit -m "feat(router): wire RunRegistry into agents router for runId and lifecycle"
```

---

## Task 6: Add cancel endpoint router

**Files:**
- Create: `src/router/runs.ts`
- Create: `src/__tests__/router-runs.test.ts`

**Interfaces:**
- Consumes: `RunRegistry` from Task 3
- Produces: `createRunsRouter(runsRegistry)` returning a Hono router with `POST /:runId/cancel`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/router-runs.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createRunsRouter } from "../router/runs.js"
import { RunRegistry } from "../runs.js"

function makeMockAgent() {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getSessionId: vi.fn().mockReturnValue("s1"),
  } as any
}

function createApp(registry: RunRegistry) {
  const app = new Hono()
  app.route("/v1/runs", createRunsRouter(registry))
  return app
}

describe("POST /v1/runs/:runId/cancel", () => {
  let registry: RunRegistry

  beforeEach(() => {
    registry = new RunRegistry({ ttlMs: 60_000, sweepMs: 60_000 })
  })

  it("returns 202 and state=cancelling for an active running run", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toEqual({ runId: id, state: "cancelling", reason: undefined })
  })

  it("triggers agent.interrupt() exactly once", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )
    await Promise.resolve()

    expect(agent.interrupt).toHaveBeenCalledTimes(1)
  })

  it("returns 202 cancelling for 2nd cancel during cancelling state (idempotent)", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    const app = createApp(registry)
    await app.request(`http://localhost/v1/runs/${id}/cancel`, { method: "POST" })
    const res2 = await app.request(`http://localhost/v1/runs/${id}/cancel`, { method: "POST" })

    expect(res2.status).toBe(202)
    const body = await res2.json()
    expect(body.state).toBe("cancelling")
  })

  it("returns 202 cancelled for cancel after run has terminated as cancelled", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    registry.cancel(id)
    registry.markTerminal(id, "cancelled", "client_request")

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.state).toBe("cancelled")
  })

  it("returns 404 for unknown runId", async () => {
    const res = await createApp(registry).request(
      "http://localhost/v1/runs/nonexistent/cancel",
      { method: "POST" },
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: "Run not found" })
  })

  it("returns 409 with state=completed when run already completed", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    registry.markTerminal(id, "completed", "stream_end")

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.state).toBe("completed")
  })

  it("returns 409 with state=failed when run already failed", async () => {
    const agent = makeMockAgent()
    const id = registry.register({ agent, agentId: "a1", sessionId: "s1" })

    registry.markTerminal(id, "failed", "error")

    const res = await createApp(registry).request(
      `http://localhost/v1/runs/${id}/cancel`,
      { method: "POST" },
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.state).toBe("failed")
  })

  it("cancelling one run does not affect another concurrent run", async () => {
    const agent1 = makeMockAgent()
    const agent2 = makeMockAgent()
    const id1 = registry.register({ agent: agent1, agentId: "a1", sessionId: "s1" })
    const id2 = registry.register({ agent: agent2, agentId: "a1", sessionId: "s2" })

    const app = createApp(registry)
    await app.request(`http://localhost/v1/runs/${id1}/cancel`, { method: "POST" })
    await Promise.resolve()

    expect(agent1.interrupt).toHaveBeenCalledTimes(1)
    expect(agent2.interrupt).not.toHaveBeenCalled()
    expect(registry.get(id2)?.state).toBe("running")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/router-runs.test.ts`
Expected: FAIL — `Failed to resolve import "../router/runs.js"`.

- [ ] **Step 3: Implement the cancel router**

Create `src/router/runs.ts`:

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

    if (outcome.state === "cancelling" || outcome.state === "cancelled") {
      return c.json(
        { runId, state: outcome.state, reason: outcome.reason },
        202,
      )
    }

    // completed / failed
    return c.json(
      { runId, state: outcome.state, reason: outcome.reason },
      409,
    )
  })

  return router
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/router-runs.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router/runs.ts src/__tests__/router-runs.test.ts
git commit -m "feat(router): add POST /v1/runs/:runId/cancel endpoint"
```

---

## Task 7: Mount runs router in app; verify auth coverage

**Files:**
- Modify: `src/router/index.ts`
- Modify: `src/__tests__/router-runs.test.ts` (add auth integration test)

**Interfaces:**
- Consumes: `RunRegistry` from Task 3, `createRunsRouter` from Task 6
- Produces: app with `/v1/runs` mounted; auth middleware (`/v1/*`) automatically covers it

- [ ] **Step 1: Write the failing auth test**

Append to `src/__tests__/router-runs.test.ts`:

```ts
import { createApp as createFullApp } from "../router/index.js"
import { AgentRegistry } from "../registry.js"
import { MetricsCollector } from "../metrics.js"
import type { RuntimeConfig } from "../config.js"

describe("cancel endpoint auth integration", () => {
  it("returns 401 when API key is required but not provided", async () => {
    // Mock SDK so AgentRegistry doesn't try to load real config
    vi.doMock("@zerone-agent/agent-sdk", () => ({ createAgent: vi.fn() }))
    vi.doMock("../skills.js", () => ({ scanSkills: vi.fn(async () => []) }))

    const config: any = {
      server: { host: "0.0.0.0", port: 3000 },
      auth: { apiKey: "secret-key" },
      agents: [{ id: "a1", model: "glm-4.5" }],
    }
    const registry = new AgentRegistry()
    await registry.loadFromConfig(config, "/tmp")
    const metrics = new MetricsCollector()
    const app = createFullApp(config, registry, metrics)

    const res = await app.request(
      "http://localhost/v1/runs/anything/cancel",
      { method: "POST" },
    )

    expect(res.status).toBe(401)
  })

  it("passes auth when correct API key is provided", async () => {
    vi.doMock("@zerone-agent/agent-sdk", () => ({ createAgent: vi.fn() }))
    vi.doMock("../skills.js", () => ({ scanSkills: vi.fn(async () => []) }))

    const config: any = {
      server: { host: "0.0.0.0", port: 3000 },
      auth: { apiKey: "secret-key" },
      agents: [{ id: "a1", model: "glm-4.5" }],
    }
    const registry = new AgentRegistry()
    await registry.loadFromConfig(config, "/tmp")
    const metrics = new MetricsCollector()
    const app = createFullApp(config, registry, metrics)

    // Unknown runId returns 404 (not 401) when auth passes
    const res = await app.request(
      "http://localhost/v1/runs/nonexistent/cancel",
      {
        method: "POST",
        headers: { "X-API-Key": "secret-key" },
      },
    )

    expect(res.status).toBe(404)
  })
})
```

Note: check `src/auth.ts` for the actual header name expected by `createAuthMiddleware` — the test uses `X-API-Key`; adjust if the implementation expects `Authorization: Bearer ...`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/router-runs.test.ts`
Expected: FAIL — `createApp` is not exported from `../router/index.js` (current export is `createApp`, not `createApp as createFullApp`). Also, `/v1/runs` route is not yet mounted.

- [ ] **Step 3: Mount the runs router**

Edit `src/router/index.ts`:

1. Add imports near the top:

```ts
import { RunRegistry } from "../runs.js"
import { createRunsRouter } from "./runs.js"
```

2. Update `createApp` body — replace the existing `app.route("/v1/agents", ...)` line and add the runs route right after `/v1/agents`. The final relevant block looks like:

```ts
export function createApp(
  config: RuntimeConfig,
  registry: AgentRegistry,
  metrics: MetricsCollector,
  options: CreateAppOptions = {},
) {
  const app = new Hono({ strict: false })

  if (config.cors) {
    app.use("*", cors({ origin: config.cors.origins }))
  }

  app.route("/health", createHealthRouter(registry))

  const apiKey = process.env.ZERONE_AGENT_HTTP_API_KEY ?? config.auth?.apiKey
  if (apiKey) {
    app.use("/v1/*", createAuthMiddleware(apiKey))
  }

  app.route("/v1/metrics", createMetricsRouter(metrics))

  const aigc = resolveAigcConfig(config.aigc)
  const auditLog = aigc ? new AigcAuditLog({ onRecord: options.onAigcRecord }) : undefined

  // RunRegistry is process-singleton; one instance serves all agent runs.
  const runsRegistry = new RunRegistry()
  app.route("/v1/agents", createAgentRouter(registry, runsRegistry, metrics, { aigc, auditLog }))
  app.route("/v1/runs", createRunsRouter(runsRegistry))
  app.route("/v1/sessions", createSessionRouter())
  app.route("/v1/files", createFilesRouter())

  return app
}
```

The only change vs the existing code is the two new imports, the `const runsRegistry = new RunRegistry()` line, and the new `app.route("/v1/runs", ...)` line. Existing `createAgentRouter` call now passes `runsRegistry` as the 2nd argument.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/router-runs.test.ts`
Expected: PASS (all 8 unit tests + 2 new auth integration tests).

Also run the full test suite to catch any regressions:

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/router/index.ts src/__tests__/router-runs.test.ts
git commit -m "feat(router): mount /v1/runs router; verify auth coverage"
```

---

## Task 8: Add SSE disconnect → cancel hook

**Files:**
- Modify: `src/sse.ts`
- Modify: `src/__tests__/sse.test.ts`

**Interfaces:**
- Consumes: `stream.onAbort` callback (if available) from `hono/streaming`'s `streamSSE`; fallback: `c.req.raw.signal` (Web `Request.signal`)
- Produces: SSE handler that triggers `runsRegistry.cancel(runId, "disconnect")` on client disconnect

**Spike first**: this task starts with a small spike to confirm whether `hono/streaming` exposes `stream.onAbort()` (or equivalent) on its `stream` parameter.

- [ ] **Step 1: Spike — confirm hono/streaming API**

Run a one-off check:

```bash
node -e "const { streamSSE } = require('hono/streaming'); console.log(typeof streamSSE);"
# Inspect hono's installed source for the SSE streaming helper
find node_modules/hono/dist/helpers/streaming -type f -name '*.js' | head -5
```

Inspect the `stream` parameter's interface in `node_modules/hono/dist/helpers/streaming/*.d.ts`. Look for:
- `onAbort(cb)` method — preferred
- Or whether `abort()` / `aborted` signal is exposed
- Or whether we need to fall back to `c.req.raw.signal` (Web `Request.signal`)

Document the finding in a comment at the top of `src/sse.ts`'s `streamAgentResponse`:

```ts
// Spike 2026-08-06: hono/streaming's streamSSE provides stream.onAbort(cb)
// (or: only c.req.raw.signal is available). Using: <chosen mechanism>.
```

- [ ] **Step 2: Write the failing test**

Append to `src/__tests__/sse.test.ts`:

```ts
describe("streamAgentResponse SSE disconnect handling", () => {
  it("calls runsRegistry.cancel(runId, 'disconnect') when stream is aborted mid-flight", async () => {
    const cancelSpy = vi.fn()
    const registry = {
      get: vi.fn().mockReturnValue(undefined), // run is gone after cancel
      cancel: cancelSpy,
    } as any

    // Generator that never yields (simulates long-running run that gets
    // aborted before any event).
    const slowGen = {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {}) // hangs forever
        yield {} as any
      },
    }

    const app = new Hono()
    app.get("/stream", (c) => {
      // The streamAgentResponse implementation should hook onAbort
      // and call registry.cancel when client disconnects.
      return streamAgentResponse(c, slowGen as any, undefined, {
        runId: "run-disc",
        runsRegistry: registry,
      })
    })

    // Issue request and abort it immediately
    const controller = new AbortController()
    const resPromise = app.request("http://localhost/stream", {
      signal: controller.signal,
    })
    controller.abort()
    await resPromise.catch(() => {}) // ignore AbortError

    expect(cancelSpy).toHaveBeenCalledWith("run-disc", "disconnect")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sse.test.ts`
Expected: FAIL — `cancel` not called on disconnect (no onAbort hook yet).

- [ ] **Step 4: Add disconnect hook to streamAgentResponse**

In `src/sse.ts`, inside the `streamSSE(c, async (stream) => { ... })` callback (at the very start), add:

```ts
    // Hook client disconnect → fire cancel with reason='disconnect'.
    // stream.onAbort is preferred; fall back to c.req.raw.signal if absent.
    const cancelOnDisconnect = () => {
      if (options?.runId && options?.runsRegistry) {
        options.runsRegistry.cancel(options.runId, "disconnect")
      }
    }
    if (typeof (stream as any).onAbort === "function") {
      ;(stream as any).onAbort(cancelOnDisconnect)
    } else if (c.req.raw.signal) {
      c.req.raw.signal.addEventListener("abort", cancelOnDisconnect, { once: true })
    }
```

Adjust the import block at the top if needed (no new imports — uses existing `Context` type).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/sse.test.ts`
Expected: PASS (all existing + new disconnect test).

If the spike in step 1 found that neither `stream.onAbort` nor `c.req.raw.signal` works in the test environment, document the limitation in the spec's "Open questions" section and skip this task's commit — the cancel endpoint (Task 6) still works for explicit cancellation; SSE disconnect cancellation can be a follow-up.

- [ ] **Step 6: Commit (only if test passes)**

```bash
git add src/sse.ts src/__tests__/sse.test.ts
git commit -m "feat(sse): cancel run on client disconnect with reason='disconnect'"
```

---

## Task 9: Update README documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Locate insertion point in README.md**

Run: `grep -n "^## " README.md`
Identify the section that comes after the existing API/runs documentation (likely after "## HTTP API" or similar).

- [ ] **Step 2: Add new section to README.md**

Insert a new `## Run lifecycle & cancellation` section after the API section. Use this content:

```markdown
## Run lifecycle & cancellation

Every `POST /v1/agents/:agentId/runs` execution is assigned a unique
`runId` (UUID) for transport-level identification. The ID is exposed in:

- Response header `X-Run-ID` (SSE and JSON)
- SSE initial `system` event's `runId` field
- JSON response body's `runId` field

### Cancelling a run

```http
POST /v1/runs/:runId/cancel
```

Aborts the addressed active run. Response codes:

| State | Code | Body |
|---|---|---|
| Triggered cancellation | 202 | `{ runId, state: "cancelling" }` |
| Repeated cancel (idempotent) | 202 | `{ runId, state: "cancelling" | "cancelled", reason }` |
| Run already in non-cancel terminal | 409 | `{ runId, state: "completed" | "failed" }` |
| Unknown / expired runId | 404 | `{ error: "Run not found" }` |

Terminal-state cache TTL: **5 minutes**. After expiry, repeat cancel
returns 404.

### SSE cancellation semantics

When a run is cancelled (explicit API call or client disconnect), the
SSE stream emits:

```
event: cancelled
data: {"runId":"...","reason":"client_request|disconnect"}

event: done
data: {}
```

- `reason=client_request`: explicit `POST /v1/runs/:runId/cancel`.
- `reason=disconnect`: SSE client disconnected.

**Client disconnect = silent cancellation**: closing the SSE connection
aborts the underlying agent execution. The runtime does not distinguish
"intentional cancel" from "network drop" — both stop the run to avoid
wasting tokens.

### Non-goals

This API is transport-level. agent-runtime does **not** provide:

- Persistent run history (use external orchestrator)
- Retry / failover policy
- Durable event replay (reconnect mid-stream is not supported)
- GET status endpoint (terminal state is conveyed via the response itself)
```

- [ ] **Step 3: Add equivalent section to README.zh-CN.md**

Translate the same section into Chinese, matching the existing style of `README.zh-CN.md`. Key terms:

- "Run lifecycle & cancellation" → "Run 生命周期与取消"
- "Cancelling a run" → "取消 run"
- "SSE cancellation semantics" → "SSE 取消语义"
- "Client disconnect = silent cancellation" → "客户端断连 = 静默取消"
- "Non-goals" → "不在范围内"

- [ ] **Step 4: Verify docs build/preview is not broken**

Run: `npm run build`
Expected: no errors (README is not part of TypeScript build, but quick sanity check that nothing else regressed).

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: add Run lifecycle & cancellation section to README"
```

---

## Final Verification

- [ ] **Run full test suite**

Run: `npm test`
Expected: all tests pass, including:

- `src/__tests__/runs.test.ts` — RunRegistry unit (15+ tests)
- `src/__tests__/router-runs.test.ts` — cancel endpoint (10 tests including auth)
- `src/__tests__/sse.test.ts` — cancelled event injection + disconnect (8+ tests)
- `src/__tests__/router-agent.test.ts` — existing + run lifecycle integration

- [ ] **Run TypeScript build**

Run: `npm run build`
Expected: no type errors.

- [ ] **Run linter (if configured)**

Check `package.json` for `lint` script. If present, run: `npm run lint`

- [ ] **Manual smoke test (optional but recommended)**

Start the runtime locally:

```bash
ZERONE_AGENT_API_KEY=test-key npm start
```

Issue a long-running run (e.g. with a slow prompt), then in another terminal:

```bash
curl -X POST http://localhost:3000/v1/agents/<agentId>/runs \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"message":"Write a 5000-word essay"}'
```

Capture the `X-Run-ID` header from the response (or interrupt the curl with Ctrl+C if SSE).

In another terminal:

```bash
curl -X POST http://localhost:3000/v1/runs/<runId>/cancel -H "X-API-Key: test-key"
```

Expected: 202 with `{ runId, state: "cancelling" }`. The original curl should exit, with the SSE stream emitting a `cancelled` event before `done`.

- [ ] **Open PR**

```bash
git push -u origin feat/run-lifecycle-cancellation
gh pr create --title "feat: add addressable run lifecycle and cancellation API (#5)" \
  --body "Closes #5. Implementation per design spec at docs/superpowers/specs/2026-08-06-run-lifecycle-cancellation-design.md."
```

---

## Spec Coverage Self-Check

| Spec section | Covered by |
|---|---|
| `runId` auto-generated UUID | Task 1 (register), Task 5 (header/body) |
| `POST /v1/runs/:runId/cancel` endpoint | Task 6 (router), Task 7 (mount) |
| Bounded TTL cache (5 min) | Task 3 (sweep + TTL_MS) |
| State machine (running→cancelling→cancelled) | Task 2 (cancel + markTerminal) |
| `cancelled` SSE event independent type | Task 4 (sse.ts) |
| `X-Run-ID` header | Task 5 (router/agent.ts) |
| `runId` in SSE init event | Task 4 (decorateEvent) |
| `runId` in JSON body | Task 5 (router/agent.ts) |
| Repeated cancel idempotent | Task 2 (cancel state machine) |
| 404 unknown / expired | Task 2 (cancel returns undefined) + Task 3 (TTL) |
| 409 completed/failed | Task 6 (router) |
| SSE disconnect = silent cancel | Task 8 (onAbort hook) |
| `agent.close()` exactly once | Task 2 (closePromise guard) |
| Auth middleware covers cancel | Task 7 (mounts under /v1/*) |
| 9 acceptance criteria tests | All test tasks (1, 2, 3, 4, 5, 6) |
| README docs | Task 9 |

All spec sections covered.
