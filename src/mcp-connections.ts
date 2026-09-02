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
 */
export class McpConnectionError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP server "${serverName}" failed to connect`)
    this.name = "McpConnectionError"
  }
}

interface ManagedConnection {
  conn: MCPConnection
  refs: Set<string>
}

/**
 * Scoped suppression of the SDK client's raw `[MCP] ...` console.error
 * lines (sdk mcp/client.ts prints the underlying error text — potentially
 * URLs, commands, or credentials — BEFORE the runtime can wrap it, so the
 * runtime's sanitized message alone cannot keep logs clean). We drop those
 * lines during the connect window; the runtime re-emits its own sanitized
 * failure. Other console.error output passes through untouched. Assumes
 * connects are not concurrent (the registry loads entries sequentially);
 * the conditional restore keeps an overlapping window from unwinding the
 * wrong filter.
 */
function withSdkMcpLogSuppression<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error
  const filtered = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[MCP]")) return
    original(...args)
  }
  console.error = filtered as typeof console.error
  return fn().finally(() => {
    if (console.error === filtered) console.error = original
  })
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
    const conn = await withSdkMcpLogSuppression(() =>
      connectMCPServer(name, config as never),
    )
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
