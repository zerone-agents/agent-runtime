import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AgentRegistry } from "../registry.js"

vi.mock("@zerone-agent/agent-sdk", () => ({
  createAgent: vi.fn(),
  connectMCPServer: vi.fn(async () => ({
    name: "default",
    status: "connected",
    tools: [],
    close: async () => {},
  })),
}))

vi.mock("../config.js", () => ({
  resolveSystemPrompt: vi.fn(() => "test-prompt"),
}))

vi.mock("../skills.js", () => ({
  scanSkills: vi.fn(async () => []),
  materializeSkills: vi.fn(async () => []),
  toSummaries: vi.fn(() => []),
}))

vi.mock("../tools/loader.js", () => ({
  loadToolDirectory: vi.fn(async () => []),
  loadToolFiles: vi.fn(async () => []),
}))

import { createAgent } from "@zerone-agent/agent-sdk"

const mockCreateAgent = vi.mocked(createAgent)

function makeConfig(agents: any[]) {
  return {
    server: { host: "0.0.0.0", port: 3000 },
    agents,
  } as any
}

describe("AgentRegistry (provider credentials from config)", () => {
  let registry: AgentRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateAgent.mockReturnValue({ close: vi.fn() } as any)
    registry = new AgentRegistry()
  })

  afterEach(() => {
    delete process.env.ZERONE_AGENT_API_KEY
    delete process.env.ZERONE_AGENT_BASE_URL
    delete process.env.ZERONE_AGENT_API_TYPE
  })

  it("passes apiKey/baseURL/apiType from config to createAgent", async () => {
    const config = makeConfig([
      {
        id: "agent-a",
        model: "deepseek-v3",
        apiKey: "sk-config",
        baseURL: "https://api.deepseek.com",
        apiType: "openai",
      },
    ])
    await registry.loadFromConfig(config, "/cfg")
    registry.create("agent-a")

    const opts = mockCreateAgent.mock.calls[0][0] as any
    expect(opts.apiKey).toBe("sk-config")
    expect(opts.baseURL).toBe("https://api.deepseek.com")
    expect(opts.apiType).toBe("openai")
  })

  it("environment variables override config values", async () => {
    process.env.ZERONE_AGENT_API_KEY = "sk-env"
    process.env.ZERONE_AGENT_BASE_URL = "https://env.example.com"

    const config = makeConfig([
      {
        id: "agent-a",
        model: "deepseek-v3",
        apiKey: "sk-config",
        baseURL: "https://api.deepseek.com",
      },
    ])
    await registry.loadFromConfig(config, "/cfg")
    registry.create("agent-a")

    const opts = mockCreateAgent.mock.calls[0][0] as any
    expect(opts.apiKey).toBe("sk-env")
    expect(opts.baseURL).toBe("https://env.example.com")
  })

  it("leaves credentials undefined when neither env nor config provides them", async () => {
    const config = makeConfig([{ id: "agent-a", model: "gpt-4" }])
    await registry.loadFromConfig(config, "/cfg")
    registry.create("agent-a")

    const opts = mockCreateAgent.mock.calls[0][0] as any
    expect(opts.apiKey).toBeUndefined()
    expect(opts.baseURL).toBeUndefined()
    expect(opts.apiType).toBeUndefined()
  })

  it("does not expose apiKey in agent detail", async () => {
    const config = makeConfig([
      { id: "agent-a", model: "gpt-4", apiKey: "sk-secret" },
    ])
    await registry.loadFromConfig(config, "/cfg")

    const detail = registry.getDetail("agent-a") as any
    expect(detail.apiKey).toBeUndefined()
    expect(JSON.stringify(detail)).not.toContain("sk-secret")
  })
})
