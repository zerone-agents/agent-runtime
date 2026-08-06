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
