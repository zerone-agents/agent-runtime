import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DiagnosticsSink } from "@zerone-agent/agent-sdk"

/**
 * Issue #63 acceptance tests: the runtime-owned diagnostics sink threads one
 * instance — by identity — through every SDK boundary the runtime owns.
 *
 * Acceptance mapping:
 *  1. Registry-created Agents receive the same Runtime sink (logger identity).
 *  2. McpConnectionManager failure diagnostics enter the injected sink with
 *     sanitized fields and a raw-cause separation (REAL connectMCPServer).
 *  3. The cron service receives the same sink via createDefaultCronService.
 *  4. Subagent inheritance is an SDK #78 contract (construction-time sink is
 *     inherited by Task/MultiTask); the runtime's obligation — verified in
 *     test group 1 — is that root Agents carry the sink.
 *  5. Two Runtime instances with different sinks never cross channels.
 *  6. Engine-scoped QueryOverrides.logger semantics untouched (full suite).
 */

// createAgent is mocked to capture construction opts; connectMCPServer stays
// REAL so the MCP failure path exercises the actual SDK diagnostics contract.
vi.mock("@zerone-agent/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zerone-agent/agent-sdk")>()
  return {
    ...actual,
    createAgent: vi.fn(() => ({ close: async () => {} })),
  }
})

vi.mock("@zerone-agent/agent-sdk/cron/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zerone-agent/agent-sdk/cron/node")>()
  return {
    ...actual,
    // SYNC factory, matching the real SDK contract (runtime.ts consumes the
    // return value without awaiting it).
    createDefaultCronService: vi.fn(() => ({ stop: async () => {} })),
  }
})

// Avoid real filesystem skill scans during loadFromConfig.
vi.mock("../skills.js", () => ({
  scanSkills: vi.fn(async () => []),
  materializeSkills: vi.fn(async () => []),
  toSummaries: vi.fn(() => []),
}))

import { createAgent, createDiagnosticsSink } from "@zerone-agent/agent-sdk"
import { createDefaultCronService } from "@zerone-agent/agent-sdk/cron/node"
import { AgentRegistry } from "../registry.js"
import { McpConnectionManager, McpConnectionError } from "../mcp-connections.js"
import { createRuntime } from "../runtime.js"
import { createRuntimeDiagnosticsSink, toSdkLogLevel } from "../diagnostics.js"
import type { RuntimeConfig } from "../config.js"

interface CapturedCall {
  level: "debug" | "trace" | "warn" | "error"
  msg: string
  fields?: Record<string, unknown>
  cause?: unknown
}

/** Test double implementing the full DiagnosticsSink surface, recording calls. */
function captureSink(): DiagnosticsSink & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const record =
    (level: CapturedCall["level"]) =>
    (msg: string, fields?: Record<string, unknown>, cause?: unknown) => {
      calls.push({ level, msg, fields, cause })
    }
  // Explicit annotation breaks the self-referential inference through
  // `child: () => sink` (TS7022).
  const sink: DiagnosticsSink & { calls: CapturedCall[] } = {
    calls,
    debug: record("debug"),
    trace: record("trace"),
    warn: record("warn"),
    error: record("error"),
    child: () => sink, // identity child: captures never fork away
  }
  return sink
}

/** Last createAgent construction opts, guarded for noUncheckedIndexedAccess. */
function lastAgentOpts(): { logger?: unknown } {
  const calls = vi.mocked(createAgent).mock.calls
  const last = calls[calls.length - 1]
  if (!last) throw new Error("createAgent was not called")
  return last[0] as { logger?: unknown }
}

const BASE_AGENT = {
  id: "a1",
  description: "diagnostics test agent",
  model: "test-model",
  maxTurns: 2,
}

const BASE_CONFIG = (agents: Array<Record<string, unknown>> = [BASE_AGENT]): RuntimeConfig =>
  ({
    server: { host: "127.0.0.1", port: 3123 },
    agents,
  }) as unknown as RuntimeConfig

beforeEach(() => {
  vi.mocked(createAgent).mockClear()
  vi.mocked(createDefaultCronService).mockClear()
})

describe("createRuntimeDiagnosticsSink", () => {
  it("passes an injected sink through by identity", () => {
    const injected = captureSink()
    expect(createRuntimeDiagnosticsSink(BASE_CONFIG(), injected)).toBe(injected)
  })

  it("creates a console-backed default when nothing is injected", () => {
    const sink = createRuntimeDiagnosticsSink(BASE_CONFIG())
    for (const m of ["debug", "trace", "warn", "error"] as const) {
      expect(typeof sink[m]).toBe("function")
    }
  })

  it("maps runtime logging levels onto the SDK sink level", () => {
    expect(toSdkLogLevel("error")).toBe("error")
    expect(toSdkLogLevel("warn")).toBe("debug")
    expect(toSdkLogLevel("info")).toBe("debug")
    expect(toSdkLogLevel("debug")).toBe("debug")
    expect(toSdkLogLevel(undefined)).toBe("debug")
  })

  it("level mapping controls ACTUAL output: 'error' silences debug but warn always emits", async () => {
    // P2 review follow-up: assert real console behavior, not just the
    // mapping string. SDK contract: warn/error ALWAYS emit; the level only
    // gates debug/trace. So runtime logging.level: error → SDK debug output
    // is silenced, but SDK warnings still print.
    const { createDiagnosticsSink: realSink } = await import("@zerone-agent/agent-sdk")
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ]
    try {
      const sink = realSink({ level: "error" })
      sink.debug("silent-at-error-level")
      expect(spies.flatMap((s) => s.mock.calls)).toHaveLength(0)

      sink.warn("always-emits")
      const allWarnCalls = spies.flatMap((s) => s.mock.calls)
      expect(allWarnCalls.length).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(allWarnCalls)).toContain("always-emits")
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})

describe("acceptance 1 & 4: registry threads the sink into every root Agent", () => {
  it("create() passes the SAME sink instance as AgentOptions.logger (identity)", async () => {
    const sink = captureSink()
    const registry = new AgentRegistry(sink)
    await registry.loadFromConfig(BASE_CONFIG(), process.cwd())
    registry.create("a1")

    expect(createAgent).toHaveBeenCalledTimes(1)
    // Identity: the SDK adaptToDiagnosticsSink passes sink-shaped loggers
    // through unchanged, so provider/hooks/tools/MCP/skills and Task/MultiTask
    // subagents all inherit THIS instance (SDK #78 contract).
    expect(lastAgentOpts().logger).toBe(sink)
  })

  it("omits the logger key entirely when no sink is wired (SDK default path)", async () => {
    const registry = new AgentRegistry()
    await registry.loadFromConfig(BASE_CONFIG(), process.cwd())
    registry.create("a1")

    expect(Object.hasOwn(lastAgentOpts(), "logger")).toBe(false)
  })
})

describe("acceptance 2: MCP failure diagnostics enter the injected sink (real connectMCPServer)", () => {
  it("sanitized fields only; raw cause kept as an object, never in fields", async () => {
    const sink = captureSink()
    const manager = new McpConnectionManager(sink)

    await expect(
      manager.acquire("a1", "bad-server", {
        transport: "stdio",
        command: "definitely-does-not-exist-xyz",
      } as Record<string, unknown>),
    ).rejects.toThrow(McpConnectionError)

    const failures = sink.calls.filter((c) => c.level === "error")
    expect(failures.length).toBeGreaterThanOrEqual(1)

    for (const call of failures) {
      expect(call.msg).toContain("Failed to connect")
      // fields are the SDK's safe summary: server name (sanitizeLogField
      // JSON-escapes, so compare against the quoted form) + stable errorType.
      expect(call.fields).toBeDefined()
      expect(String(call.fields!.server)).toContain("bad-server")
      expect(typeof call.fields!.errorType).toBe("string")
      // Sanitization: the raw OS error text never enters msg or fields.
      const serialized = JSON.stringify({ m: call.msg, f: call.fields })
      expect(serialized).not.toContain("ENOENT")
      expect(serialized).not.toContain("definitely-does-not-exist-xyz")
      // Cause boundary: raw error object travels separately, controlled.
      expect(call.cause).toBeInstanceOf(Error)
    }
  })

  it("retry diagnostics (review follow-up): each retry warn reaches the sink before the final error", async () => {
    const sink = captureSink()
    const manager = new McpConnectionManager(sink)

    await expect(
      manager.acquire("a1", "flaky-server", {
        transport: "stdio",
        command: "definitely-does-not-exist-xyz",
        retryPolicy: { maxRetries: 1, timeoutMs: 1000 },
      } as Record<string, unknown>),
    ).rejects.toThrow(McpConnectionError)

    // Retry pass: one warn per intermediate failure, sanitized fields only.
    const retries = sink.calls.filter(
      (c) => c.level === "warn" && c.msg.includes("Retrying connection"),
    )
    expect(retries.length).toBe(1)
    expect(String(retries[0].fields?.server)).toContain("flaky-server")
    expect(retries[0].fields?.attempt).toBe(2) // attempt 2 of maxRetries+1
    const retryText = JSON.stringify({ m: retries[0].msg, f: retries[0].fields })
    expect(retryText).not.toContain("ENOENT")
    expect(retryText).not.toContain("definitely-does-not-exist-xyz")

    // Terminal failure still lands as the sanitized error with raw cause.
    const failures = sink.calls.filter(
      (c) => c.level === "error" && c.msg.includes("Failed to connect"),
    )
    expect(failures.length).toBe(1)
    expect(failures[0].cause).toBeInstanceOf(Error)
  })
})

describe("acceptance 3 & 5: composition root threads one sink; instances never cross", () => {
  const configDir = mkdtempSync(join(tmpdir(), "diag-runtime-"))

  it("createRuntime passes the SAME sink to cron and to Agents", async () => {
    const sink = captureSink()
    const config = {
      ...BASE_CONFIG(),
      cron: { enabled: true, dataRoot: ".zerone" },
    } as unknown as RuntimeConfig

    const host = await createRuntime(config, { configDir, diagnostics: sink })
    try {
      // Cron boundary: createDefaultCronService received the sink.
      expect(createDefaultCronService).toHaveBeenCalledTimes(1)
      const cronOpts = vi.mocked(createDefaultCronService).mock.calls[0][0] as {
        diagnostics?: unknown
      }
      expect(cronOpts.diagnostics).toBe(sink)

      // Agent boundary: same identity through the registry.
      host.agents.create("a1")
      expect(lastAgentOpts().logger).toBe(sink)
    } finally {
      await host.stop()
    }
  })

  it("two Runtime instances with different sinks stay isolated", async () => {
    const sinkA = captureSink()
    const sinkB = captureSink()
    const config = BASE_CONFIG()

    const hostA = await createRuntime(config, { configDir, diagnostics: sinkA })
    const hostB = await createRuntime(config, { configDir, diagnostics: sinkB })
    try {
      hostA.agents.create("a1")
      hostB.agents.create("a1")

      const [loggerA, loggerB] = vi
        .mocked(createAgent)
        .mock.calls.slice(-2)
        .map((c) => c[0]?.logger)
      // Identity, not structural equality: instance A's Agent got sinkA,
      // instance B's got sinkB — no crossover in either direction.
      expect(loggerA).toBe(sinkA)
      expect(loggerB).toBe(sinkB)
      expect(loggerA).not.toBe(loggerB)
    } finally {
      await hostA.stop()
      await hostB.stop()
    }
  })

  it("without an injected sink, the composition root still owns one default across all boundaries", async () => {
    // Issue #63: "避免各模块自行创建默认 sink" — even on the default path the
    // runtime resolves ONE console-backed sink at the composition root and
    // threads the same instance through cron AND Agents (level mapped from
    // config.logging.level), rather than letting each SDK boundary build its
    // own default. Cron must be enabled for the cron boundary to exist.
    const config = {
      ...BASE_CONFIG(),
      cron: { enabled: true, dataRoot: ".zerone" },
    } as unknown as RuntimeConfig
    const host = await createRuntime(config, { configDir })
    try {
      const cronOpts = vi.mocked(createDefaultCronService).mock.calls.at(-1)![0] as {
        diagnostics?: unknown
      }
      host.agents.create("a1")

      expect(cronOpts.diagnostics).toBeDefined()
      expect(lastAgentOpts().logger).toBe(cronOpts.diagnostics) // same default instance
    } finally {
      await host.stop()
    }
  })
})
