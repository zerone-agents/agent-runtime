// Real-connection smoke tests — NO SDK mock in this file (vi.mock is
// file-scoped, so keeping it here would be pointless; this is deliberately
// a separate file from the mocked unit/isolation suites).
//
// Exercises the actual SDK v3 connectMCPServer stdio path through the
// runtime-owned McpConnectionManager: spawn, initialize, tool
// materialization, and closeAll release.
import { describe, it, expect, vi } from "vitest"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { McpConnectionManager } from "../mcp-connections.js"
import { deepInspect, capturedOutput } from "./helpers/deep-log.js"

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

  it("real child stderr never reaches the terminal fd — end-to-end probe (#54 review r2)", async () => {
    const SECRET = "hunter2-token-xyz"
    const runner = fileURLToPath(
      new URL("../../test/fixtures/mcp-fd2-runner.mjs", import.meta.url),
    )
    // The runner performs a REAL acquisition of a server that prints the
    // secret to its own stderr, with the runner's stdio PIPED back here.
    // Inherited child stderr would surface in the captured pipe — console
    // spies cannot observe fd-2 writes, so this is the only honest check.
    const child = spawn(process.execPath, [runner], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => {
      out += d
    })
    child.stderr.on("data", (d) => {
      err += d
    })
    const code = await new Promise<number | null>((res) =>
      child.on("close", (c) => res(c)),
    )
    expect(code).toBe(0)
    expect(out).toContain("acquire rejected as expected")
    // The leaky child wrote its secret to ITS stderr; with the strict
    // stderr policy in place it must not surface anywhere in the runner's
    // observable output — captured stdout AND stderr join the assertion so
    // neither channel can hide the secret.
    expect(out + err).not.toContain(SECRET)
  }, 30_000)
})
