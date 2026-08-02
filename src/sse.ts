import type { SDKMessage } from "@zerone-agent/agent-sdk"
import { streamSSE } from "hono/streaming"
import type { Context } from "hono"
import type { AigcLabel } from "./aigc.js"

export interface StreamOptions {
  /**
   * GB 45438-2025 implicit label, injected into `system` and `result`
   * events so both ends of the stream carry the traceable anchor.
   */
  aigc?: AigcLabel
  /** Also flag `aigcExplicitHint: true` on the result event. */
  explicitHint?: boolean
}

export function streamAgentResponse(
  c: Context,
  agentStream: AsyncGenerator<SDKMessage, void>,
  onDone?: () => Promise<void> | void,
  options?: StreamOptions,
) {
  return streamSSE(c, async (stream) => {
    try {
      for await (const event of agentStream) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(decorateEvent(event, options)),
        })
      }
      await stream.writeSSE({ event: "done", data: "{}" })
    } catch (err: any) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: err.message ?? "Unknown error" }),
      })
      await stream.writeSSE({ event: "done", data: "{}" })
    } finally {
      await onDone?.()
    }
  })
}

function decorateEvent(event: SDKMessage, options?: StreamOptions): unknown {
  if (!options?.aigc) return event
  if (event.type === "system") {
    return { ...event, aigc: options.aigc }
  }
  if (event.type === "result") {
    return {
      ...event,
      aigc: options.aigc,
      ...(options.explicitHint ? { aigcExplicitHint: true } : {}),
    }
  }
  return event
}
