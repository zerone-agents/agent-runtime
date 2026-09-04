import { createDiagnosticsSink, type DiagnosticsSink } from "@zerone-agent/agent-sdk"
import type { RuntimeConfig } from "./config.js"

export type { DiagnosticsSink }

/**
 * Runtime-owned diagnostics ownership boundary (issue #63).
 *
 * One sink instance per Runtime, created at the composition root
 * (`createRuntime`) and threaded — by identity, never via `child()` — through
 * every SDK boundary the runtime owns:
 *
 *   1. `AgentOptions.logger` on every root Agent the registry creates. The
 *      SDK carries this construction-time sink through provider/hooks/
 *      snapshot/tools/MCP/skills, and Task/MultiTask inherit it into
 *      subagents (SDK #78 contract) — so nothing silently falls back to an
 *      independent console sink.
 *   2. `connectMCPServer(name, config, signal, diagnostics)` in
 *      McpConnectionManager — covers registry load/startup materialization.
 *   3. `createDefaultCronService({ diagnostics })` — takes precedence over
 *      the legacy `onDiagnostic` per the SDK contract; the runtime sets no
 *      competing handler.
 *
 * Contract (issue #63 §2):
 * - Instance-scoped: no process-global mutable sink state, no monkey-patched
 *   `console.*`. Two Runtime instances each own their sink with no crossover.
 * - `msg` and `fields` flow into the runtime's structured diagnostics output
 *   (console-backed by default; embedders may inject their own sink).
 * - `cause` is the RAW error for the runtime's own controlled consumption.
 *   It is never printed or serialized by default — safe summaries live in
 *   `fields`, which the SDK keeps sanitized (stable errorType + server name,
 *   never raw Error.message).
 * - The pre-existing engine-scoped `QueryOverrides.logger` semantics are
 *   untouched: it overrides a single query's engine/tool-executor output and
 *   never re-binds this construction-time sink (SDK #78 R5).
 */

/** Runtime logging levels from agents.yaml (`logging.level`). */
type RuntimeLogLevel = NonNullable<RuntimeConfig["logging"]>["level"]

/** SDK LogLevel (utils/logger.js): 'error' | 'debug' | 'trace'. */
type SdkLogLevel = "error" | "debug" | "trace"

/**
 * Map the runtime's `logging.level` onto the SDK sink level.
 *
 * The SDK levels are 'error' (errors only), 'debug' (default: errors plus
 * regular diagnostics), 'trace' (verbose engine/tool detail). The runtime's
 * fine-grained info/warn levels have no SDK counterpart and map to 'debug';
 * 'trace' is intentionally not reachable from agents.yaml — it stays an
 * SDK-internal verbosity tier.
 */
export function toSdkLogLevel(level: RuntimeLogLevel | undefined): SdkLogLevel {
  return level === "error" ? "error" : "debug"
}

/**
 * Resolve the Runtime's diagnostics sink.
 *
 * An injected sink (tests, embedders like agent-deployer) passes through by
 * identity. Otherwise a console-backed SDK default sink is created with the
 * level mapped from `config.logging.level`.
 */
export function createRuntimeDiagnosticsSink(
  config: RuntimeConfig,
  injected?: DiagnosticsSink,
): DiagnosticsSink {
  if (injected) return injected
  return createDiagnosticsSink({ level: toSdkLogLevel(config.logging?.level) })
}
