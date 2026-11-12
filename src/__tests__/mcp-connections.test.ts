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
import { runWithIdentity, USER_ID_HEADER, RUN_ID_HEADER } from "../run-identity.js"
import { capturedOutput } from "./helpers/deep-log.js"

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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const SECRET = "secret-token-xyz"
    mockConnect.mockImplementationOnce(async () => {
      // SDK 3.1.0 contract: the client logs sanitized structured fields
      // (server + stable errorType) only, keeping the raw credential-bearing
      // error on MCPConnection.error. Model that here — with the raw error
      // in play end to end, the FULL captured runtime logs must stay clean
      // (deep-inspected so nested objects/errors cannot hide a secret).
      console.error("[MCP] Failed to connect to server", {
        server: "db",
        errorType: "init_failed",
      })
      return {
        name: "db",
        status: "error",
        tools: [],
        error: new Error(`${SECRET} in https://user:pass@host`),
        close: vi.fn(),
      } as never
    })
    const m = new McpConnectionManager()
    await expect(
      m.acquire("a", "db", { transport: "stdio", command: "node" }),
    ).rejects.toThrow('MCP server "db" failed to connect')
    await expect(
      m.acquire("a", "db", { transport: "stdio", command: "node" }),
    ).rejects.toBeInstanceOf(McpConnectionError)
    expect(mockConnect).toHaveBeenCalledTimes(1) // 失败连接被共享，不重试

    // Log contract (#54 review r4): full captured logs never carry the
    // credential-bearing raw error text.
    const logged = capturedOutput([errSpy.mock.calls, warnSpy.mock.calls])
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain("user:pass@")
    errSpy.mockRestore()
    warnSpy.mockRestore()
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

  describe("process-global output object contract (#51)", () => {
    it("never modifies console.error or process.stderr.write during connects — host identities are preserved", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      let identityInsideConnect: unknown
      let writeIdentityInsideConnect: unknown
      mockConnect.mockImplementationOnce(async () => {
        // Captured INSIDE the connect window: with the old interception
        // this was the runtime's filter wrapper, not the host logger.
        identityInsideConnect = console.error
        writeIdentityInsideConnect = process.stderr.write
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
      // SDK 3.1.0 logs sanitized fields only (server + stable errorType);
      // the runtime must not wrap, replace, or filter any process-global
      // output object at any point — before, during, or after the connect.
      expect(identityInsideConnect).toBe(errSpy)
      expect(console.error).toBe(errSpy)
      expect(writeIdentityInsideConnect).toBe(writeSpy)
      expect(process.stderr.write).toBe(writeSpy)
      errSpy.mockRestore()
      writeSpy.mockRestore()
    })
  })

  describe("stdio stderr policy (SDK 3.1.0, #51 follow-up)", () => {
    it("explicitly injects stderr: 'ignore' for stdio configs — never relies on the upstream 'inherit' default", async () => {
      mockConnect.mockResolvedValueOnce(okConn("db") as never)
      const m = new McpConnectionManager()
      await m.acquire("a", "db", {
        transport: "stdio",
        command: "npx",
        args: ["-y", "srv", "--token=x"],
        env: { K: "v" },
      })
      // The config handed to the SDK must carry an explicit strict stderr
      // policy: the SDK default is "inherit", which lets the child write
      // straight to the runtime's fd 2 past every JS-level sanitizer.
      expect(mockConnect.mock.calls[0]![1]).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "srv", "--token=x"],
        env: { K: "v" },
        stderr: "ignore",
      })
    })

    it("leaves non-stdio configs untouched", async () => {
      mockConnect.mockResolvedValueOnce(okConn("api") as never)
      const m = new McpConnectionManager()
      await m.acquire("a", "api", { transport: "http", url: "http://x", headers: { A: "b" } })
      expect(mockConnect.mock.calls[0]![1]).toEqual({
        type: "http",
        url: "http://x",
        headers: { A: "b" },
      })
    })
  })
})

describe("identity passthrough wiring (issue #95)", () => {
  it("identityPassthrough: true replaces headers with a dynamic provider (flag stripped for SDK)", async () => {
    mockConnect.mockResolvedValueOnce(okConn("hub") as never)
    const m = new McpConnectionManager()
    await m.acquire("a", "hub", {
      transport: "http",
      url: "http://hub.example/mcp",
      headers: { "X-Agent-Capability": "cap-1" },
      identityPassthrough: true,
    })
    const cfg = mockConnect.mock.calls[0]![1] as unknown as Record<string, unknown>
    expect(cfg.identityPassthrough).toBeUndefined() // runtime 旗标不进 SDK
    expect(typeof cfg.headers).toBe("function")
    // SDK 传输层的按请求解析与静态头合并语义由上游钉（agent-sdk#164）；
    // 此处钉 runtime 闭包：run 之外（cron/后台）→ 仅静态头（无身份）。
    const provider = cfg.headers as () => Record<string, string>
    expect(provider()).toEqual({ "X-Agent-Capability": "cap-1" })
    // run 上下文内 → 叠加身份头（静态头保留，同值贯穿 issue #95 设计）
    const injected = runWithIdentity(
      { runId: "r-9", sessionId: "s-9", userId: "user-9" },
      () => provider(),
    )
    expect(injected).toEqual({
      "X-Agent-Capability": "cap-1",
      [USER_ID_HEADER]: "user-9",
      [RUN_ID_HEADER]: "r-9",
    })
  })

  it("flag absent: headers stay a static record (zero behavior change pin)", async () => {
    mockConnect.mockResolvedValueOnce(okConn("hub") as never)
    const m = new McpConnectionManager()
    await m.acquire("a", "hub", {
      transport: "sse",
      url: "http://hub.example/sse",
      headers: { "X-Agent-Capability": "cap-1" },
    })
    const cfg = mockConnect.mock.calls[0]![1] as unknown as Record<string, unknown>
    expect(cfg.headers).toEqual({ "X-Agent-Capability": "cap-1" }) // 仍是 Record
  })

  it("flag false and absent normalize identically → shared connection; true gets its own", async () => {
    mockConnect.mockResolvedValueOnce(okConn("hub") as never)
    mockConnect.mockResolvedValueOnce(okConn("hub") as never)
    const m = new McpConnectionManager()
    await m.acquire("a", "hub", { transport: "http", url: "http://hub", identityPassthrough: false })
    await m.acquire("b", "hub", { transport: "http", url: "http://hub" }) // off 两种写法同键 → 共享
    await m.acquire("c", "hub", { transport: "http", url: "http://hub", identityPassthrough: true }) // 不同策略 → 独立连接
    expect(mockConnect).toHaveBeenCalledTimes(2)
  })

  it("canonicalMcpConfig keeps identityPassthrough only when true", () => {
    expect(canonicalMcpConfig({ transport: "http", url: "u", identityPassthrough: true })).toEqual({
      type: "http",
      url: "u",
      identityPassthrough: true,
    })
    expect(canonicalMcpConfig({ transport: "http", url: "u", identityPassthrough: false })).toEqual({
      type: "http",
      url: "u",
    })
  })
})
