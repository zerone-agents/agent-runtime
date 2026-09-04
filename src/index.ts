#!/usr/bin/env node
export { createApp } from "./router/index.js"
export type { CreateAppOptions } from "./router/index.js"
export { AgentRegistry, type AgentInfo, type AgentDetail } from "./registry.js"
export { RunRegistry, RunIdConflictError, RunRegistryClosedError, type RunState, type TerminalState, type CancelReason, type TerminalReason, type RunRecord, type TerminalEntry, type RunInfo, type RunRegistryOptions } from "./runs.js"
export { scanSkills, type SkillSummary } from "./skills.js"
export { MetricsCollector, type AgentMetrics, type RuntimeMetrics } from "./metrics.js"
export { streamAgentResponse } from "./sse.js"
export type { StreamOptions } from "./sse.js"
export {
  buildAigcLabel,
  generateProduceId,
  resolveContentProducer,
  resolveAigcConfig,
  signLabel,
  type AigcLabel,
  type AigcConfig,
} from "./aigc.js"
export { AigcAuditLog, type AigcRunRecord, type AigcAuditLogOptions } from "./audit-log.js"
export {
  discoverConfig,
  findConfigDir,
  loadYamlConfig,
  defineConfig,
  resolveSystemPrompt,
  formatDatasets,
  RuntimeConfigSchema,
  type RuntimeConfig,
  type AgentDefinition,
} from "./config.js"
export { RuntimeCronService, CronApiError, type CronErrorCode } from "./cron-service.js"
export {
  pathIdentity, sha256Hex, newRuntimeId, disabledCronStatus,
  type CronStatusPayload,
} from "./cron-identity.js"
export {
  createRuntime, resolveCronDataRoot,
  type AgentRuntimeHost, type CreateRuntimeOptions,
} from "./runtime.js"
export type { DiagnosticsSink } from "./diagnostics.js"
export { ShutdownGate, createShutdownGateMiddleware } from "./shutdown-gate.js"
export { runCli, CLI_EXIT, buildShutdown, closeHttpServer } from "./cli.js"
export { CronConfigSchema, type CronConfig } from "./config.js"

if (import.meta.filename === process.argv[1]) {
  const { runCli } = await import("./cli.js")
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code)
  }, (err) => {
    console.error("Failed to start:", err.message)
    process.exit(1)
  })
}
