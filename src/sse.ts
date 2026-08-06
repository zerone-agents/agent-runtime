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
): Response {
  // Spike 2026-08-06: hono/streaming's SSEStreamingApi (extends StreamingApi)
  // exposes `stream.onAbort(listener)`. However, onAbort only fires when
  // `stream.abort()` is invoked, and hono wires the request.signal →
  // stream.abort() path only for "old Bun versions" (see hono's
  // helper/streaming/stream.js `isOldBunVersion()` branch). In standard
  // Node/undici (test env, production runtime), only `c.req.raw.signal`
  // fires on client disconnect. We therefore register BOTH, guarded by
  // a `fired` flag to prevent double-cancel (idempotency is also enforced
  // by RunRegistry.cancel which no-ops on already-cancelling runs).
  // streamSSE returns Response synchronously; if setup throws (e.g. headers
  // already sent), we still need to clean up the agent. That's handled by
  // the try/catch around the call.
  try {
    return streamSSE(c, async (stream) => {
      // Hook client disconnect → fire cancel with reason='disconnect'.
      // No-op when runId/runsRegistry absent (backward compat for callers
      // that don't opt into run tracking).
      if (options?.runId && options?.runsRegistry) {
        let fired = false
        const cancelOnDisconnect = () => {
          if (fired) return
          fired = true
          options.runsRegistry!.cancel(options.runId!, "disconnect")
        }
        // onAbort covers downstream ReadableStream cancel and old Bun wiring.
        if (typeof stream.onAbort === "function") {
          stream.onAbort(cancelOnDisconnect)
        }
        // c.req.raw.signal covers standard Node/undici client disconnect.
        c.req.raw.signal?.addEventListener("abort", cancelOnDisconnect, {
          once: true,
        })
      }

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
      } finally {
        // Preserve the original contract: onDone runs after the SDK stream
        // ends, regardless of success/error. Critical for agent.close() in
        // the router (see router/agent.ts).
        await onDone?.()
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
        options.onTerminal(
          terminalState,
          terminalForCallback(terminalState, lastResultEvent, terminalReason),
          usage,
        )
      }
    })
  } catch (err) {
    // streamSSE setup itself threw (client disconnect before headers, etc.)
    void onDone?.()
    throw err
  }
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
