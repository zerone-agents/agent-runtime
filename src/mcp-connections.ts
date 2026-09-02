/**
 * Runtime-owned MCP connection manager (issue #47 §3).
 *
 * SDK v3 exposes `connectMCPServer` but no pooled acquire API (the internal
 * pool is module-private), so the runtime manages connection reuse itself:
 * connections are deduped by a stable config key (server name + canonical
 * config with sorted keys), shared across agent entries that declare the
 * same connection, and released exactly once via closeAll() on startup
 * rollback / shutdown. Tool visibility remains per-agent: each entry's
 * capabilities receive the shared connection's tools independently.
 *
 * MCP failure logging is SDK-owned since @zerone-agent/agent-sdk 3.0.2
 * (issue #51): connectMCPServer() logs only sanitized structured fields
 * (server name + stable errorType) and never the raw Error.message, so the
 * runtime does NOT intercept the process-global console. The full raw error
 * still travels on MCPConnection.error for runtime-side diagnostics.
 */

import { connectMCPServer, type MCPConnection } from "@zerone-agent/agent-sdk"

/**
 * Canonicalize the transport selector spelling: the SDK accepts both `type`
 * and `transport`, we normalize to the canonical `type` form so that both
 * spellings of the same config dedupe to one connection.
 */
export function canonicalMcpConfig(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const { transport, ...rest } = cfg
  return transport !== undefined ? { ...rest, type: transport } : rest
}

/** Deterministic stringify: sorted keys so field order never splits a shared connection. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

/**
 * Sanitized failure: NEVER carries the SDK/raw error text (it may embed
 * command lines, URLs, or credentials). Only the server name is echoed.
 *
 * NOTE: no constructor parameter properties — this module is imported by
 * test/fixtures/mcp-fd2-runner.mjs via Node's native type stripping,
 * which supports erasable syntax only.
 */
export class McpConnectionError extends Error {
  readonly serverName: string
  constructor(serverName: string) {
    super(`MCP server "${serverName}" failed to connect`)
    this.name = "McpConnectionError"
    this.serverName = serverName
  }
}

/**
 * Wrap stdio server configs so the spawned server's stderr cannot leak
 * into the runtime's terminal (#54 review r2): SDK 3.0.2 exposes no
 * stderr option and the MCP transport defaults to `inherit`, so the child
 * writes straight to the runtime's fd 2 — bypassing every JS-level
 * sanitizer (console spies cannot even observe it). Routing the spawn
 * through `/bin/sh -c 'exec "$0" "$@" 2>/dev/null'` redirects the child's
 * fd 2 at the OS level; `exec` replaces the shell, so stdin/stdout pipes,
 * signals, exit codes, and env/cwd semantics are unchanged. POSIX-only
 * (the supported deployment targets). Operators debugging a broken server
 * can opt out per-process with ZERONE_MCP_STDERR_PASSTHROUGH=1.
 */
const STDERR_DISCARD_SCRIPT = 'exec "$0" "$@" 2>/dev/null'

function wrapStdioStderr(config: Record<string, unknown>): Record<string, unknown> {
  if (process.env.ZERONE_MCP_STDERR_PASSTHROUGH === "1") return config
  if (config.type !== "stdio") return config
  const args = Array.isArray(config.args) ? (config.args as unknown[]).map(String) : []
  return {
    ...config,
    command: "/bin/sh",
    args: ["-c", STDERR_DISCARD_SCRIPT, String(config.command), ...args],
  }
}

interface ManagedConnection {
  conn: MCPConnection
  refs: Set<string>
}

export class McpConnectionManager {
  private byKey = new Map<string, ManagedConnection>()

  /**
   * Acquire (or share) a connection for one agent entry's server config.
   * Throws McpConnectionError with a sanitized message when the connection
   * is (or previously was) in error state — failed connections are cached
   * so a dead server is not re-attempted per entry during one load pass.
   */
  async acquire(
    entryId: string,
    name: string,
    rawConfig: Record<string, unknown>,
  ): Promise<MCPConnection> {
    const config = canonicalMcpConfig(rawConfig)
    const key = JSON.stringify([name, sortKeys(config)])
    const existing = this.byKey.get(key)
    if (existing) {
      existing.refs.add(entryId)
      if (existing.conn.status === "connected") return existing.conn
      throw new McpConnectionError(name)
    }
    // Wrap AFTER the key is computed: sharing keys are derived from the
    // canonical (user-authored) config, so toggling the passthrough hatch
    // never splits a shared connection.
    const conn = await connectMCPServer(name, wrapStdioStderr(config) as never)
    this.byKey.set(key, { conn, refs: new Set([entryId]) })
    if (conn.status !== "connected") throw new McpConnectionError(name)
    return conn
  }

  /** Per-entry view for the detail endpoint (names + status only, no config). */
  describe(entryId: string): Array<{ name: string; status: string; shared: boolean }> {
    return [...this.byKey.values()]
      .filter((m) => m.refs.has(entryId))
      .map((m) => ({
        name: m.conn.name,
        status: m.conn.status,
        shared: m.refs.size > 1,
      }))
  }

  /**
   * Roll back one entry's references (review finding: a partially failed
   * materialization must not leave exclusive connections open until
   * shutdown). Zero-ref CONNECTED connections are closed and dropped;
   * zero-ref ERROR connections stay cached — they hold no live resources
   * and keep failure shared, so N entries pointing at a dead server do not
   * retry N times.
   */
  async release(entryId: string): Promise<void> {
    const toClose: MCPConnection[] = []
    for (const [key, m] of this.byKey) {
      if (!m.refs.delete(entryId)) continue
      if (m.refs.size === 0 && m.conn.status === "connected") {
        toClose.push(m.conn)
        this.byKey.delete(key)
      }
    }
    await Promise.all(
      toClose.map(async (conn) => {
        try {
          await conn.close()
        } catch {
          // Best-effort release: never block teardown.
        }
      }),
    )
  }

  /** Release every managed connection exactly once; idempotent and best-effort. */
  async closeAll(): Promise<void> {
    const all = [...this.byKey.values()]
    this.byKey.clear()
    await Promise.all(
      all.map(async (m) => {
        try {
          await m.conn.close()
        } catch {
          // Best-effort release during shutdown: never block teardown.
        }
      }),
    )
  }
}
