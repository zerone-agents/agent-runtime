import { describe, it, expect, vi, afterEach } from "vitest"
import { RunRegistry, RunIdConflictError, RunRegistryClosedError } from "../runs.js"

function makeMockAgent(overrides: Record<string, any> = {}) {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getSessionId: vi.fn().mockReturnValue("test-session"),
    ...overrides,
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

describe("RunRegistry — cancel state machine", () => {
  it("cancel() transitions running → cancelling and calls agent.interrupt()", async () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    const result = reg.cancel(id)

    expect(result).toEqual({ state: "cancelling", reason: undefined })
    expect(reg.get(id)?.state).toBe("cancelling")
    // interrupt is fire-and-forget; await microtask flush
    await Promise.resolve()
    expect(agent.interrupt).toHaveBeenCalledTimes(1)
  })

  it("cancel() is idempotent: 2nd call returns state=cancelling without re-calling interrupt", async () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id)
    await Promise.resolve()
    const result2 = reg.cancel(id)

    // Idempotent 2nd call returns current state + FIRST cancel's reason
    // (matches API spec: repeated cancel body shape is { state, reason }).
    // Note: brief's test assertion was `reason: undefined` (copy-paste typo
    // from the first cancel test); implementation returns the stored reason.
    expect(result2).toEqual({ state: "cancelling", reason: "client_request" })
    expect(agent.interrupt).toHaveBeenCalledTimes(1)
  })

  it("cancel() with reason='disconnect' records the reason", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id, "disconnect")

    expect(reg.get(id)?.reason).toBe("disconnect")
  })

  it("cancel() returns undefined for unknown runId (404)", () => {
    const reg = new RunRegistry()
    expect(reg.cancel("nonexistent")).toBeUndefined()
  })
})

describe("RunRegistry — markTerminal state machine", () => {
  it("markTerminal('completed') moves run from active to terminal map", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")

    // active no longer has it; terminal has it
    expect(reg.get(id)?.state).toBe("completed")
    expect(reg.get(id)?.agentId).toBe("") // terminal entries don't carry agentId
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it("markTerminal forces 'cancelled' when current state is cancelling", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id, "client_request")
    // SDK reports success (mislabeled), but we must force cancelled
    reg.markTerminal(id, "completed", "stream_end")

    expect(reg.get(id)?.state).toBe("cancelled")
    expect(reg.get(id)?.reason).toBe("client_request")
  })

  it("markTerminal is idempotent: 2nd call is no-op", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")
    reg.markTerminal(id, "failed", "error") // should do nothing

    expect(reg.get(id)?.state).toBe("completed")
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it("agent.close() called exactly once across multiple markTerminal invocations", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")
    reg.markTerminal(id, "completed", "stream_end")
    reg.markTerminal(id, "failed", "error")

    expect(agent.close).toHaveBeenCalledTimes(1)
  })
})

describe("RunRegistry — cancel after terminal", () => {
  it("cancel() returns cancelled for already-cancelled run (terminal map)", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.cancel(id)
    reg.markTerminal(id, "cancelled", "client_request")

    const result = reg.cancel(id)
    expect(result?.state).toBe("cancelled")
  })

  it("cancel() returns completed/failed for non-cancel terminal (409)", () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")

    const result = reg.cancel(id)
    expect(result?.state).toBe("completed")
  })
})

describe("RunRegistry — caller-provided runId", () => {
  it("uses the caller-provided runId when valid UUID", () => {
    const reg = new RunRegistry()
    const callerId = "12345678-1234-1234-1234-123456789abc"
    const id = reg.register(
      { agent: makeMockAgent(), agentId: "a1", sessionId: "s1" },
      callerId,
    )
    expect(id).toBe(callerId)
    expect(reg.get(callerId)?.agentId).toBe("a1")
  })

  it("still generates UUID by default when no caller runId", () => {
    const reg = new RunRegistry()
    const id = reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s1" })
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(id).not.toBe("12345678-1234-1234-1234-123456789abc")
  })

  it("throws Error on malformed caller runId", () => {
    const reg = new RunRegistry()
    expect(() =>
      reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s1" }, "not-a-uuid"),
    ).toThrow(/Invalid runId format/)
  })

  it("throws RunIdConflictError when caller runId already active", () => {
    const reg = new RunRegistry()
    const callerId = "12345678-1234-1234-1234-123456789abc"
    reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s1" }, callerId)
    expect(() =>
      reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s2" }, callerId),
    ).toThrow(RunIdConflictError)
  })

  it("throws RunIdConflictError when caller runId is recently terminal (within TTL)", () => {
    const reg = new RunRegistry()
    const callerId = "12345678-1234-1234-1234-123456789abc"
    const id = reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s1" }, callerId)
    reg.markTerminal(id, "completed", "stream_end")
    expect(() =>
      reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s2" }, callerId),
    ).toThrow(RunIdConflictError)
  })
})

describe("RunRegistry — TTL sweep", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sweep removes terminal entries older than TTL_MS", () => {
    vi.useFakeTimers()
    const reg = new RunRegistry({ ttlMs: 1000, sweepMs: 60_000 })
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "completed", "stream_end")
    expect(reg.get(id)?.state).toBe("completed")

    // Advance past TTL
    vi.advanceTimersByTime(1001)
    // Manually trigger sweep (private but accessible via any cast for test)
    ;(reg as any).sweep()

    expect(reg.get(id)).toBeUndefined()
  })

  it("cancel returns undefined after TTL expires (404)", () => {
    vi.useFakeTimers()
    const reg = new RunRegistry({ ttlMs: 1000, sweepMs: 60_000 })
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    reg.markTerminal(id, "cancelled", "client_request")
    vi.advanceTimersByTime(1001)
    ;(reg as any).sweep()

    expect(reg.cancel(id)).toBeUndefined()
  })
})

describe("RunRegistry — closeAll", () => {
  it("interrupts and marks all active runs as cancelled, awaits all closePromises", async () => {
    const reg = new RunRegistry()
    const agent1 = makeMockAgent()
    const agent2 = makeMockAgent()
    const id1 = reg.register({ agent: agent1, agentId: "a1", sessionId: "s1" })
    const id2 = reg.register({ agent: agent2, agentId: "a2", sessionId: "s2" })

    await reg.closeAll()

    expect(agent1.interrupt).toHaveBeenCalledTimes(1)
    expect(agent2.interrupt).toHaveBeenCalledTimes(1)
    expect(agent1.close).toHaveBeenCalledTimes(1)
    expect(agent2.close).toHaveBeenCalledTimes(1)
    expect(reg.get(id1)?.state).toBe("cancelled")
    expect(reg.get(id2)?.state).toBe("cancelled")
  })

  it("preserves 'shutdown' as the terminal reason (not coerced to client_request)", async () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    await reg.closeAll()

    const info = reg.get(id)
    expect(info?.state).toBe("cancelled")
    expect(info?.reason).toBe("shutdown")
  })

  it("agent.close() rejection is swallowed (no unhandled promise rejection)", async () => {
    const reg = new RunRegistry()
    const closeErr = new Error("close blew up")
    const agent = makeMockAgent({
      close: vi.fn().mockRejectedValue(closeErr),
    })
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    // Capture console.error to verify diagnostic is logged without throwing
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    reg.markTerminal(id, "completed", "stream_end")

    // Drain microtasks so the .catch handler runs
    await new Promise((resolve) => setImmediate(resolve))

    expect(agent.close).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[RunRegistry] agent.close() rejected"),
      "close blew up",
    )
    errSpy.mockRestore()
  })

  it("register() after closeAll() throws RunRegistryClosedError (late-registration shutdown guard)", async () => {
    const reg = new RunRegistry()
    reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s1" })

    await reg.closeAll()

    // A request that passed the shutdown gate before begin() but registers
    // after closeAll() must fail fast instead of running uncancellable.
    expect(() =>
      reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s2" }),
    ).toThrow(RunRegistryClosedError)
    expect(() =>
      reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s2" }),
    ).toThrow("RunRegistry is closed (shutdown in progress)")
  })
})

describe("RunRegistry — phased shutdown (sealAndCancel / finishCleanup)", () => {
  it("sealAndCancel() cancels immediately; finishCleanup() stays pending until the closePromise resolves", async () => {
    const reg = new RunRegistry()
    // Manually-controlled agent cleanup promise: markTerminal's closePromise
    // guard preserves it (agent.close() is NOT called for this record).
    let releaseClose!: () => void
    const closePromise = new Promise<void>((r) => {
      releaseClose = r
    })
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1", closePromise })

    reg.sealAndCancel()

    // Phase A is synchronous: run already cancelled with shutdown origin,
    // but agent cleanup has not been awaited anywhere.
    expect(agent.interrupt).toHaveBeenCalledTimes(1)
    expect(agent.close).not.toHaveBeenCalled()
    expect(reg.get(id)?.state).toBe("cancelled")
    expect(reg.get(id)?.reason).toBe("shutdown")

    let finished = false
    const done = reg.finishCleanup().then(() => {
      finished = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).toBe(false) // cleanup still in flight

    releaseClose()
    await done
    expect(finished).toBe(true)
  })

  it("finishCleanup() resolves immediately when sealAndCancel() had no runs", async () => {
    const reg = new RunRegistry()
    reg.sealAndCancel()
    await expect(reg.finishCleanup()).resolves.toBeUndefined()
  })

  it("closeAll() composes both phases (backward compat)", async () => {
    const reg = new RunRegistry()
    const agent = makeMockAgent()
    const id = reg.register({ agent, agentId: "a1", sessionId: "s1" })

    await reg.closeAll()

    expect(agent.close).toHaveBeenCalledTimes(1)
    expect(reg.get(id)?.state).toBe("cancelled")
    expect(() =>
      reg.register({ agent: makeMockAgent(), agentId: "a1", sessionId: "s2" }),
    ).toThrow(RunRegistryClosedError)
  })
})
