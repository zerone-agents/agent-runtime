// Real-connection smoke test — NO SDK mock in this file (vi.mock is
// file-scoped, so keeping it here would be pointless; this is deliberately
// a separate file from the mocked unit/isolation suites).
//
// Exercises the actual SDK v3 connectMCPServer stdio path through the
// runtime-owned McpConnectionManager: spawn, initialize, tool
// materialization, and closeAll release.
import { describe, it, expect } from "vitest"
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
})
