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

describe("AgentRegistry", () => {
  let registry: AgentRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new AgentRegistry()
  })

  describe("loadFromConfig", () => {
    it("creates agents from config, stores them, sets status to ready", async () => {
      const mockAgent1 = { close: vi.fn().mockResolvedValue(undefined) }
      const mockAgent2 = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent
        .mockReturnValueOnce(mockAgent1 as any)
        .mockReturnValueOnce(mockAgent2 as any)

      const config = makeConfig([
        { id: "agent-a", model: "gpt-4" },
        { id: "agent-b", model: "claude-3" },
      ])

      await registry.loadFromConfig(config, "/tmp")

      expect(mockCreateAgent).toHaveBeenCalledTimes(2)
      expect(mockCreateAgent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ model: "gpt-4", systemPrompt: "test-prompt" }),
      )
      expect(mockCreateAgent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: "claude-3", systemPrompt: "test-prompt" }),
      )
      expect(registry.get("agent-a")).toBe(mockAgent1)
      expect(registry.get("agent-b")).toBe(mockAgent2)
      expect(registry.getStatus("agent-a")).toBe("ready")
      expect(registry.getStatus("agent-b")).toBe("ready")
    })

    it("handles creation failure gracefully, sets status to unavailable", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent
        .mockImplementationOnce(() => {
          throw new Error("creation failed")
        })
        .mockReturnValueOnce(mockAgent as any)

      const config = makeConfig([
        { id: "bad-agent", model: "bad-model" },
        { id: "good-agent", model: "good-model" },
      ])

      await registry.loadFromConfig(config, "/tmp")

      expect(registry.get("bad-agent")).toBeUndefined()
      expect(registry.getStatus("bad-agent")).toBe("unavailable")
      expect(registry.get("good-agent")).toBe(mockAgent)
      expect(registry.getStatus("good-agent")).toBe("ready")
    })
  })

  describe("get", () => {
    it("returns agent by id", async () => {
      const mockAgent = { close: vi.fn().mockResolvedValue(undefined) }
      mockCreateAgent.mockReturnValue(mockAgent as any)

      const config = makeConfig([{ id: "my-agent", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      expect(registry.get("my-agent")).toBe(mockAgent)
    })

    it("returns undefined for unknown id", () => {
      expect(registry.get("nonexistent")).toBeUndefined()
    })
  })

  describe("getStatus", () => {
    it("returns ready for a loaded agent", async () => {
      mockCreateAgent.mockReturnValue({ close: vi.fn() } as any)
      const config = makeConfig([{ id: "a1", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      expect(registry.getStatus("a1")).toBe("ready")
    })

    it("returns unavailable for a failed agent", async () => {
      mockCreateAgent.mockImplementation(() => {
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

  describe("list", () => {
    it("returns AgentInfo array with correct ids and statuses", async () => {
      mockCreateAgent
        .mockReturnValueOnce({ close: vi.fn() } as any)
        .mockImplementationOnce(() => {
          throw new Error("fail")
        })
        .mockReturnValueOnce({ close: vi.fn() } as any)

      const config = makeConfig([
        { id: "agent-1", model: "gpt-4" },
        { id: "agent-2", model: "gpt-4" },
        { id: "agent-3", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      const listed = registry.list()
      expect(listed).toHaveLength(2)
      expect(listed.map((a) => a.id).sort()).toEqual(["agent-1", "agent-3"])
      for (const info of listed) {
        expect(info.status).toBe("ready")
        expect(info).toHaveProperty("name")
        expect(info).toHaveProperty("model")
        expect(info).toHaveProperty("toolCount")
      }
    })
  })

  describe("closeAll", () => {
    it("calls close on all agents and clears maps", async () => {
      const mockClose1 = vi.fn().mockResolvedValue(undefined)
      const mockClose2 = vi.fn().mockResolvedValue(undefined)
      mockCreateAgent
        .mockReturnValueOnce({ close: mockClose1 } as any)
        .mockReturnValueOnce({ close: mockClose2 } as any)

      const config = makeConfig([
        { id: "a1", model: "gpt-4" },
        { id: "a2", model: "gpt-4" },
      ])
      await registry.loadFromConfig(config, "/tmp")

      expect(registry.get("a1")).toBeDefined()
      expect(registry.getStatus("a1")).toBe("ready")

      await registry.closeAll()

      expect(mockClose1).toHaveBeenCalledTimes(1)
      expect(mockClose2).toHaveBeenCalledTimes(1)
      expect(registry.get("a1")).toBeUndefined()
      expect(registry.get("a2")).toBeUndefined()
      expect(registry.getStatus("a1")).toBe("not_found")
      expect(registry.getStatus("a2")).toBe("not_found")
      expect(registry.list()).toEqual([])
    })
  })
})
