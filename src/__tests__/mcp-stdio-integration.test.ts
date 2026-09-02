// Real-connection smoke test — NO SDK mock in this file (vi.mock is
// file-scoped, so keeping it here would be pointless; this is deliberately
// a separate file from the mocked unit/isolation suites).
//
// Exercises the actual SDK v3 connectMCPServer stdio path through the
// runtime-owned McpConnectionManager: spawn, initialize, tool
// materialization, and closeAll release.
import { describe, it, expect, vi } from "vitest"
import { fileURLToPath } from "node:url"
import { McpConnectionManager } from "../mcp-connections.js"

const fixture = fileURLToPath(
  new URL("../../test/fixtures/mcp-echo-server.mjs", import.meta.url),
)

describe("McpConnectionManager stdio integration (real connectMCPServer)", () => {
  it("connects to the echo fixture and materializes its tool", async () => {
    const m = new McpConnectionManager()
    try {
      const conn = await m.acquire("it", "echo", {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      })
      expect(conn.status).toBe("connected")
      // SDK naming convention: mcp__<serverName>__<toolName>
      expect(conn.tools.map((t) => t.name)).toContain("mcp__echo__echo")
    } finally {
      await m.closeAll()
    }
  })

  it("failing connect logs no secrets and never touches the global console (SDK 3.0.2, #51)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const SECRET = "hunter2-token-xyz"
    const BAD_BINARY = "definitely-not-a-real-binary"
    const m = new McpConnectionManager()
    try {
      await expect(
        m.acquire("it", "no-such-server", {
          transport: "stdio",
          command: BAD_BINARY,
          args: [`--token=${SECRET}`],
        }),
      ).rejects.toThrow('MCP server "no-such-server" failed to connect')
      // SDK 3.0.2 logs sanitized structured fields only (server name +
      // stable errorType). The spawn ENOENT text — which carries the
      // command and its secret-bearing args — must never reach the logs,
      // and the runtime must not wrap or replace the global logger.
      const logged = [...errSpy.mock.calls, ...warnSpy.mock.calls]
        .map((c) => c.map(String).join(" "))
        .join("\n")
      expect(logged).not.toContain(SECRET)
      expect(logged).not.toContain(BAD_BINARY)
      expect(console.error).toBe(errSpy)
    } finally {
      await m.closeAll()
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
