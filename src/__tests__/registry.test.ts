import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AgentRegistry } from "../registry.js"

vi.mock("@zerone-agent/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zerone-agent/agent-sdk")>()
  return {
    ...actual,
    createAgent: vi.fn(),
    connectMCPServer: vi.fn(async () => ({
      name: "default",
      status: "connected",
      tools: [],
      close: async () => {},
    })),
  }
})

vi.mock("../config.js", () => ({
  resolveSystemPrompt: vi.fn(() => "test-prompt"),
}))

// Mock skill materialization so registry tests don't touch the real
// filesystem. Defaults return empty; individual tests override.
vi.mock("../skills.js", () => ({
  scanSkills: vi.fn(async () => []),
  materializeSkills: vi.fn(async () => []),
  toSummaries: vi.fn(
    (defs: Array<Record<string, unknown>>) =>
      defs.map((s) => ({
        name: s.name as string,
        description: s.description as string,
        source: (s.source ?? "project") as "user" | "project",
        location: (s.location ?? "") as string,
      })),
  ),
}))

import { createAgent, connectMCPServer } from "@zerone-agent/agent-sdk"
import { materializeSkills } from "../skills.js"

const mockCreateAgent = vi.mocked(createAgent)
const mockConnectMcp = vi.mocked(connectMCPServer)
const mockMaterializeSkills = vi.mocked(materializeSkills)

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
    mockMaterializeSkills.mockResolvedValue([])
    mockConnectMcp.mockResolvedValue({
      name: "default",
      status: "connected",
      tools: [],
      close: async () => {},
    } as never)
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

    it("materializes skills runtime-side; no allowedSkills/settingSources passed to SDK (#47)", async () => {
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
      // Skills are materialized into agent.capabilities.skills by the
      // runtime; the SDK session-registry view (settingSources) is no
      // longer used, so parent/child skill sets cannot cross-contaminate.
      expect(opts.settingSources).toBeUndefined()
      expect(opts.extraUserSkillDirs).toBeUndefined()
      expect(mockMaterializeSkills).toHaveBeenCalledWith({
        cwd: process.cwd(),
        settingSources: ["user"],
        extraUserSkillDirs: undefined,
      })
      expect(opts.agent.capabilities.skills).toEqual([])
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
      // Agent-local (#47): no top-level mcpServers — connections are
      // pre-materialized by the runtime manager and flow into capabilities.
      expect(opts.mcpServers).toBeUndefined()
      // canonical config (transport→type) reached connectMCPServer —
      // http unchanged; stdio carries the stderr-discard wrap (#54 r2)
      expect(mockConnectMcp).toHaveBeenCalledWith("web", {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      })
      expect(mockConnectMcp).toHaveBeenCalledWith("local", {
        type: "stdio",
        command: "/bin/sh",
        args: ["-c", 'exec "$0" "$@" 2>/dev/null', "node", "server.js"],
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
      mockMaterializeSkills.mockResolvedValue(fakeSkills as never)

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
      mockMaterializeSkills.mockResolvedValue([])
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

    it("returns subagents as [{ agent_id, description }]", async () => {
      const config = makeConfig([
        {
          id: "parent",
          description: "main",
          model: "gpt-4",
          subagents: ["coder", "writer"],
        },
        { id: "coder", description: "writes code", model: "gpt-4" },
        { id: "writer", description: "writes docs", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("parent")!
      expect(detail.subagents).toEqual([
        { agent_id: "coder", description: "writes code" },
        { agent_id: "writer", description: "writes docs" },
      ])
    })

    it("omits subagents from detail when unset", async () => {
      const config = makeConfig([{ id: "solo", description: "x", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")
      expect(registry.getDetail("solo")!.subagents).toBeUndefined()
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

    it("sanitizes MCP stdio config: command/args fully masked, env values masked (#54 review)", async () => {
      const config = makeConfig([{
        id: "stdio-agent",
        model: "gpt-4",
        mcpServers: {
          local: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "some-server", "--token=hunter2"],
            env: { API_KEY: "secret-token", OTHER: "x" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("stdio-agent")!
      expect(detail.mcpServers).toEqual({
        local: {
          transport: "stdio",
          command: "***",
          args: ["***", "***", "***"], // arity preserved, values masked
          env: { API_KEY: "***", OTHER: "***" },
        },
      })
    })

    it("sanitizes MCP sse url to structure (no userinfo/query) and masks header values (#54 review)", async () => {
      const config = makeConfig([{
        id: "sse-agent",
        model: "gpt-4",
        mcpServers: {
          remote: {
            transport: "sse",
            url: "https://user:pass@example.com/sse?token=hunter2",
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

    it("sanitizes MCP http url to structure; unparseable urls are fully masked (#54 review)", async () => {
      const config = makeConfig([{
        id: "http-agent",
        model: "gpt-4",
        mcpServers: {
          api: {
            transport: "http",
            url: "https://api.example.com:8443/mcp?key=hunter2",
            headers: { "X-API-Key": "abc" },
          },
          weird: {
            transport: "http",
            url: "not a valid url",
            headers: { "X-API-Key": "abc" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("http-agent")!
      expect(detail.mcpServers).toEqual({
        api: {
          transport: "http",
          url: "https://api.example.com:8443/mcp",
          headers: { "X-API-Key": "***" },
        },
        weird: {
          transport: "http",
          url: "***",
          headers: { "X-API-Key": "***" },
        },
      })
    })

    it("availableSkills is per-agent isolated (multi-agent with different scans)", async () => {
      // Agent A scans and gets skill "cbt"; agent B scans and gets nothing.
      mockMaterializeSkills
        .mockResolvedValueOnce([
          { name: "cbt", description: "therapy", source: "project" as const, location: "/a/SKILL.md" },
        ] as never)
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

    it("materializes subAgents from id references with policy in capabilities", async () => {
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
              maxTurns: 30,
              capabilities: {
                connectionTools: [],
                // Read 防护工具为 runtime 固定注入（同名接管内置 Read，issue #43）
                customTools: [expect.objectContaining({ name: "Read" })],
                skills: [],
                allowedTools: ["Read", "Write"],
                disallowedTools: ["Bash"],
              },
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
      const call = mockCreateAgent.mock.calls[0]![0]!
      expect(call.agent!.description).toBe("the description")
    })

    it("keeps delegation depth at 1 (mounted agent own subagents not expanded)", async () => {
      const config = makeConfig([
        { id: "a", description: "da", model: "gpt-4", subagents: ["b"] },
        { id: "b", description: "db", model: "gpt-4", subagents: ["c"] },
        { id: "c", description: "dc", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")
      registry.create("a")
      const call = mockCreateAgent.mock.calls[0]![0]!
      expect(call.subAgents!.b).toBeDefined()
      // SDK's mounted-agent type carries no `subagents`; the cast types this negative assertion.
      expect((call.subAgents!.b as { subagents?: string[] }).subagents).toBeUndefined()
      expect(call.subAgents!.c).toBeUndefined()
    })

    it("passes no subAgents when subagents is unset", async () => {
      const config = makeConfig([{ id: "solo", description: "x", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")
      registry.create("solo")
      const call = mockCreateAgent.mock.calls[0]![0]!
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

  describe("two-phase capability materialization (#47)", () => {
    it("puts entry MCP tools into agent.capabilities.connectionTools, not top-level mcpServers", async () => {
      mockConnectMcp.mockResolvedValueOnce({
        name: "db",
        status: "connected",
        tools: [{ name: "mcp__db__query", execute: vi.fn() }],
        close: async () => {},
      } as never)
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        makeConfig([
          { id: "solo", model: "gpt-4", mcpServers: { db: { transport: "stdio", command: "node" } } },
        ]),
        "/tmp",
      )
      registry.create("solo")
      const opts = mockCreateAgent.mock.calls[0]![0]!
      expect(opts.mcpServers).toBeUndefined()
      expect(
        opts.agent!.capabilities!.connectionTools!.map((t: { name: string }) => t.name),
      ).toEqual(["mcp__db__query"])
      // canonical config (transport→type) reached connectMCPServer, with
      // the stdio stderr-discard wrap applied (#54 review r2)
      expect(mockConnectMcp).toHaveBeenCalledWith("db", {
        type: "stdio",
        command: "/bin/sh",
        args: ["-c", 'exec "$0" "$@" 2>/dev/null', "node"],
      })
    })

    it("mounts child capabilities from the child entry's own assets", async () => {
      mockConnectMcp.mockImplementation(async (n: string) =>
        ({
          name: n,
          status: "connected",
          tools: [{ name: `mcp__${n}__tool`, execute: vi.fn() }],
          close: async () => {},
        }) as never)
      mockMaterializeSkills.mockImplementation(async (o: { settingSources?: string[] }) =>
        o.settingSources?.[0] === "user"
          ? [{ name: "skill-parent" } as never]
          : ([{ name: "skill-child" }] as never))
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        makeConfig([
          {
            id: "parent",
            model: "gpt-4",
            subagents: ["child"],
            settingSources: ["user"],
            mcpServers: { parentSrv: { transport: "stdio", command: "a" } },
          },
          {
            id: "child",
            model: "gpt-4",
            settingSources: ["project"],
            mcpServers: { childSrv: { transport: "stdio", command: "b" } },
          },
        ]),
        "/tmp",
      )
      registry.create("parent")
      const opts = mockCreateAgent.mock.calls[0]![0]!
      expect(
        opts.agent!.capabilities!.connectionTools!.map((t: { name: string }) => t.name),
      ).toEqual(["mcp__parentSrv__tool"])
      expect(
        opts.agent!.capabilities!.skills!.map((s: { name: string }) => s.name),
      ).toEqual(["skill-parent"])
      const child = opts.subAgents!.child!
      expect(
        child.capabilities!.connectionTools!.map((t: { name: string }) => t.name),
      ).toEqual(["mcp__childSrv__tool"])
      expect(
        child.capabilities!.skills!.map((s: { name: string }) => s.name),
      ).toEqual(["skill-child"])
      // 深度 1：挂载定义无 subAgents（SDK v3 类型本身无此字段——结构性保证，
      // cast 仅为断言其不存在）
      expect((child as { subAgents?: unknown }).subAgents).toBeUndefined()
    })

    it("marks parent unavailable when a referenced child failed phase-1 materialization", async () => {
      mockConnectMcp.mockImplementation(
        async (n: string) =>
          n === "bad"
            ? { name: n, status: "error", tools: [], error: new Error("raw secret"), close: async () => {} }
            : { name: n, status: "connected", tools: [], close: async () => {} },
      )
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        makeConfig([
          { id: "broken-child", model: "gpt-4", mcpServers: { bad: { transport: "stdio", command: "x" } } },
          { id: "parent", model: "gpt-4", subagents: ["broken-child"] },
          { id: "bystander", model: "gpt-4" },
        ]),
        "/tmp",
      )
      expect(registry.getStatus("broken-child")).toBe("unavailable")
      expect(registry.getStatus("parent")).toBe("unavailable")
      expect(registry.getDetail("parent")!.unavailableReason).toBe(
        'subagent "broken-child" unavailable',
      )
      expect(registry.getStatus("bystander")).toBe("ready") // 无引用关系不受污染
    })

    it("grandparent stays ready when child's own root assembly failed (order-independent)", async () => {
      // child 物化成功但其引用的 grandchild 失败 → child-as-root unavailable,
      // 但 grandparent 挂载的 child caps 完整 → grandparent ready
      mockConnectMcp.mockImplementation(
        async (n: string) =>
          n === "dead"
            ? { name: n, status: "error", tools: [], close: async () => {} }
            : { name: n, status: "connected", tools: [], close: async () => {} },
      )
      const registry = new AgentRegistry()
      // 配置顺序故意让 grandparent 在最前
      await registry.loadFromConfig(
        makeConfig([
          { id: "gp", model: "gpt-4", subagents: ["mid"] },
          { id: "mid", model: "gpt-4", subagents: ["dead-leaf"] },
          { id: "dead-leaf", model: "gpt-4", mcpServers: { dead: { transport: "stdio", command: "x" } } },
        ]),
        "/tmp",
      )
      expect(registry.getStatus("dead-leaf")).toBe("unavailable")
      expect(registry.getStatus("mid")).toBe("unavailable")
      expect(registry.getStatus("gp")).toBe("ready")
    })

    it("releases the entry's already-acquired connections when materialization fails mid-way (#47 review)", async () => {
      const goodClose = vi.fn(async () => {})
      mockConnectMcp.mockImplementation(async (n: string) => {
        if (n === "bad") {
          return {
            name: n,
            status: "error",
            tools: [],
            error: new Error("down"),
            close: async () => {},
          }
        }
        return { name: n, status: "connected", tools: [], close: goodClose }
      })
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        makeConfig([
          {
            id: "two-servers",
            model: "gpt-4",
            mcpServers: {
              good: { transport: "stdio", command: "ok" },
              bad: { transport: "stdio", command: "nope" },
            },
          },
          { id: "sharer", model: "gpt-4", mcpServers: { good: { transport: "stdio", command: "ok" } } },
        ]),
        "/tmp",
      )
      expect(registry.getStatus("two-servers")).toBe("unavailable")
      // "good" still serves the other entry — NOT closed.
      expect(goodClose).not.toHaveBeenCalled()
      expect(registry.getStatus("sharer")).toBe("ready")

      // Now a failing entry whose "good" connection is exclusive.
      const soloClose = vi.fn(async () => {})
      mockConnectMcp.mockImplementation(async (n: string) => {
        if (n === "bad2") {
          return { name: n, status: "error", tools: [], error: new Error("down"), close: async () => {} }
        }
        return { name: n, status: "connected", tools: [], close: soloClose }
      })
      const registry2 = new AgentRegistry()
      await registry2.loadFromConfig(
        makeConfig([
          {
            id: "exclusive",
            model: "gpt-4",
            mcpServers: {
              good2: { transport: "stdio", command: "solo" },
              bad2: { transport: "stdio", command: "nope" },
            },
          },
        ]),
        "/tmp",
      )
      expect(registry2.getStatus("exclusive")).toBe("unavailable")
      // Exclusive connection rolled back with the failed entry — not leaked
      // until shutdown.
      expect(soloClose).toHaveBeenCalledTimes(1)
    })

    it("closes all managed MCP connections on closeAll", async () => {
      const close = vi.fn(async () => {})
      mockConnectMcp.mockResolvedValue({
        name: "db",
        status: "connected",
        tools: [],
        close,
      } as never)
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        makeConfig([
          { id: "a", model: "gpt-4", mcpServers: { db: { transport: "stdio", command: "x" } } },
          { id: "b", model: "gpt-4", mcpServers: { db: { transport: "stdio", command: "x" } } },
        ]),
        "/tmp",
      )
      await registry.closeAll()
      expect(close).toHaveBeenCalledTimes(1) // 共享连接只关一次
    })

    it("reload atomically replaces state: removed agents and stale connections are gone (#47 review)", async () => {
      const oldClose = vi.fn(async () => {})
      const newClose = vi.fn(async () => {})
      mockConnectMcp.mockImplementation(async (n: string) =>
        ({
          name: n,
          status: "connected",
          tools: [{ name: `mcp__${n}__tool`, execute: vi.fn() }],
          close: n === "oldSrv" ? oldClose : newClose,
        }) as never)
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        makeConfig([
          { id: "gone", model: "gpt-4", mcpServers: { oldSrv: { transport: "stdio", command: "old" } } },
          { id: "stays", model: "gpt-4" },
        ]),
        "/tmp",
      )
      expect(registry.getStatus("gone")).toBe("ready")

      // Reload without "gone": its agent entry AND its exclusive connection
      // must not linger.
      await registry.loadFromConfig(
        makeConfig([
          { id: "stays", model: "gpt-4", mcpServers: { newSrv: { transport: "stdio", command: "new" } } },
        ]),
        "/tmp",
      )

      expect(registry.getStatus("gone")).toBe("not_found")
      expect(registry.getDetail("gone")).toBeNull()
      expect(registry.list().map((a) => a.id)).toEqual(["stays"])
      expect(oldClose).toHaveBeenCalledTimes(1) // stale connection released
      expect(newClose).not.toHaveBeenCalled() // live connection intact

      registry.create("stays")
      const opts = mockCreateAgent.mock.calls.at(-1)![0] as any
      expect(
        opts.agent.capabilities.connectionTools.map((t: { name: string }) => t.name),
      ).toEqual(["mcp__newSrv__tool"])
    })
  })
})
