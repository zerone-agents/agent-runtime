import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { streamAgentResponse } from "../sse.js"
import type { AigcLabel } from "../aigc.js"

const LABEL: AigcLabel = {
  Label: "1",
  ContentProducer: "001191320118MAK93FC72D10001",
  ProduceID: "20260723103000-a1b2c3d4e5f6",
}

function createApp(events: unknown[], options?: Parameters<typeof streamAgentResponse>[3]) {
  const app = new Hono()
  app.get("/stream", (c) => {
    async function* gen() {
      for (const e of events) yield e as any
    }
    return streamAgentResponse(c, gen(), undefined, options)
  })
  return app
}

function parseSse(body: string): { event: string; data: any }[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const eventLine = chunk.split("\n").find((l) => l.startsWith("event:"))
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))
      return {
        event: eventLine!.slice(6).trim(),
        data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : null,
      }
    })
}

describe("streamAgentResponse AIGC injection", () => {
  it("injects the aigc label into system and result events", async () => {
    const app = createApp(
      [
        { type: "system", subtype: "init", sessionId: "s1" },
        { type: "partial_message", partial: { type: "text", text: "hi" } },
        { type: "assistant", message: { role: "assistant", content: [] } },
        { type: "result", subtype: "success", text: "done" },
      ],
      { aigc: LABEL },
    )

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())

    expect(events[0].event).toBe("system")
    expect(events[0].data.aigc).toEqual(LABEL)

    const result = events.find((e) => e.event === "result")
    expect(result?.data.aigc).toEqual(LABEL)
  })

  it("leaves other events untouched", async () => {
    const app = createApp(
      [
        { type: "system", subtype: "init" },
        { type: "partial_message", partial: { type: "text", text: "hi" } },
        { type: "tool_result", result: { ok: true } },
      ],
      { aigc: LABEL },
    )

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())

    const partial = events.find((e) => e.event === "partial_message")
    const toolResult = events.find((e) => e.event === "tool_result")
    expect(partial?.data.aigc).toBeUndefined()
    expect(toolResult?.data.aigc).toBeUndefined()
  })

  it("adds aigcExplicitHint to the result event when enabled", async () => {
    const app = createApp(
      [{ type: "result", subtype: "success", text: "done" }],
      { aigc: LABEL, explicitHint: true },
    )

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())
    const result = events.find((e) => e.event === "result")
    expect(result?.data.aigcExplicitHint).toBe(true)
  })

  it("omits aigcExplicitHint when not enabled", async () => {
    const app = createApp(
      [{ type: "result", subtype: "success", text: "done" }],
      { aigc: LABEL },
    )

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())
    const result = events.find((e) => e.event === "result")
    expect(result?.data.aigcExplicitHint).toBeUndefined()
  })

  it("streams without injection when no options provided (backward compatible)", async () => {
    const app = createApp([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success" },
    ])

    const res = await app.request("http://localhost/stream")
    const events = parseSse(await res.text())
    expect(events.find((e) => e.event === "system")?.data.aigc).toBeUndefined()
    expect(events.find((e) => e.event === "result")?.data.aigc).toBeUndefined()
  })
})
