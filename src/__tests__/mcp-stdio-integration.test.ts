// Real-connection smoke tests — NO SDK mock in this file (vi.mock is
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

/**
 * Deep inspection of logged console arguments (#54 review): String(args)
 * collapses structured objects to "[object Object]" and JSON.stringify
 * hides non-enumerable Error fields (message/stack) — both are leak blind
 * spots. This walker renders nested objects, arrays, and Errors
 * (name + message + stack) so a secret anywhere in a logged argument is
 * detectable.
 */
function deepInspect(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") return String(value)
  if (value instanceof Error) {
    return `${value.name}: ${value.message} ${value.stack ?? ""}`
  }
  if (depth > 6) return "[Depth]"
  if (Array.isArray(value)) {
    return `[${value.map((v) => deepInspect(v, depth + 1)).join(", ")}]`
  }
  try {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([k, v]) => `${k}=${deepInspect(v, depth + 1)}`).join(", ")}}`
  } catch {
    return "[Uninspectable]"
  }
}

/** Render everything captured by console spies through deepInspect. */
function capturedOutput(callSets: unknown[][][]): string {
  return callSets
    .flat()
    .map((call) => call.map((arg) => deepInspect(arg)).join(" "))
    .join("\n")
}

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

  it("spawn-failure connect (ENOENT): sanitized channels stay clean under deep inspection (#54 review)", async () => {
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
      // Deep inspection: a secret nested anywhere inside a logged
      // structured object or Error must be caught, not hidden behind
      // "[object Object]".
      const logged = capturedOutput([errSpy.mock.calls, warnSpy.mock.calls])
      expect(logged).not.toContain(SECRET)
      expect(logged).not.toContain(BAD_BINARY)
      expect(console.error).toBe(errSpy)
    } finally {
      await m.closeAll()
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it("real failing subprocess: sanitizable channels stay clean; raw secret never surfaces (#54 review)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const SECRET = "hunter2-token-xyz"
    const m = new McpConnectionManager()
    try {
      // A REAL child is spawned (node itself): it writes the secret to its
      // own stderr and exits 1 — spawn succeeds, MCP initialization fails.
      // This exercises the real-subprocess failure path the ENOENT case
      // cannot (no process was ever started there).
      await expect(
        m.acquire("it", "leaky-server", {
          transport: "stdio",
          command: process.execPath,
          args: [
            "-e",
            `process.stderr.write("boot failed token=${SECRET}\\n"); process.exit(1)`,
          ],
        }),
      ).rejects.toThrow('MCP server "leaky-server" failed to connect')

      // Everything the runtime/SDK log through the parent's console must
      // stay clean — the raw error (available on MCPConnection.error,
      // potentially embedding the child's output) may never be printed.
      const logged = capturedOutput([errSpy.mock.calls, warnSpy.mock.calls])
      expect(logged).not.toContain(SECRET)
      expect(console.error).toBe(errSpy)
    } finally {
      await m.closeAll()
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
