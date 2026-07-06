import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createAgentRouter } from "../router/agent.js"

vi.mock("../sse.js", () => ({
  streamAgentResponse: vi.fn().mockReturnValue(new Response("sse-stream", { status: 200 })),
}))

import { streamAgentResponse } from "../sse.js"

function createApp(registry: any, metrics: any) {
  const app = new Hono()
  const router = createAgentRouter(registry, metrics)
  app.route("/v1/agents", router)
  return app
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
      expect(agent.prompt).toHaveBeenCalledWith("hello")
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
      expect(agent.query).toHaveBeenCalledWith("hello", { includePartialMessages: true })
      const onDone = vi.mocked(streamAgentResponse).mock.calls[0][2]
      expect(onDone).toBeTypeOf("function")
      await onDone!()
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
})
