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
})
