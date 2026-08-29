import { Hono } from "hono"
import { resolve } from "node:path"
import { createDefaultCronService } from "@zerone-agent/agent-sdk/cron/node"
import type { RuntimeConfig } from "./config.js"
import { AgentRegistry } from "./registry.js"
import { RunRegistry } from "./runs.js"
import { MetricsCollector } from "./metrics.js"
import { createApp } from "./router/index.js"
import { RuntimeCronService } from "./cron-service.js"
import {
  disabledCronStatus, newRuntimeId, pathIdentity, type CronStatusPayload,
} from "./cron-identity.js"
import { ShutdownGate } from "./shutdown-gate.js"
import type { AigcRunRecord } from "./audit-log.js"

export interface AgentRuntimeHost {
  app: Hono
  agents: AgentRegistry
  runs: RunRegistry
  /** Present only when cron.enabled — the single shared service for Tool/HTTP/CLI. */
  cron?: RuntimeCronService
  start(): Promise<void>
  stop(): Promise<void>
}

export interface CreateRuntimeOptions {
  /** Directory of agents.yaml / agent.config.ts — anchors relative dataRoot. */
  configDir: string
  onAigcRecord?: (record: AigcRunRecord) => void | Promise<void>
}

/** dataRoot resolves against configDir (never CWD); SDK appends the single /cron segment. */
export function resolveCronDataRoot(config: RuntimeConfig, configDir: string): string {
  return resolve(configDir, config.cron?.dataRoot ?? ".zerone")
}

export async function createRuntime(
  config: RuntimeConfig,
  options: CreateRuntimeOptions,
): Promise<AgentRuntimeHost> {
  const { configDir } = options

  // 1-2. Load + validate config (caller), then AgentRegistry.
  const agents = new AgentRegistry()
  await agents.loadFromConfig(config, configDir)

  // 3. RunRegistry.
  const runs = new RunRegistry()
  const metrics = new MetricsCollector()

  // Instance identity (diagnostics only — never a credential).
  const runtimeId = newRuntimeId()
  const configId = pathIdentity(configDir)
  const dataRoot = resolveCronDataRoot(config, configDir)
  const dataId = pathIdentity(dataRoot)

  // Rejects new mutations on already-accepted connections during shutdown drain.
  const shutdownGate = new ShutdownGate()

  // 4. Optional cron service, wrapped with the Runtime agent policy.
  let cron: RuntimeCronService | undefined
  if (config.cron?.enabled) {
    const sdkService = createDefaultCronService({
      dataDir: dataRoot,
      executionTimeoutMs: config.cron.executionTimeoutMs,
      resolveAgent: async (agentId) => {
        // Called on EVERY fire: latest config, same shared service, no reuse
        // of HTTP-run agents or sessions.
        const opts = await agents.resolveOptions(agentId ?? "", { cronService: cron })
        if (!opts) {
          throw new Error(
            `Cron agent resolution failed: agent "${agentId ?? ""}" not found or unavailable`,
          )
        }
        return opts
      },
    })
    cron = new RuntimeCronService(sdkService, agents)
    agents.setCronService(cron)
  }

  let running = false

  const getStatus = async (): Promise<CronStatusPayload> => {
    if (!cron) return disabledCronStatus(runtimeId, configId, dataId)
    const [tasks, executions] = await Promise.all([cron.list(), cron.listExecutions()])
    return {
      enabled: true,
      running,
      runtimeId,
      configId,
      dataId,
      taskCount: tasks.length,
      activeExecutionCount: executions.filter((e) => e.status === "pending" || e.status === "running").length,
    }
  }

  // 5. Hono app with the SAME service instance mounted on /v1/cron.
  const app = createApp(config, agents, metrics, {
    onAigcRecord: options.onAigcRecord,
    runsRegistry: runs,
    cron: { cron, getStatus },
    shutdownGate,
  })

  let started = false
  let stopPromise: Promise<void> | undefined

  const host: AgentRuntimeHost = {
    app,
    agents,
    runs,
    ...(cron ? { cron } : {}),
    async start() {
      if (started) return
      // 6. Directory lock, execution recovery, scheduler init. Failure here
      // propagates: no "healthy but not scheduling" runtime.
      if (cron) {
        await cron.start()
        running = true
      }
      started = true
    },
    async stop() {
      if (!stopPromise) {
        stopPromise = (async () => {
          // Phase 1 (synchronous): reject new mutations. All shutdown paths
          // (signals, programmatic, orchestrators) converge here (issue #21).
          // Outer server owners may still close their listener first — this gate
          // is independent of socket state.
          shutdownGate.begin()
          // Phase 2: cancel REGISTERED runs first — a blocking JSON run request is
          // itself a tracked mutation, so run cancellation must not wait behind the
          // drain of the very request it unblocks. Late registrations (requests that
          // passed the gate before begin() but had not registered a run yet) fail
          // fast against the closed registry.
          await runs.closeAll()
          // Phase 3: wait for in-flight mutations to finish (now unblocked).
          await shutdownGate.drained()
          // Phase 4: Cron drain + lock release only after mutations quiesced.
          if (cron) {
            await cron.stop({ drainMs: config.cron?.drainMs })
            running = false
          }
          // Phase 5: registry cleanup.
          await agents.closeAll()
        })()
      }
      return stopPromise
    },
  }
  return host
}
