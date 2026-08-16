import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentRegistry } from "../registry.js"

vi.mock("@zerone-agent/agent-sdk", () => ({
  createAgent: vi.fn(),
}))

vi.mock("../config.js", () => ({
  resolveSystemPrompt: vi.fn(() => "test-prompt"),
}))

vi.mock("../skills.js", () => ({
  scanSkills: vi.fn(async () => []),
}))

vi.mock("../tools/loader.js", () => ({
  loadToolDirectory: vi.fn(async () => []),
}))

import { createAgent } from "@zerone-agent/agent-sdk"
import { loadToolDirectory } from "../tools/loader.js"

const mockCreateAgent = vi.mocked(createAgent)
const mockLoadToolDirectory = vi.mocked(loadToolDirectory)

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
    mockLoadToolDirectory.mockResolvedValue([])
    registry = new AgentRegistry()
  })

  it("loads file tools from <configDir>/agents/<id>/tools", async () => {
    const config = makeConfig([{ id: "agent-a", model: "gpt-4" }])
    await registry.loadFromConfig(config, "/cfg")
    expect(mockLoadToolDirectory).toHaveBeenCalledWith("/cfg/agents/agent-a/tools")
  })

  it("uses toolsDir from config when provided, resolved against configDir", async () => {
    const config = makeConfig([
      { id: "agent-a", model: "gpt-4", toolsDir: "shared/tools" },
    ])
    await registry.loadFromConfig(config, "/cfg")
    expect(mockLoadToolDirectory).toHaveBeenCalledWith("/cfg/shared/tools")
  })

  it("accepts absolute toolsDir as-is", async () => {
    const config = makeConfig([
      { id: "agent-a", model: "gpt-4", toolsDir: "/opt/zerone/tools" },
    ])
    await registry.loadFromConfig(config, "/cfg")
    expect(mockLoadToolDirectory).toHaveBeenCalledWith("/opt/zerone/tools")
  })

  it("passes loaded file tools to createAgent as customTools", async () => {
    const fileTool = { name: "say_hello", description: "hi" }
    mockLoadToolDirectory.mockResolvedValue([fileTool as any])
    mockCreateAgent.mockReturnValue({ close: vi.fn() } as any)

    const config = makeConfig([{ id: "agent-a", model: "gpt-4" }])
    await registry.loadFromConfig(config, "/cfg")
    registry.create("agent-a")

    const opts = mockCreateAgent.mock.calls[0][0] as any
    expect(opts.customTools).toEqual([fileTool])
  })

  it("marks only the failing agent unavailable when tool loading throws", async () => {
    mockLoadToolDirectory.mockImplementation(async (dir: string) => {
      if (dir.includes("bad-agent")) throw new Error("invalid tool file")
      return []
    })

    const config = makeConfig([
      { id: "bad-agent", model: "gpt-4" },
      { id: "good-agent", model: "gpt-4" },
    ])
    await registry.loadFromConfig(config, "/cfg")

    expect(registry.getStatus("bad-agent")).toBe("unavailable")
    expect(registry.getStatus("good-agent")).toBe("ready")
  })

  it("exposes loaded file tool names in agent detail", async () => {
    mockLoadToolDirectory.mockResolvedValue([
      { name: "say_hello" },
      { name: "get_weather" },
    ] as any)

    const config = makeConfig([{ id: "agent-a", model: "gpt-4" }])
    await registry.loadFromConfig(config, "/cfg")

    expect(registry.getDetail("agent-a")?.fileTools).toEqual([
      "say_hello",
      "get_weather",
    ])
  })

  it("omits fileTools in detail when the agent has no tool directory", async () => {
    const config = makeConfig([{ id: "agent-a", model: "gpt-4" }])
    await registry.loadFromConfig(config, "/cfg")
    expect(registry.getDetail("agent-a")?.fileTools).toBeUndefined()
  })
})
