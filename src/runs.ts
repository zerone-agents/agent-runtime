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
}
