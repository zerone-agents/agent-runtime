import { describe, it, expect, vi, beforeEach } from "vitest"
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

vi.mock("../skills.js", () => ({
  scanSkills: vi.fn(async () => []),
  materializeSkills: vi.fn(async () => []),
  toSummaries: vi.fn(() => []),
}))

vi.mock("../tools/loader.js", () => ({
  loadToolFiles: vi.fn(async () => []),
}))

import { createAgent } from "@zerone-agent/agent-sdk"
import { loadToolFiles } from "../tools/loader.js"

const mockCreateAgent = vi.mocked(createAgent)
const mockLoadToolFiles = vi.mocked(loadToolFiles)

function makeConfig(agents: any[]) {
  return {
    server: { host: "0.0.0.0", port: 3000 },
    agents,
  } as any
}

describe("AgentRegistry (file tools)", () => {
  let registry: AgentRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadToolFiles.mockResolvedValue([])
    registry = new AgentRegistry()
  })

  it("does not load tool files when customTools is not configured", async () => {
    const config = makeConfig([{ id: "agent-a", model: "gpt-4" }])
    await registry.loadFromConfig(config, "/cfg")
    expect(mockLoadToolFiles).not.toHaveBeenCalled()
  })

  it("resolves customTools entries against configDir", async () => {
    const config = makeConfig([
      { id: "agent-a", model: "gpt-4", customTools: ["tools/a.ts", "tools/b.mjs"] },
    ])
    await registry.loadFromConfig(config, "/cfg")
    expect(mockLoadToolFiles).toHaveBeenCalledWith([
      "/cfg/tools/a.ts",
      "/cfg/tools/b.mjs",
    ])
  })

  it("accepts absolute customTools paths as-is", async () => {
    const config = makeConfig([
      { id: "agent-a", model: "gpt-4", customTools: ["/opt/zerone/tools/a.ts"] },
    ])
    await registry.loadFromConfig(config, "/cfg")
    expect(mockLoadToolFiles).toHaveBeenCalledWith(["/opt/zerone/tools/a.ts"])
  })

  it("passes loaded file tools to createAgent as agent.capabilities.customTools", async () => {
    const fileTool = { name: "say_hello", description: "hi" }
    mockLoadToolFiles.mockResolvedValue([fileTool as any])
    mockCreateAgent.mockReturnValue({ close: vi.fn() } as any)

    const config = makeConfig([
      { id: "agent-a", model: "gpt-4", customTools: ["tools/a.ts"] },
    ])
    await registry.loadFromConfig(config, "/cfg")
    registry.create("agent-a")

    const opts = mockCreateAgent.mock.calls[0][0] as any
    // Agent-local (#47): tools live in capabilities, no top-level customTools;
    // Read 防护工具随 fileTools 一并注入（同名接管内置 Read，issue #43）
    expect(opts.customTools).toBeUndefined()
    expect(opts.agent.capabilities.customTools).toEqual([fileTool, expect.objectContaining({ name: "Read" })])
  })

  it("marks only the failing agent unavailable when tool loading throws", async () => {
    mockLoadToolFiles.mockImplementation(async (paths: string[]) => {
      if (paths.some((p) => p.includes("bad"))) throw new Error("invalid tool file")
      return []
    })

    const config = makeConfig([
      { id: "bad-agent", model: "gpt-4", customTools: ["tools/bad.ts"] },
      { id: "good-agent", model: "gpt-4", customTools: ["tools/good.ts"] },
    ])
    await registry.loadFromConfig(config, "/cfg")

    expect(registry.getStatus("bad-agent")).toBe("unavailable")
    expect(registry.getStatus("good-agent")).toBe("ready")
  })

  it("exposes loaded file tool names in agent detail", async () => {
    mockLoadToolFiles.mockResolvedValue([
      { name: "say_hello" },
      { name: "get_weather" },
    ] as any)

    const config = makeConfig([
      { id: "agent-a", model: "gpt-4", customTools: ["tools/a.ts"] },
    ])
    await registry.loadFromConfig(config, "/cfg")

    expect(registry.getDetail("agent-a")?.fileTools).toEqual([
      "say_hello",
      "get_weather",
    ])
  })

  it("omits fileTools in detail when customTools is not configured", async () => {
    const config = makeConfig([{ id: "agent-a", model: "gpt-4" }])
    await registry.loadFromConfig(config, "/cfg")
    expect(registry.getDetail("agent-a")?.fileTools).toBeUndefined()
  })
})
