import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createAgentRouter } from "../router/agent.js"
import { createRunsRouter } from "../router/runs.js"
import { RunRegistry } from "../runs.js"
import type { AigcConfig } from "../aigc.js"

vi.mock("../sse.js", () => ({
  streamAgentResponse: vi.fn().mockReturnValue(new Response("sse-stream", { status: 200 })),
}))

import { streamAgentResponse } from "../sse.js"

const AIGC_CONFIG: AigcConfig = {
  enabled: true,
  contentProducer: "001191320118MAK93FC72D10001",
  label: "1",
  explicitHint: true,
  produceIdPrefix: "",
  modelCodes: { "qwen-max": "0002" },
}

function createApp(registry: any, metrics: any, options?: any) {
  const app = new Hono()
  const router = createAgentRouter(registry, new RunRegistry(), metrics, options)
  app.route("/v1/agents", router)
  return app
}

function createAppWithRuns(registry: any, runsRegistry: any, metrics: any, options?: any) {
  const app = new Hono()
  const router = createAgentRouter(registry, runsRegistry, metrics, options)
  app.route("/v1/agents", router)
  return app
}

function makeReadyAgent(overrides: any = {}) {
  return {
    query: vi.fn(),
    prompt: vi.fn().mockResolvedValue({
      text: "Hello world",
      usage: { input_tokens: 10, output_tokens: 20 },
      num_turns: 1,
      duration_ms: 150,
    }),
    getSessionId: vi.fn().mockReturnValue("sess-new"),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("Agent Router (per-request)", () => {
  let registry: any
  let metrics: any

  beforeEach(() => {
      registry = {
        list: vi.fn(),
        create: vi.fn(),
        getStatus: vi.fn(),
        getDetail: vi.fn(),
        getModel: vi.fn().mockReturnValue("glm-4.5"),
      }
    metrics = {
      recordRun: vi.fn(),
    }
    vi.mocked(streamAgentResponse).mockClear()
  })

  describe("GET /v1/agents", () => {
    it("returns a list of agents", async () => {
      const agents = [
        { id: "agent-1", name: "Agent One", status: "ready", toolCount: 3 },
      ]
      registry.list.mockReturnValue(agents)
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(agents)
    })
  })

  describe("maxSessionTurns parameter", () => {
    it("passes maxSessionTurns to agent.query in blocking mode", async () => {
      const mockQuery = vi.fn().mockReturnValue(async function* () {
        yield { type: "result", result: { text: "ok", usage: {}, num_turns: 1, duration_ms: 1 } }
      })
      const mockAgent = {
        query: mockQuery,
        prompt: vi.fn(),
        close: vi.fn(),
        getSessionId: () => "test-session",
      }
      registry.create.mockReturnValue(mockAgent)
      registry.getStatus.mockReturnValue("ready")

      const app = createApp(registry, metrics)
      await app.request("/v1/agents/test/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "hello",
          stream: "block",
          maxSessionTurns: 20,
        }),
      })

      expect(mockQuery).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ maxSessionTurns: 20 })
      )
    })

    it("passes maxSessionTurns to agent.query in SSE mode", async () => {
      const mockQuery = vi.fn().mockReturnValue(async function* () {
        yield { type: "result", result: { text: "ok", usage: {}, num_turns: 1, duration_ms: 1 } }
      })
      const mockAgent = {
        query: mockQuery,
        prompt: vi.fn(),
        close: vi.fn(),
        getSessionId: () => "test-session",
      }
      registry.create.mockReturnValue(mockAgent)
      registry.getStatus.mockReturnValue("ready")

      const app = createApp(registry, metrics)
      await app.request("/v1/agents/test/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "hello",
          stream: true,
          maxSessionTurns: 15,
        }),
      })

      expect(mockQuery).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ includePartialMessages: true, maxSessionTurns: 15 })
      )
    })

    it("passes maxSessionTurns to agent.prompt in sync mode", async () => {
      const mockPrompt = vi.fn().mockResolvedValue({
        text: "response",
        usage: {},
        num_turns: 1,
        duration_ms: 1,
      })
      const mockAgent = {
        query: vi.fn(),
        prompt: mockPrompt,
        close: vi.fn(),
        getSessionId: () => "test-session",
      }
      registry.create.mockReturnValue(mockAgent)
      registry.getStatus.mockReturnValue("ready")

      const app = createApp(registry, metrics)
      await app.request("/v1/agents/test/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "hello",
          stream: false,
          maxSessionTurns: 25,
        }),
      })

      expect(mockPrompt).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ maxSessionTurns: 25 })
      )
    })

    it("passes undefined maxSessionTurns when not provided", async () => {
      const mockPrompt = vi.fn().mockResolvedValue({
        text: "response",
        usage: {},
        num_turns: 1,
        duration_ms: 1,
      })
      const mockAgent = {
        query: vi.fn(),
        prompt: mockPrompt,
        close: vi.fn(),
        getSessionId: () => "test-session",
      }
      registry.create.mockReturnValue(mockAgent)
      registry.getStatus.mockReturnValue("ready")

      const app = createApp(registry, metrics)
      await app.request("/v1/agents/test/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", stream: false }),
      })

      expect(mockPrompt).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ maxSessionTurns: undefined })
      )
    })
  })

  describe("GET /v1/agents/:agentId", () => {
    it("returns agent detail when found", async () => {
      const detail = {
        id: "my-agent",
        name: "My Agent",
        model: "gpt-4",
        status: "ready",
        maxTurns: 10,
        hasSystemPrompt: true,
        allowedTools: ["Read"],
      }
      registry.getDetail.mockReturnValue(detail)
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/my-agent")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(detail)
    })

    it("returns 404 for unknown agent", async () => {
      registry.getDetail.mockReturnValue(null)
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/unknown")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body).toEqual({ error: "Agent not found" })
    })
  })

  describe("POST /v1/agents/:agentId/runs", () => {
    it("returns 404 if agent not found", async () => {
      registry.create.mockReturnValue(undefined)
      registry.getStatus.mockReturnValue("not_found")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/missing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      })
      expect(res.status).toBe(404)
    })

    it("returns 503 if agent unavailable", async () => {
      registry.create.mockReturnValue(undefined)
      registry.getStatus.mockReturnValue("unavailable")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/down/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      })
      expect(res.status).toBe(503)
    })

    it("returns 400 if message is missing", async () => {
      registry.create.mockReturnValue({})
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it("creates agent with sessionId for resume, returns blocking response", async () => {
      const agent = {
        query: vi.fn(),
        prompt: vi.fn().mockResolvedValue({
          text: "Hello world",
          usage: { input_tokens: 10, output_tokens: 20 },
          num_turns: 1,
          duration_ms: 150,
        }),
        getSessionId: vi.fn().mockReturnValue("sess-new"),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", stream: false, sessionId: "sess-old" }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.text).toBe("Hello world")
      expect(body.sessionId).toBe("sess-new")
      expect(registry.create).toHaveBeenCalledWith("a1", "sess-old")
      expect(agent.prompt).toHaveBeenCalledWith("hello", { maxSessionTurns: undefined })
      expect(agent.close).toHaveBeenCalledOnce()
      expect(metrics.recordRun).toHaveBeenCalledWith("a1", { input_tokens: 10, output_tokens: 20 }, undefined)
    })

    it("creates agent without sessionId for new session", async () => {
      const agent = {
        query: vi.fn(),
        prompt: vi.fn().mockResolvedValue({
          text: "ok",
          usage: { input_tokens: 5, output_tokens: 5 },
          num_turns: 1,
          duration_ms: 50,
        }),
        getSessionId: vi.fn().mockReturnValue("sess-fresh"),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: false }),
      })
      expect(res.status).toBe(200)
      expect(registry.create).toHaveBeenCalledWith("a1", undefined)
    })

    it("streams via streamAgentResponse and closes agent when stream=true", async () => {
      async function* gen() {
        yield { type: "text", text: "hi" }
      }
      const agent = {
        query: vi.fn().mockImplementation(() => gen()),
        prompt: vi.fn(),
        getSessionId: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      })
      expect(res.status).toBe(200)
      expect(streamAgentResponse).toHaveBeenCalledOnce()
      expect(agent.query).toHaveBeenCalledWith("hello", { includePartialMessages: true, maxSessionTurns: undefined })
      // New contract: agent.close is invoked by runsRegistry.markTerminal(),
      // which fires via the onTerminal callback (4th-arg options) at stream end.
      const opts = vi.mocked(streamAgentResponse).mock.calls[0][3]
      expect(typeof opts?.onTerminal).toBe("function")
      opts?.onTerminal?.("completed", "stream_end", undefined)
      expect(agent.close).toHaveBeenCalledOnce()
    })

    it("closes agent even on error (blocking mode)", async () => {
      const agent = {
        query: vi.fn(),
        prompt: vi.fn().mockRejectedValue(new Error("LLM error")),
        getSessionId: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", stream: false }),
      })
      expect(agent.close).toHaveBeenCalledOnce()
    })

    it("first request returns sessionId, second request uses it to resume", async () => {
      const firstSessionId = "sess-abc-123"

      const agent1 = {
        query: vi.fn(),
        prompt: vi.fn().mockResolvedValue({
          text: "Hello new user",
          usage: { input_tokens: 10, output_tokens: 20 },
          num_turns: 1,
          duration_ms: 100,
        }),
        getSessionId: vi.fn().mockReturnValue(firstSessionId),
        close: vi.fn().mockResolvedValue(undefined),
      }

      const agent2 = {
        query: vi.fn(),
        prompt: vi.fn().mockResolvedValue({
          text: "Welcome back",
          usage: { input_tokens: 15, output_tokens: 25 },
          num_turns: 1,
          duration_ms: 80,
        }),
        getSessionId: vi.fn().mockReturnValue(firstSessionId),
        close: vi.fn().mockResolvedValue(undefined),
      }

      registry.getStatus.mockReturnValue("ready")
      registry.create
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2)

      const app = createApp(registry, metrics)

      const res1 = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", stream: false }),
      })
      expect(res1.status).toBe(200)
      const body1 = await res1.json()
      expect(body1.text).toBe("Hello new user")
      expect(body1.sessionId).toBe(firstSessionId)
      expect(registry.create).toHaveBeenCalledWith("a1", undefined)
      expect(agent1.close).toHaveBeenCalledOnce()

      vi.mocked(registry.create).mockClear()

      const res2 = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "continue our chat", stream: false, sessionId: firstSessionId }),
      })
      expect(res2.status).toBe(200)
      const body2 = await res2.json()
      expect(body2.text).toBe("Welcome back")
      expect(body2.sessionId).toBe(firstSessionId)
      expect(registry.create).toHaveBeenCalledWith("a1", firstSessionId)
      expect(agent2.close).toHaveBeenCalledOnce()
    })
  })

  describe("AIGC labeling (GB 45438-2025)", () => {
    it("omits aigc fields when no aigc option provided (backward compat)", async () => {
      const agent = makeReadyAgent()
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: false }),
      })
      const body = await res.json()
      expect(body.aigc).toBeUndefined()
      expect(body.aigcExplicitHint).toBeUndefined()
    })

    it("includes aigc label + explicit hint in blocking response when enabled", async () => {
      const agent = makeReadyAgent()
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      registry.getModel.mockReturnValue("glm-4.5")
      const auditLog = { record: vi.fn() }

      const app = createApp(registry, metrics, { aigc: AIGC_CONFIG, auditLog })
      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: false }),
      })

      const body = await res.json()
      expect(body.aigc).toMatchObject({
        Label: "1",
        ContentProducer: "001191320118MAK93FC72D10001",
        ProduceID: expect.stringMatching(/^\d{14}-[0-9a-f]{12}$/),
      })
      expect(body.aigcExplicitHint).toBe(true)
    })

    it("replaces model code slot when the model is mapped in modelCodes", async () => {
      const agent = makeReadyAgent()
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      registry.getModel.mockReturnValue("qwen-max")

      const app = createApp(registry, metrics, { aigc: AIGC_CONFIG })
      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: false }),
      })

      const body = await res.json()
      // last 4 chars become "0002" (qwen-max mapping), subject segment unchanged
      expect(body.aigc.ContentProducer).toBe("001191320118MAK93FC72D10002")
    })

    it("records audit entry with produceId matching response + contentHash", async () => {
      const agent = makeReadyAgent({
        prompt: vi.fn().mockResolvedValue({
          text: "the final text",
          usage: { input_tokens: 1, output_tokens: 1 },
          num_turns: 1,
          duration_ms: 1,
        }),
      })
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      registry.getModel.mockReturnValue("glm-4.5")
      const auditLog = { record: vi.fn() }

      const app = createApp(registry, metrics, { aigc: AIGC_CONFIG, auditLog })
      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: false }),
      })
      const body = await res.json()
      expect(auditLog.record).toHaveBeenCalledOnce()
      const rec = auditLog.record.mock.calls[0][0]
      expect(rec.produceId).toBe(body.aigc.ProduceID)
      expect(rec.agentId).toBe("a1")
      expect(rec.model).toBe("glm-4.5")
      expect(rec.sessionId).toBe("sess-new")
      expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it("passes aigc label and explicitHint to streamAgentResponse in SSE mode", async () => {
      async function* gen() {
        yield { type: "text", text: "hi" }
      }
      const agent = makeReadyAgent({ query: vi.fn().mockImplementation(() => gen()) })
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      registry.getModel.mockReturnValue("glm-4.5")

      const app = createApp(registry, metrics, { aigc: AIGC_CONFIG })
      const res = await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: true }),
      })
      expect(res.status).toBe(200)
      expect(streamAgentResponse).toHaveBeenCalledOnce()

      const [, , , options] = vi.mocked(streamAgentResponse).mock.calls[0]
      expect(options).toMatchObject({
        aigc: expect.objectContaining({
          Label: "1",
          ContentProducer: "001191320118MAK93FC72D10001",
        }),
        explicitHint: true,
      })
    })

    it("records audit entry upfront in SSE mode (no contentHash)", async () => {
      async function* gen() {
        yield { type: "text", text: "hi" }
      }
      const agent = makeReadyAgent({ query: vi.fn().mockImplementation(() => gen()) })
      registry.create.mockReturnValue(agent)
      registry.getStatus.mockReturnValue("ready")
      registry.getModel.mockReturnValue("glm-4.5")
      const auditLog = { record: vi.fn() }

      const app = createApp(registry, metrics, { aigc: AIGC_CONFIG, auditLog })
      await app.request("http://localhost/v1/agents/a1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", stream: true }),
      })

      expect(auditLog.record).toHaveBeenCalledOnce()
      const rec = auditLog.record.mock.calls[0][0]
      // SSE audit has produceId + model but no hash (text unknown at record time)
      expect(rec.produceId).toMatch(/^\d{14}-[0-9a-f]{12}$/)
      expect(rec.contentHash).toBeUndefined()
    })
  })
})

describe("run lifecycle integration", () => {
  let registry: any
  let runsRegistry: RunRegistry
  let metrics: any

  beforeEach(() => {
    registry = {
      list: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn().mockReturnValue("ready"),
      getDetail: vi.fn(),
      getModel: vi.fn().mockReturnValue("glm-4.5"),
    }
    runsRegistry = new RunRegistry()
    metrics = { recordRun: vi.fn() }
    vi.mocked(streamAgentResponse).mockClear()
  })

  it("X-Run-ID header is present on JSON response", async () => {
    registry.create.mockReturnValue(makeReadyAgent())
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    const res = await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })

    expect(res.headers.get("X-Run-ID")).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it("JSON response body includes runId matching the header", async () => {
    registry.create.mockReturnValue(makeReadyAgent())
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    const res = await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })

    const headerRunId = res.headers.get("X-Run-ID")
    const body = await res.json()
    expect(body.runId).toBe(headerRunId)
    // Existing fields preserved
    expect(body.text).toBe("Hello world")
    expect(body.sessionId).toBe("sess-new")
  })

  it("SSE streamAgentResponse is called with runId option", async () => {
    const agent = makeReadyAgent()
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: "hi" }),
    })

    expect(streamAgentResponse).toHaveBeenCalledTimes(1)
    const optionsArg = vi.mocked(streamAgentResponse).mock.calls[0][3]
    expect(optionsArg?.runId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(optionsArg?.runsRegistry).toBe(runsRegistry)
    expect(typeof optionsArg?.onTerminal).toBe("function")
  })

  it("JSON response shape when no cancel interleaved (race condition not synchronously testable)", async () => {
    // The race (cancel arriving during prompt execution) cannot be exercised
    // synchronously: the mock prompt resolves before any cancel can interleave.
    // This test verifies the happy-path response SHAPE only. Race behavior is
    // verified manually in Final Verification.
    const agent = makeReadyAgent({
      prompt: vi.fn().mockImplementation(async (message: string) => {
        // Simulate SDK resolving with partial content after abort
        return {
          text: "partial",
          usage: { input_tokens: 5 },
          num_turns: 1,
          duration_ms: 10,
        }
      }),
    })
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    // Pre-cancel by intercepting: register the run first, cancel, then run.
    // Since router.register is internal, use a more realistic flow:
    // issue run + cancel via the same app in sequence (mock prompt resolves fast).
    // This test verifies the response SHAPE when state=cancelling is detected.
    const runResPromise = app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })
    const res = await runResPromise

    // In the synchronous mock, cancel didn't have a chance to interleave.
    // Verify the happy-path response shape (runId + existing fields).
    // Race-condition behavior is verified manually in Final Verification.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runId).toBeDefined()
    expect(body.state).toBeUndefined() // not cancelled in this synchronous flow
  })

  it("agent.close() is called exactly once in normal JSON completion", async () => {
    const agent = makeReadyAgent()
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false }),
    })

    expect(agent.close).toHaveBeenCalledTimes(1)
  })
})

describe("caller-provided runId and JSON-mode cancellation race", () => {
  let registry: any
  let runsRegistry: RunRegistry
  let metrics: any

  beforeEach(() => {
    registry = {
      list: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn().mockReturnValue("ready"),
      getDetail: vi.fn(),
      getModel: vi.fn().mockReturnValue("glm-4.5"),
    }
    runsRegistry = new RunRegistry()
    metrics = { recordRun: vi.fn() }
    vi.mocked(streamAgentResponse).mockClear()
  })

  it("accepts caller-provided runId in JSON body and echoes it back", async () => {
    const agent = makeReadyAgent()
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    const callerRunId = "12345678-1234-1234-1234-123456789abc"
    const res = await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false, runId: callerRunId }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("X-Run-ID")).toBe(callerRunId)
    expect((await res.json()).runId).toBe(callerRunId)
  })

  it("returns 409 when caller-provided runId conflicts with active run", async () => {
    const agent = makeReadyAgent()
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    const callerRunId = "12345678-1234-1234-1234-123456789abc"
    // Pre-register the same runId so the second call conflicts
    runsRegistry.register(
      { agent: makeReadyAgent(), agentId: "a1", sessionId: "s1" },
      callerRunId,
    )

    const res = await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false, runId: callerRunId }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "Run ID conflict", runId: callerRunId })
    // Reviewer follow-up: agent created above must be closed exactly once
    // even though register() threw.
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it("returns 400 on malformed caller-provided runId", async () => {
    const agent = makeReadyAgent()
    registry.create.mockReturnValue(agent)
    const app = createAppWithRuns(registry, runsRegistry, metrics)

    const res = await app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false, runId: "not-a-uuid" }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid runId format/)
    // Reviewer follow-up: agent created above must be closed exactly once.
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it("JSON blocking run with caller-provided runId can be cancelled mid-prompt via cancel endpoint", async () => {
    // Deferred that controls when prompt() resolves. The handler will be
    // stuck at `await agent.prompt(...)` until we release it.
    let resolvePrompt!: (value: any) => void
    const promptPromise = new Promise<any>((resolve) => {
      resolvePrompt = resolve
    })

    const agent = makeReadyAgent({
      prompt: vi.fn().mockReturnValue(promptPromise),
      // interrupt() is called by runsRegistry.cancel; no-op in this mock
      interrupt: vi.fn().mockResolvedValue(undefined),
    })
    registry.create.mockReturnValue(agent)

    // Build an app that mounts BOTH the agent router AND the runs router
    // so the cancel endpoint is reachable from the same Hono instance.
    const app = new Hono()
    app.route(
      "/v1/agents",
      createAgentRouter(registry, runsRegistry, metrics),
    )
    app.route("/v1/runs", createRunsRouter(runsRegistry))

    const callerRunId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    // Issue the JSON run (don't await yet — prompt is pending).
    const runPromise = app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false, runId: callerRunId }),
    })

    // Yield so the handler reaches `await agent.prompt()` and registers the run.
    // We may need several ticks for async dispatch.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r))
    }

    // Caller-provided runId is known ahead of time; issue cancel.
    const cancelRes = await app.request(`http://localhost/v1/runs/${callerRunId}/cancel`, {
      method: "POST",
    })
    expect(cancelRes.status).toBe(202)
    expect(runsRegistry.get(callerRunId)?.state).toBe("cancelling")

    // Release the prompt (simulates SDK resolving partial result after abort).
    resolvePrompt({
      text: "partial",
      usage: { input_tokens: 5 },
      num_turns: 1,
      duration_ms: 10,
    })

    // Now the JSON run should complete with cancelled body.
    const runRes = await runPromise
    expect(runRes.status).toBe(200)
    const body = await runRes.json()
    expect(body).toMatchObject({
      runId: callerRunId,
      state: "cancelled",
      reason: "client_request",
      text: "partial",
    })

    // Exactly-once cleanup
    expect(agent.interrupt).toHaveBeenCalledTimes(1)
    expect(agent.close).toHaveBeenCalledTimes(1)
    expect(runsRegistry.get(callerRunId)?.state).toBe("cancelled")
  })

  it("returns cancelled body when prompt() rejects after interrupt (not error response)", async () => {
    // Reviewer follow-up: real SDK may reject prompt() on interrupt rather
    // than resolving with partial. The cancelled JSON contract must hold.
    let rejectPrompt!: (reason: any) => void
    const promptPromise = new Promise<any>((_resolve, reject) => {
      rejectPrompt = reject
    })

    const agent = makeReadyAgent({
      prompt: vi.fn().mockReturnValue(promptPromise),
      interrupt: vi.fn().mockResolvedValue(undefined),
    })
    registry.create.mockReturnValue(agent)

    const app = new Hono()
    app.route("/v1/agents", createAgentRouter(registry, runsRegistry, metrics))
    app.route("/v1/runs", createRunsRouter(runsRegistry))

    const callerRunId = "11111111-2222-3333-4444-555555555555"

    const runPromise = app.request("http://localhost/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: "hi", stream: false, runId: callerRunId }),
    })

    // Yield so handler reaches `await agent.prompt()`.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r))
    }

    // Cancel via the cancel router (sets state=cancelling, fires interrupt).
    const cancelRes = await app.request(`http://localhost/v1/runs/${callerRunId}/cancel`, {
      method: "POST",
    })
    expect(cancelRes.status).toBe(202)

    // Now SDK rejects prompt (simulates AbortError propagation).
    rejectPrompt(new Error("The operation was aborted"))

    // The router should detect cancelling state and return cancelled body
    // instead of letting the rejection bubble up as an error response.
    const runRes = await runPromise
    expect(runRes.status).toBe(200)
    const body = await runRes.json()
    expect(body).toMatchObject({
      runId: callerRunId,
      state: "cancelled",
      reason: "client_request",
    })
    // No partial text/usage available when prompt rejected.
    expect(body.text).toBeUndefined()
    expect(body.usage).toBeUndefined()

    // Exactly-once cleanup; no metrics recorded for cancelled runs.
    expect(agent.interrupt).toHaveBeenCalledTimes(1)
    expect(agent.close).toHaveBeenCalledTimes(1)
    expect(metrics.recordRun).not.toHaveBeenCalled()
    expect(runsRegistry.get(callerRunId)?.state).toBe("cancelled")
  })
})
