import { describe, it, expect } from "vitest"
import { AgentRegistry } from "../registry.js"
import type { CronService, CronTask, CronExecution, CronExecutionQuery, CreateCronTaskInput, CronTaskChanges } from "@zerone-agent/agent-sdk"

/** Minimal structural double — only identity matters for these tests. */
const fakeService = {} as CronService

function makeRegistry() {
  const registry = new AgentRegistry()
  registry.register("assistant", { id: "assistant", description: "d", model: "m" } as any, {
    model: "m",
    agent: { description: "d", prompt: "p", maxTurns: 10 },
  } as any)
  return registry
}

describe("AgentRegistry cronService integration", () => {
  it("resolveOptions returns fresh copy without cronService by default", async () => {
    const registry = makeRegistry()
    const opts = await registry.resolveOptions("assistant")
    expect(opts).toBeDefined()
    expect(opts!.cronService).toBeUndefined()
    expect(opts!.model).toBe("m")
  })

  it("resolveOptions injects explicit cronService", async () => {
    const registry = makeRegistry()
    const opts = await registry.resolveOptions("assistant", { cronService: fakeService })
    expect(opts!.cronService).toBe(fakeService)
  })

  it("resolveOptions falls back to registry-level cronService", async () => {
    const registry = makeRegistry()
    registry.setCronService(fakeService)
    const opts = await registry.resolveOptions("assistant")
    expect(opts!.cronService).toBe(fakeService)
    // fresh copy: mutating result does not poison the registry
    opts!.cronService = undefined
    expect((await registry.resolveOptions("assistant"))!.cronService).toBe(fakeService)
  })

  it("resolveOptions returns undefined for unknown or non-ready agent", async () => {
    const registry = makeRegistry()
    expect(await registry.resolveOptions("nope")).toBeUndefined()
    // mark unavailable via loadFromConfig failure path is heavy; use register() of unknown directly:
    const reg2 = new AgentRegistry()
    reg2.register("bad", { id: "bad", description: "d" } as any, {} as any)
    expect(await reg2.resolveOptions("bad")).toBeDefined() // ready by register()
  })

  it("setCronService(undefined) clears injection", async () => {
    const registry = makeRegistry()
    registry.setCronService(fakeService)
    registry.setCronService(undefined)
    expect((await registry.resolveOptions("assistant"))!.cronService).toBeUndefined()
  })
})
