import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AgentRegistry } from "../registry.js"

vi.mock("@zerone-agent/agent-sdk", () => ({
  createAgent: vi.fn(),
}))

vi.mock("../config.js", () => ({
  resolveSystemPrompt: vi.fn(() => "test-prompt"),
}))

// Mock scanSkills so registry tests don't touch the real filesystem.
// Default returns empty; individual tests can override.
vi.mock("../skills.js", () => ({
  scanSkills: vi.fn(async () => []),
}))

import { createAgent } from "@zerone-agent/agent-sdk"
import { scanSkills } from "../skills.js"

const mockCreateAgent = vi.mocked(createAgent)
const mockScanSkills = vi.mocked(scanSkills)

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
    mockScanSkills.mockResolvedValue([])
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
        expect.objectContaining({
          model: "gpt-4",
          agent: expect.objectContaining({ prompt: "test-prompt" }),
        }),
      )
    })

    it("does not pass allowedSkills to SDK (filesystem-only skill model)", async () => {
      mockCreateAgent.mockReturnValue({ close: vi.fn().mockResolvedValue(undefined) } as any)
      const config = makeConfig([{
        id: "skill-agent",
        model: "gpt-4",
        settingSources: ["user"],
      }])
      await registry.loadFromConfig(config, "/tmp")
      registry.create("skill-agent")
      const opts = mockCreateAgent.mock.calls[0][0] as any
      expect(opts.allowedSkills).toBeUndefined()
      expect(opts.settingSources).toEqual(["user"])
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

  describe("getDetail", () => {
    it("returns null for unknown agent", () => {
      expect(registry.getDetail("unknown")).toBeNull()
    })

    it("returns full detail for a fully-configured agent", async () => {
      const fakeSkills = [
        { name: "cbt", description: "Cognitive therapy", source: "project" as const, location: "/tmp/.openagent/skills/cbt/SKILL.md" },
      ]
      mockScanSkills.mockResolvedValue(fakeSkills)

      const config = makeConfig([{
        id: "full-agent",
        name: "Full Agent",
        model: "claude-sonnet-4-6",
        systemPrompt: "you are a bot",
        maxTurns: 25,
        permissionMode: "auto",
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Bash"],
        settingSources: ["project"],
        extraUserSkillDirs: ["/mnt/sk"],
        datasets: { book1: "description" },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("full-agent")!
      expect(detail).toEqual({
        id: "full-agent",
        name: "Full Agent",
        model: "claude-sonnet-4-6",
        status: "ready",
        maxTurns: 25,
        hasSystemPrompt: true,
        permissionMode: "auto",
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Bash"],
        availableSkills: fakeSkills,
        settingSources: ["project"],
        extraUserSkillDirs: ["/mnt/sk"],
        datasets: { book1: "description" },
      })
    })

    it("does not include availableSkills when scan returns empty", async () => {
      mockScanSkills.mockResolvedValue([])
      const config = makeConfig([{
        id: "no-skills",
        model: "gpt-4",
        settingSources: ["user"],  // configured, but scan finds nothing
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("no-skills")!
      expect(detail.availableSkills).toBeUndefined()
      // settingSources is still surfaced (it's a config-layer field)
      expect(detail.settingSources).toEqual(["user"])
    })

    it("omits unset fields for a minimally-configured agent", async () => {
      const config = makeConfig([{ id: "min", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("min")!
      expect(detail).toEqual({
        id: "min",
        name: "min",
        model: "gpt-4",
        status: "ready",
        maxTurns: 10,
        hasSystemPrompt: false,
      })
      // 未配置字段不在响应里
      expect(detail.allowedTools).toBeUndefined()
      expect(detail.mcpServers).toBeUndefined()
      expect(detail.subagents).toBeUndefined()
      expect(detail.permissionMode).toBeUndefined()
    })

    it("hasSystemPrompt is true when systemPromptFile is set (without reading the file)", async () => {
      const config = makeConfig([{
        id: "file-agent",
        model: "gpt-4",
        systemPromptFile: "/tmp/prompt.txt",
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("file-agent")!
      expect(detail.hasSystemPrompt).toBe(true)
    })

    it("returns subagents as an id reference list", async () => {
      const config = makeConfig([{
        id: "parent",
        model: "gpt-4",
        subagents: ["coder", "writer"],
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("parent")!
      expect(detail.subagents).toEqual(["coder", "writer"])
    })

    it("returns status='unavailable' detail for unavailable agent", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })
      const config = makeConfig([{ id: "broken", model: "gpt-4", allowedTools: ["Read"] }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("broken")!
      expect(detail.status).toBe("unavailable")
      expect(detail.allowedTools).toEqual(["Read"])
    })

    it("sanitizes MCP stdio env values (keeps command and args)", async () => {
      const config = makeConfig([{
        id: "stdio-agent",
        model: "gpt-4",
        mcpServers: {
          local: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "some-server"],
            env: { API_KEY: "secret-token", OTHER: "x" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("stdio-agent")!
      expect(detail.mcpServers).toEqual({
        local: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "some-server"],
          env: { API_KEY: "***", OTHER: "***" },
        },
      })
    })

    it("sanitizes MCP sse headers (keeps url)", async () => {
      const config = makeConfig([{
        id: "sse-agent",
        model: "gpt-4",
        mcpServers: {
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
            headers: { Authorization: "Bearer xxx" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("sse-agent")!
      expect(detail.mcpServers).toEqual({
        remote: {
          transport: "sse",
          url: "https://example.com/sse",
          headers: { Authorization: "***" },
        },
      })
    })

    it("sanitizes MCP http headers (keeps url)", async () => {
      const config = makeConfig([{
        id: "http-agent",
        model: "gpt-4",
        mcpServers: {
          api: {
            transport: "http",
            url: "https://example.com/mcp",
            headers: { "X-API-Key": "abc" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("http-agent")!
      expect(detail.mcpServers).toEqual({
        api: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { "X-API-Key": "***" },
        },
      })
    })

    it("availableSkills is per-agent isolated (multi-agent with different scans)", async () => {
      // Agent A scans and gets skill "cbt"; agent B scans and gets nothing.
      mockScanSkills
        .mockResolvedValueOnce([
          { name: "cbt", description: "therapy", source: "project" as const, location: "/a/SKILL.md" },
        ])
        .mockResolvedValueOnce([])

      const config = makeConfig([
        { id: "agent-a", model: "gpt-4", settingSources: ["project"] },
        { id: "agent-b", model: "gpt-4", settingSources: ["user"] },
      ])
      await registry.loadFromConfig(config, "/tmp")

      const detailA = registry.getDetail("agent-a")!
      const detailB = registry.getDetail("agent-b")!
      expect(detailA.availableSkills).toHaveLength(1)
      expect(detailA.availableSkills![0].name).toBe("cbt")
      expect(detailB.availableSkills).toBeUndefined()
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

  describe("getModel", () => {
    const ENV_KEY = "ZERONE_AGENT_MODEL"

    afterEach(() => {
      delete process.env[ENV_KEY]
    })

    it("returns the configured model for a known agent", async () => {
      await registry.loadFromConfig(makeConfig([{ id: "a1", model: "glm-4.5" }]), "/tmp")
      expect(registry.getModel("a1")).toBe("glm-4.5")
    })

    it("prefers ZERONE_AGENT_MODEL env override", async () => {
      process.env[ENV_KEY] = "qwen-max"
      await registry.loadFromConfig(makeConfig([{ id: "a1", model: "glm-4.5" }]), "/tmp")
      expect(registry.getModel("a1")).toBe("qwen-max")
    })

    it("returns undefined for unknown agent", () => {
      expect(registry.getModel("unknown")).toBeUndefined()
    })
  })

  describe("maxSessionTurns", () => {
    it("passes maxSessionTurns to createAgent when configured", async () => {
      const registry = new AgentRegistry()
      const config = makeConfig([{
        id: "test",
        model: "claude-sonnet-4-6",
        maxTurns: 10,
        maxSessionTurns: 50,
      }])

      await registry.loadFromConfig(config, "/tmp")
      registry.create("test")

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ maxSessionTurns: 50 }),
      )
    })

    it("passes undefined maxSessionTurns when not configured", async () => {
      const registry = new AgentRegistry()
      const config = makeConfig([{
        id: "test",
        model: "claude-sonnet-4-6",
        maxTurns: 10,
      }])

      await registry.loadFromConfig(config, "/tmp")
      registry.create("test")

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ maxSessionTurns: undefined }),
      )
    })

    it("includes maxSessionTurns in getDetail when configured", async () => {
      const registry = new AgentRegistry()
      const config = makeConfig([{
        id: "test",
        model: "claude-sonnet-4-6",
        maxTurns: 10,
        maxSessionTurns: 50,
      }])

      await registry.loadFromConfig(config, "/tmp")
      const detail = registry.getDetail("test")

      expect(detail?.maxSessionTurns).toBe(50)
    })

    it("omits maxSessionTurns from getDetail when not configured", async () => {
      const registry = new AgentRegistry()
      const config = makeConfig([{
        id: "test",
        model: "claude-sonnet-4-6",
        maxTurns: 10,
      }])

      await registry.loadFromConfig(config, "/tmp")
      const detail = registry.getDetail("test")

      expect(detail?.maxSessionTurns).toBeUndefined()
      expect(detail).not.toHaveProperty("maxSessionTurns")
    })
  })

  describe("subagent mounting", () => {
    const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }

    beforeEach(() => {
      mockCreateAgent.mockReturnValue(mockAgent as any)
    })

    it("materializes subAgents from id references with 5-field mapping", async () => {
      const config = makeConfig([
        { id: "parent", description: "coordinator", model: "gpt-4", subagents: ["coder"] },
        {
          id: "coder",
          description: "writes code",
          model: "gpt-4",
          systemPrompt: "You are a coder.",
          allowedTools: ["Read", "Write"],
          disallowedTools: ["Bash"],
          maxTurns: 30,
        },
      ])
      await registry.loadFromConfig(config, "/tmp")
      registry.create("parent")

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          subAgents: {
            coder: {
              description: "writes code",
              prompt: "test-prompt",
              allowedTools: ["Read", "Write"],
              disallowedTools: ["Bash"],
              maxTurns: 30,
            },
          },
        }),
      )
    })

    it("uses def.description for the main agent SDK description", async () => {
      const config = makeConfig([
        { id: "a", name: "Display Name", description: "the description", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")
      registry.create("a")
      const call = mockCreateAgent.mock.calls[0][0]
      expect(call.agent.description).toBe("the description")
    })

    it("keeps delegation depth at 1 (mounted agent own subagents not expanded)", async () => {
      const config = makeConfig([
        { id: "a", description: "da", model: "gpt-4", subagents: ["b"] },
        { id: "b", description: "db", model: "gpt-4", subagents: ["c"] },
        { id: "c", description: "dc", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")
      registry.create("a")
      const call = mockCreateAgent.mock.calls[0][0]
      expect(call.subAgents.b).toBeDefined()
      expect(call.subAgents.b.subagents).toBeUndefined()
      expect(call.subAgents.c).toBeUndefined()
    })

    it("passes no subAgents when subagents is unset", async () => {
      const config = makeConfig([{ id: "solo", description: "x", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")
      registry.create("solo")
      const call = mockCreateAgent.mock.calls[0][0]
      expect(call.subAgents).toBeUndefined()
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
