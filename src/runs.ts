import { randomUUID } from "node:crypto"
import type { Agent } from "@zerone-agent/agent-sdk"

export type RunState = "running" | "cancelling" | "cancelled" | "completed" | "failed"
export type TerminalState = "cancelled" | "completed" | "failed"
export type CancelReason = "client_request" | "disconnect" | "shutdown"
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

export interface RunRegistryOptions {
  /** Terminal-state cache TTL in ms. Default: 5 minutes. */
  ttlMs?: number
  /** Sweep interval in ms. Default: 60 seconds. */
  sweepMs?: number
}

/** Thrown by register() when a caller-provided runId is already in use. */
export class RunIdConflictError extends Error {
  constructor(public runId: string) {
    super(`Run ID "${runId}" is already active or recently terminal`)
    this.name = "RunIdConflictError"
  }
}

/** Thrown by register() once the registry has been sealed for shutdown. */
export class RunRegistryClosedError extends Error {
  constructor() {
    super("RunRegistry is closed (shutdown in progress)")
    this.name = "RunRegistryClosedError"
  }
}

/** Caller-provided runId must match UUID v4 format. */
const RUN_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class RunRegistry {
  private readonly TTL_MS: number
  private readonly SWEEP_MS: number
  private active = new Map<string, RunRecord>()
  private terminal = new Map<string, TerminalEntry>()
  private sweepTimer?: NodeJS.Timeout
  /**
   * Shutdown-window guard: set by sealAndCancel() before cancelling
   * registered runs. Requests that passed the shutdown gate but have not
   * registered a run yet fail fast here instead of starting a run nobody
   * will cancel — such a run would otherwise block the drain wait
   * uncancellable.
   */
  private closed = false
  /**
   * Agent-cleanup completion captured by sealAndCancel(); awaited separately
   * via finishCleanup() so callers can drain in-flight requests first.
   */
  private cleanupDone: Promise<void> = Promise.resolve()

  constructor(options: RunRegistryOptions = {}) {
    this.TTL_MS = options.ttlMs ?? 5 * 60 * 1000
    this.SWEEP_MS = options.sweepMs ?? 60_000
    this.sweepTimer = setInterval(() => this.sweep(), this.SWEEP_MS)
    // unref() so the timer never blocks process exit.
    this.sweepTimer.unref?.()
  }

  /**
   * Register a new run. Runtime generates a UUID by default; if `callerRunId`
   * is provided, it must be a valid UUID and must not already be active or in
   * the terminal cache (within TTL window). Throws RunIdConflictError on
   * duplicate, Error on invalid format, and RunRegistryClosedError if the
   * registry is closed (shutdown in progress).
   */
  register(
    rec: Omit<RunRecord, "runId" | "state" | "startedAt">,
    callerRunId?: string,
  ): string {
    if (this.closed) {
      throw new RunRegistryClosedError()
    }
    const runId = callerRunId ?? randomUUID()
    if (callerRunId && !RUN_ID_FORMAT.test(callerRunId)) {
      throw new Error(
        `Invalid runId format: caller-provided runId must be a UUID (got "${callerRunId}")`,
      )
    }
    if (this.active.has(runId) || this.terminal.has(runId)) {
      throw new RunIdConflictError(runId)
    }
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
    // Rejections are swallowed with a diagnostic to avoid unhandled promise
    // rejections: outside closeAll(), nobody awaits this promise.
    if (!rec.closePromise) {
      rec.closePromise = rec.agent.close().catch((err: unknown) => {
        // Diagnostic only; exactly-once is preserved by the closePromise
        // field guard, not by the close() resolution.
        // eslint-disable-next-line no-console
        console.error(
          `[RunRegistry] agent.close() rejected for run ${runId}:`,
          err instanceof Error ? err.message : err,
        )
      })
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, entry] of this.terminal) {
      if (now - entry.terminalAt > this.TTL_MS) {
        this.terminal.delete(id)
      }
    }
  }

  /**
   * Shutdown phase A: seal the registry (late registrations fail fast with
   * RunRegistryClosedError) and cancel every active run with reason
   * 'shutdown'. Returns WITHOUT awaiting agent cleanup — cleanup completion
   * is awaited separately via finishCleanup(), so the shutdown request drain
   * is never gated behind Agent close() promises (which may resolve only
   * after their handlers unwind).
   */
  sealAndCancel(): void {
    this.closed = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)

    // Snapshot before mutating; markTerminal deletes from active.
    const activeRuns = [...this.active.values()]

    for (const rec of activeRuns) {
      // Cancel with reason='shutdown' so the terminal record reflects the
      // shutdown origin, not 'client_request'. The cancelling invariant in
      // markTerminal preserves the first writer's reason, so we must set
      // 'shutdown' here, not later.
      this.cancel(rec.runId, "shutdown")
      // markTerminal may not be called by handler in shutdown path; force it.
      this.markTerminal(rec.runId, "cancelled", "shutdown")
    }

    // Await (via finishCleanup) all closePromises created during the
    // markTerminal sweep above. Must be computed AFTER the sweep: the
    // snapshot holds live record references, and markTerminal is what
    // attaches the agent.close() promise to each.
    const closePromises = activeRuns
      .map((r) => r.closePromise)
      .filter((p): p is Promise<void> => Boolean(p))
    this.cleanupDone = Promise.allSettled(closePromises).then(() => {})

    // active is already empty (markTerminal deleted each entry).
    // terminal is intentionally NOT cleared: post-closeAll callers may still
    // query run state (e.g. verify cancelled); TTL sweep will reap entries.
    this.active.clear()
  }

  /** Shutdown phase B: await agent cleanup captured by sealAndCancel(). */
  finishCleanup(): Promise<void> {
    return this.cleanupDone
  }

  async closeAll(): Promise<void> {
    this.sealAndCancel()
    await this.finishCleanup()
  }
}
