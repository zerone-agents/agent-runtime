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
