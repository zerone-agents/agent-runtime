import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@zerone-agent/agent-sdk", () => ({
  connectMCPServer: vi.fn(),
}))

import { connectMCPServer } from "@zerone-agent/agent-sdk"
import {
  McpConnectionManager,
  McpConnectionError,
  canonicalMcpConfig,
} from "../mcp-connections.js"

const mockConnect = vi.mocked(connectMCPServer)

function okConn(name: string, toolNames: string[] = []) {
  return {
    name,
    status: "connected" as const,
    tools: toolNames.map((n) => ({ name: n, execute: vi.fn() })),
    close: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("canonicalMcpConfig", () => {
  it("renames transport to type", () => {
    expect(canonicalMcpConfig({ transport: "stdio", command: "node" })).toEqual({
      type: "stdio",
      command: "node",
    })
  })
  it("leaves type spelling untouched", () => {
    expect(canonicalMcpConfig({ type: "http", url: "http://x" })).toEqual({
      type: "http",
      url: "http://x",
    })
  })
})

describe("McpConnectionManager", () => {
  it("shares one connection for identical config across entries", async () => {
    mockConnect.mockResolvedValueOnce(okConn("db", ["q"]) as never)
    const m = new McpConnectionManager()
    const cfg = { transport: "stdio", command: "node" }
    const a = await m.acquire("agent-a", "db", cfg)
    const b = await m.acquire("agent-b", "db", cfg)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
    expect(m.describe("agent-b")).toEqual([
      { name: "db", status: "connected", shared: true },
    ])
  })

  it("treats transport and type spellings of the same config as one key", async () => {
    mockConnect.mockResolvedValueOnce(okConn("db") as never)
    const m = new McpConnectionManager()
    await m.acquire("a", "db", { transport: "stdio", command: "node" })
    await m.acquire("b", "db", { type: "stdio", command: "node" })
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it("connects separately for different config under the same name", async () => {
    mockConnect.mockResolvedValueOnce(okConn("db") as never)
    mockConnect.mockResolvedValueOnce(okConn("db") as never)
    const m = new McpConnectionManager()
    await m.acquire("a", "db", { transport: "stdio", command: "node" })
    await m.acquire("a", "db", { transport: "stdio", command: "bun" })
    expect(mockConnect).toHaveBeenCalledTimes(2)
  })

  it("throws sanitized McpConnectionError on error status (no raw error text)", async () => {
    mockConnect.mockResolvedValueOnce({
      name: "db",
      status: "error",
      tools: [],
      error: new Error("secret-token-xyz in https://user:pass@host"),
      close: vi.fn(),
    } as never)
    const m = new McpConnectionManager()
    await expect(
      m.acquire("a", "db", { transport: "stdio", command: "node" }),
    ).rejects.toThrow('MCP server "db" failed to connect')
    await expect(
      m.acquire("a", "db", { transport: "stdio", command: "node" }),
    ).rejects.toBeInstanceOf(McpConnectionError)
    expect(mockConnect).toHaveBeenCalledTimes(1) // 失败连接被共享，不重试
  })

  it("closeAll closes each unique connection once and is idempotent", async () => {
    const c1 = okConn("db")
    const c2 = okConn("api")
    mockConnect.mockResolvedValueOnce(c1 as never)
    mockConnect.mockResolvedValueOnce(c2 as never)
    const m = new McpConnectionManager()
    await m.acquire("a", "db", { transport: "stdio", command: "node" })
    await m.acquire("b", "db", { transport: "stdio", command: "node" })
    await m.acquire("a", "api", { transport: "http", url: "http://x" })
    await m.closeAll()
    await m.closeAll()
    expect(c1.close).toHaveBeenCalledTimes(1)
    expect(c2.close).toHaveBeenCalledTimes(1)
  })

  describe("release (#47 review: per-entry rollback of partial materialization)", () => {
    it("closes and removes an exclusive connection when its last ref goes away", async () => {
      const c = okConn("solo")
      mockConnect.mockResolvedValueOnce(c as never)
      const m = new McpConnectionManager()
      await m.acquire("a", "solo", { transport: "stdio", command: "node" })
      await m.release("a")
      expect(c.close).toHaveBeenCalledTimes(1)
      expect(m.describe("a")).toEqual([])
    })

    it("keeps a shared connection open while other entries still reference it", async () => {
      const c = okConn("db")
      mockConnect.mockResolvedValueOnce(c as never)
      const m = new McpConnectionManager()
      await m.acquire("a", "db", { transport: "stdio", command: "node" })
      await m.acquire("b", "db", { transport: "stdio", command: "node" })
      await m.release("a")
      expect(c.close).not.toHaveBeenCalled()
      expect(m.describe("b")).toEqual([
        { name: "db", status: "connected", shared: false },
      ])
      await m.release("b")
      expect(c.close).toHaveBeenCalledTimes(1)
    })

    it("caches zero-ref error connections (no resources, shared failure, no retry storm)", async () => {
      mockConnect.mockResolvedValueOnce({
        name: "dead",
        status: "error",
        tools: [],
        error: new Error("raw"),
        close: vi.fn(),
      } as never)
      const m = new McpConnectionManager()
      await expect(
        m.acquire("a", "dead", { transport: "stdio", command: "x" }),
      ).rejects.toThrow('MCP server "dead" failed to connect')
      await m.release("a")
      // Same config by another entry: still shared failure, no new attempt.
      await expect(
        m.acquire("b", "dead", { transport: "stdio", command: "x" }),
      ).rejects.toThrow('MCP server "dead" failed to connect')
      expect(mockConnect).toHaveBeenCalledTimes(1)
    })

    it("release of an unknown entry is a no-op", async () => {
      const m = new McpConnectionManager()
      await expect(m.release("nobody")).resolves.toBeUndefined()
    })
  })

  describe("process-global console contract (#51)", () => {
    it("never modifies console.error during connects — host logger identity is preserved", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      let identityInsideConnect: unknown
      mockConnect.mockImplementationOnce(async () => {
        // Captured INSIDE the connect window: with the old interception
        // this was the runtime's filter wrapper, not the host logger.
        identityInsideConnect = console.error
        return {
          name: "db",
          status: "error",
          tools: [],
          error: new Error("secret-token-xyz in https://user:pass@host"),
          close: async () => {},
        } as never
      })
      const m = new McpConnectionManager()
      await expect(
        m.acquire("a", "db", { transport: "stdio", command: "node" }),
      ).rejects.toThrow('MCP server "db" failed to connect')
      // SDK 3.0.2 logs sanitized fields only (server + stable errorType);
      // the runtime must not wrap, replace, or filter the process-global
      // logger at any point — before, during, or after the connect.
      expect(identityInsideConnect).toBe(errSpy)
      expect(console.error).toBe(errSpy)
      errSpy.mockRestore()
    })
  })
})
