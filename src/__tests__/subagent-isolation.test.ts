import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentRegistry } from "../registry.js"

vi.mock("@zerone-agent/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zerone-agent/agent-sdk")>()
  return {
    ...actual,
    createAgent: vi.fn(),
    connectMCPServer: vi.fn(),
  }
})

vi.mock("../skills.js", () => ({
  scanSkills: vi.fn(async () => []),
  materializeSkills: vi.fn(async () => []),
  toSummaries: vi.fn(() => []),
}))

vi.mock("../tools/loader.js", () => ({
  loadToolFiles: vi.fn(async () => []),
}))

import { createAgent, connectMCPServer } from "@zerone-agent/agent-sdk"
import { materializeSkills } from "../skills.js"
import { loadToolFiles } from "../tools/loader.js"

const mockCreateAgent = vi.mocked(createAgent)
const mockConnectMcp = vi.mocked(connectMCPServer)
const mockMaterializeSkills = vi.mocked(materializeSkills)
const mockLoadToolFiles = vi.mocked(loadToolFiles)

function makeConfig(agents: any[]) {
  return { server: { host: "0.0.0.0", port: 3000 }, agents } as any
}

const CHILD_A_MCP = { transport: "stdio", command: "node", args: ["child-a.js"] }

const CONFIG = makeConfig([
  {
    id: "parent",
    description: "coordinator",
    model: "parent-model",
    apiKey: "parent-key",
    systemPrompt: "You are parent.",
    datasets: { "parent-data": "parent dataset" },
    settingSources: ["user"],
    customTools: ["tools/parent-tool.ts"],
    allowedTools: ["Read", "Write"],
    mcpServers: { parentSrv: { transport: "http", url: "http://parent.example/mcp" } },
    subagents: ["child-a", "child-b", "child-b2", "explore-plain"],
  },
  {
    id: "child-a",
    description: "coder",
    model: "child-model",
    systemPrompt: "You code.",
    datasets: { "child-a-data": "child a dataset" },
    settingSources: ["project"],
    extraUserSkillDirs: ["/iso/skills/a"],
    customTools: ["tools/child-a-tool.ts"],
    disallowedTools: ["Bash"],
    mcpServers: { childASrv: CHILD_A_MCP },
    subagents: ["leaf"], // ignored when mounted: delegation depth is 1
  },
  {
    id: "child-b",
    description: "reader",
    model: "child-model",
    systemPrompt: "You read.",
    settingSources: ["project"],
    extraUserSkillDirs: ["/iso/skills/b"],
  },
  {
    id: "child-b2",
    description: "shares child-a mcp config",
    model: "child-model",
    systemPrompt: "You share.",
    mcpServers: { childASrv: CHILD_A_MCP },
  },
  {
    id: "explore-plain",
    description: "explore agent with no declared policy",
    model: "child-model",
    systemPrompt: "You explore.",
  },
  { id: "leaf", description: "leaf", model: "child-model", systemPrompt: "leaf" },
  {
    id: "bad-child",
    description: "broken mcp",
    model: "child-model",
    systemPrompt: "broken",
    mcpServers: {
      badSrv: {
        transport: "http",
        url: "http://bad.example/mcp",
        headers: { Authorization: "Bearer tok" },
      },
    },
  },
  {
    id: "bad-parent",
    description: "references the broken child",
    model: "child-model",
    systemPrompt: "x",
    subagents: ["bad-child"],
  },
  { id: "bystander", description: "unrelated", model: "child-model", systemPrompt: "x" },
])

describe("subagent capability isolation — issue #47 acceptance", () => {
  let registry: AgentRegistry
  const connCloses = new Map<string, ReturnType<typeof vi.fn>>()

  beforeEach(async () => {
    vi.clearAllMocks()
    connCloses.clear()

    mockConnectMcp.mockImplementation(async (name: string) => {
      if (name === "badSrv") {
        return {
          name,
          status: "error",
          tools: [],
          error: new Error("conn refused (secret=hunter2)"),
          close: async () => {},
        } as never
      }
      const close = vi.fn(async () => {})
      connCloses.set(name, close)
      return {
        name,
        status: "connected",
        tools: [{ name: `mcp__${name}__tool`, execute: vi.fn() }],
        close,
      } as never
    })

    mockMaterializeSkills.mockImplementation(
      async (o: { settingSources?: string[]; extraUserSkillDirs?: string[] }) => {
        if (o.settingSources?.[0] === "user") return [{ name: "skill-parent" }] as never
        const extra = o.extraUserSkillDirs?.[0]
        if (extra?.endsWith("/a")) return [{ name: "skill-child-a" }] as never
        if (extra?.endsWith("/b")) return [{ name: "skill-child-b" }] as never
        return [] as never
      },
    )

    mockLoadToolFiles.mockImplementation(async (paths: string[]) =>
      paths.map((p) => ({
        name: p.split("/").pop()!.replace(/\.[cm]?[jt]s$/, ""),
        description: `file tool at ${p}`,
        execute: vi.fn(),
      })) as never,
    )

    registry = new AgentRegistry()
    await registry.loadFromConfig(CONFIG, "/iso-cfg")
    registry.create("parent")
  })

  /** createAgent opts captured for the root `parent` run. */
  function parentOpts(): any {
    expect(mockCreateAgent).toHaveBeenCalled()
    return mockCreateAgent.mock.calls[0]![0] as any
  }

  it("1. MCP isolation: each agent sees only its own servers; empty stays empty; shared config reuses one connection", () => {
    const opts = parentOpts()
    // Root sees only parentSrv — never a child's server.
    expect(opts.agent.capabilities.connectionTools.map((t: any) => t.name)).toEqual([
      "mcp__parentSrv__tool",
    ])
    const sub = opts.subAgents
    expect(sub["child-a"].capabilities.connectionTools.map((t: any) => t.name)).toEqual([
      "mcp__childASrv__tool",
    ])
    // child-b declares no MCP: NO fallback to parent's tools.
    expect(sub["child-b"].capabilities.connectionTools).toEqual([])
    // child-b2 declares the same config as child-a: tools present, one connection.
    expect(sub["child-b2"].capabilities.connectionTools.map((t: any) => t.name)).toEqual([
      "mcp__childASrv__tool",
    ])
    const childASrvCalls = mockConnectMcp.mock.calls.filter(
      (c) => (c[0] as string) === "childASrv",
    )
    expect(childASrvCalls).toHaveLength(1)
    // canonical (transport→type) config reached the SDK, with the stdio
    // stderr-discard wrap applied (#54 review r2)
    expect(mockConnectMcp).toHaveBeenCalledWith("childASrv", {
      type: "stdio",
      command: "/bin/sh",
      args: ["-c", 'exec "$0" "$@" 2>/dev/null', "node", "child-a.js"],
    })
  })

  it("2. CustomTools isolation: file tools are agent-local, no parent fallback", () => {
    const opts = parentOpts()
    // Read 防护工具是 runtime 固定注入的固定层（每个 agent 一份，非继承；
    // 排在用户工具之后，later-wins 覆盖同名内置 Read），不改变隔离语义
    expect(opts.agent.capabilities.customTools.map((t: any) => t.name)).toEqual([
      "parent-tool",
      "Read",
    ])
    expect(opts.subAgents["child-a"].capabilities.customTools.map((t: any) => t.name)).toEqual([
      "child-a-tool",
      "Read",
    ])
    expect(opts.subAgents["child-b"].capabilities.customTools.map((t: any) => t.name)).toEqual([
      "Read",
    ])
  })

  it("3. Skills isolation: capabilities.skills is the entry's own materialized set", () => {
    const opts = parentOpts()
    expect(opts.agent.capabilities.skills.map((s: any) => s.name)).toEqual(["skill-parent"])
    expect(opts.subAgents["child-a"].capabilities.skills.map((s: any) => s.name)).toEqual([
      "skill-child-a",
    ])
    expect(opts.subAgents["child-b"].capabilities.skills.map((s: any) => s.name)).toEqual([
      "skill-child-b",
    ])
    expect(opts.subAgents["child-b2"].capabilities.skills).toEqual([])
  })

  it("4. Datasets isolation: each resolved prompt carries only its own datasets; datasets never enter capabilities", () => {
    const opts = parentOpts()
    expect(opts.agent.prompt).toContain("<datasets>")
    expect(opts.agent.prompt).toContain("parent-data")
    expect(opts.agent.prompt).not.toContain("child-a-data")
    const childPrompt: string = opts.subAgents["child-a"].prompt
    expect(childPrompt).toContain("child-a-data")
    expect(childPrompt).not.toContain("parent-data")
    expect("datasets" in opts.agent.capabilities).toBe(false)
    expect("datasets" in opts.subAgents["child-a"].capabilities).toBe(false)
  })

  it("5. Policy isolation: declared policy only, runtime injects no static read-only lists", () => {
    const opts = parentOpts()
    const parentCaps = opts.agent.capabilities
    expect(parentCaps.allowedTools).toEqual(["Read", "Write"])
    expect("disallowedTools" in parentCaps).toBe(false)
    const childACaps = opts.subAgents["child-a"].capabilities
    expect(childACaps.disallowedTools).toEqual(["Bash"])
    expect("allowedTools" in childACaps).toBe(false)
    // Explore agent declared nothing: runtime must NOT statically enumerate
    // read-only tool lists (SDK applies the dynamic filter at spawn).
    const plainCaps = opts.subAgents["explore-plain"].capabilities
    expect("allowedTools" in plainCaps).toBe(false)
    expect("disallowedTools" in plainCaps).toBe(false)
  })

  it("6. Global env inheritance: root opts carry provider fields; mounted child defs carry none", () => {
    const opts = parentOpts()
    expect(opts.model).toBe("parent-model")
    expect(opts.apiKey).toBe("parent-key")
    for (const def of Object.values<any>(opts.subAgents)) {
      expect(Object.keys(def).sort()).toEqual(["capabilities", "description", "maxTurns", "prompt"])
    }
  })

  it("7. Depth constraint: mounted defs have no subAgents; child-a's own references are ignored", () => {
    const opts = parentOpts()
    const sub = opts.subAgents
    expect(Object.keys(sub).sort()).toEqual([
      "child-a",
      "child-b",
      "child-b2",
      "explore-plain",
    ])
    for (const def of Object.values<any>(sub)) {
      expect(def.subAgents).toBeUndefined()
      expect(def.subagents).toBeUndefined()
    }
    // child-a.subagents: ["leaf"] is only relevant when child-a runs as root.
    expect(sub["child-a"]).toBeDefined()
  })

  it("8. Lifecycle & error isolation: failure is scoped; closeAll releases each unique connection once", async () => {
    expect(registry.getStatus("bad-child")).toBe("unavailable")
    expect(registry.getStatus("bad-parent")).toBe("unavailable")
    expect(registry.getDetail("bad-parent")!.unavailableReason).toBe(
      'subagent "bad-child" unavailable',
    )
    expect(registry.getStatus("bystander")).toBe("ready")
    mockCreateAgent.mockReturnValueOnce({ close: vi.fn() } as never)
    expect(registry.create("bystander")).toBeDefined()

    await registry.closeAll()
    for (const [name, close] of connCloses) {
      expect(close, `connection "${name}"`).toHaveBeenCalledTimes(1)
    }
    await registry.closeAll() // idempotent
    for (const close of connCloses.values()) {
      expect(close).toHaveBeenCalledTimes(1)
    }
  })

  it("9. Sanitization: headers/env redacted in detail; failure reason is runtime-constructed; no credentials", () => {
    const detail = registry.getDetail("bad-child")!
    expect(detail.mcpServers!.badSrv.headers).toEqual({ Authorization: "***" })
    expect(detail.unavailableReason).toBe('MCP server "badSrv" failed to connect')
    // Raw SDK error text (secret=hunter2) never reaches the detail payload.
    expect(JSON.stringify(detail)).not.toContain("hunter2")

    const parentDetail = registry.getDetail("parent")!
    expect(parentDetail.mcpServers!.parentSrv.connectionStatus).toBe("connected")
    expect(JSON.stringify(parentDetail)).not.toContain("parent-key")
  })
})
