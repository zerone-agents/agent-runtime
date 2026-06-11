import type { SDKMessage } from "@zerone-agent/open-agent-sdk"
import { streamSSE } from "hono/streaming"
import type { Context } from "hono"

export function streamAgentResponse(
  c: Context,
  agentStream: AsyncGenerator<SDKMessage, void>,
  onDone?: () => Promise<void> | void,
) {
  return streamSSE(c, async (stream) => {
    try {
      for await (const event of agentStream) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
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
