import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentRegistry } from "../registry.js"

vi.mock("@zerone-agent/open-agent-sdk", () => ({
  createAgent: vi.fn(),
}))

vi.mock("../config.js", () => ({
  resolveSystemPrompt: vi.fn(() => "test-prompt"),
}))

import { createAgent } from "@zerone-agent/open-agent-sdk"

const mockCreateAgent = vi.mocked(createAgent)

function makeConfig(agents: any[]) {
  return {
    server: { host: "0.0.0.0", port: 3000 },
    agents,
  } as any
}

describe("AgentRegistry (factory)", () => {
  let registry: AgentRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new AgentRegistry()
  })

  describe("loadFromConfig", () => {
    it("stores definitions without creating agents", async () => {
      const config = makeConfig([
        { id: "agent-a", model: "gpt-4" },
        { id: "agent-b", model: "claude-3" },
      ])

      await registry.loadFromConfig(config, "/tmp")

      expect(mockCreateAgent).not.toHaveBeenCalled()
      expect(registry.getStatus("agent-a")).toBe("ready")
      expect(registry.getStatus("agent-b")).toBe("ready")
    })

    it("marks agent as unavailable when resolveSystemPrompt throws", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("file not found")
      })

      const config = makeConfig([
        { id: "bad-agent", model: "gpt-4" },
        { id: "good-agent", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      expect(registry.getStatus("bad-agent")).toBe("unavailable")
      expect(registry.getStatus("good-agent")).toBe("ready")
    })
  })

  describe("create", () => {
    it("creates a new agent per call", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent.mockReturnValue(mockAgent as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const agent = registry.create("my-agent")
      expect(agent).toBe(mockAgent)
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4", systemPrompt: "test-prompt" }),
      )
    })

    it("converts mcpServers transport field to type before passing to SDK", async () => {
      mockCreateAgent.mockReturnValue({ close: vi.fn().mockResolvedValue(undefined) } as any)

      const config = makeConfig([
        {
          id: "mcp-agent",
          model: "gpt-4",
          mcpServers: {
            web: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } },
            local: { transport: "stdio", command: "node", args: ["server.js"] },
          },
        },
      ])
      await registry.loadFromConfig(config, "/tmp")

      registry.create("mcp-agent")
      const opts = mockCreateAgent.mock.calls[0][0] as any
      expect(opts.mcpServers.web).toEqual({
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      })
      expect(opts.mcpServers.local).toEqual({
        type: "stdio",
        command: "node",
        args: ["server.js"],
      })
    })

    it("passes resume: sessionId when sessionId provided", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent.mockReturnValue(mockAgent as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const agent = registry.create("my-agent", "sess-123")
      expect(agent).toBe(mockAgent)
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ resume: "sess-123" }),
      )
    })

    it("does not pass resume when sessionId is undefined", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent.mockReturnValue(mockAgent as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      registry.create("my-agent")
      const opts = mockCreateAgent.mock.calls[0][0] as any
      expect(opts.resume).toBeUndefined()
    })

    it("returns undefined for unknown agent", () => {
      const agent = registry.create("nonexistent")
      expect(agent).toBeUndefined()
    })

    it("returns undefined for unavailable agent", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })

      const config = makeConfig([{ id: "bad", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const agent = registry.create("bad")
      expect(agent).toBeUndefined()
    })

    it("creates independent agents on each call", async () => {
      const agent1 = { close: vi.fn().mockResolvedValue(undefined) }
      const agent2 = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent
        .mockReturnValueOnce(agent1 as any)
        .mockReturnValueOnce(agent2 as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const a1 = registry.create("my-agent")
      const a2 = registry.create("my-agent")
      expect(a1).toBe(agent1)
      expect(a2).toBe(agent2)
      expect(mockCreateAgent).toHaveBeenCalledTimes(2)
    })
  })

  describe("list", () => {
    it("returns AgentInfo based on definitions", async () => {
      const config = makeConfig([
        { id: "agent-1", name: "Agent One", model: "gpt-4", allowedTools: ["tool-a", "tool-b"] },
        { id: "agent-2", name: "Agent Two", model: "claude-3" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      const listed = registry.list()
      expect(listed).toHaveLength(2)
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "agent-1", name: "Agent One", model: "gpt-4", toolCount: 2, status: "ready" }),
          expect.objectContaining({ id: "agent-2", name: "Agent Two", model: "claude-3", toolCount: 0, status: "ready" }),
        ]),
      )
    })

    it("excludes unavailable agents from list", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })

      const config = makeConfig([
        { id: "agent-1", model: "gpt-4" },
        { id: "agent-2", model: "gpt-4" },
        { id: "agent-3", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      const listed = registry.list()
      expect(listed).toHaveLength(2)
      expect(listed.map((a) => a.id).sort()).toEqual(["agent-2", "agent-3"])
    })
  })

  describe("getStatus", () => {
    it("returns ready for loaded agent", async () => {
      const config = makeConfig([{ id: "a1", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")
      expect(registry.getStatus("a1")).toBe("ready")
    })

    it("returns unavailable for failed agent", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })
      const config = makeConfig([{ id: "a2", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")
      expect(registry.getStatus("a2")).toBe("unavailable")
    })

    it("returns not_found for unknown agent", () => {
      expect(registry.getStatus("unknown")).toBe("not_found")
    })
  })

  describe("closeAll", () => {
    it("is a no-op (no live instances)", async () => {
      const config = makeConfig([{ id: "a1", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      await registry.closeAll()

      expect(mockCreateAgent).not.toHaveBeenCalled()
    })
  })
})
