import { describe, it, expect, vi } from "vitest"
import { Hono } from "hono"
import { streamAgentResponse } from "../sse.js"
import type { AigcLabel } from "../aigc.js"
import type { RunRegistry } from "../runs.js"

function makeMockRegistry(state: string, reason?: string): RunRegistry {
  return {
    get: vi.fn().mockReturnValue({ state, agentId: "a1", sessionId: "s1", reason }),
  } as any
}

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

    const res = await app.request("http://localhost/stream")
    await res.text() // drain stream so onTerminal (fires after stream end) runs
    expect(onTerminal).toHaveBeenCalledWith("cancelled", "client_request", undefined)
  })

  it("calls onTerminal with completed state when registry says completed", async () => {
    const registry = makeMockRegistry("completed", "stream_end")
    const onTerminal = vi.fn()
    const app = createApp(
      [{ type: "result", subtype: "success", usage: { input_tokens: 5 } }],
      { runId: "run-w", runsRegistry: registry, onTerminal },
    )

    const res = await app.request("http://localhost/stream")
    await res.text() // drain stream so onTerminal (fires after stream end) runs
    expect(onTerminal).toHaveBeenCalledWith("completed", "stream_end", { input_tokens: 5 })
  })
})
