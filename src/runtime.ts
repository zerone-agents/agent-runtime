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

  // 1-2. Load + validate config (caller), then AgentRegistry. loadFromConfig
  // materializes per-agent MCP connections (issue #47) — everything below
  // that can fail must roll them back.
  const agents = new AgentRegistry()
  await agents.loadFromConfig(config, configDir)

  try {
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
        try {
          // 6. Directory lock, execution recovery, scheduler init. Failure here
          // propagates: no "healthy but not scheduling" runtime.
          if (cron) {
            await cron.start()
            running = true
          }
          started = true
        } catch (err) {
          // Startup rollback (#47 §3): release materialized MCP connections
          // before the failure reaches the caller.
          await agents.closeAll()
          throw err
        }
      },
      async stop() {
        if (!stopPromise) {
          stopPromise = (async () => {
            // Phase 1 (synchronous): reject new mutations.
            shutdownGate.begin()
            // Phase 2: seal + cancel registered runs — fast, never awaits
            // Agent cleanup and never gates behind any Cron operation. A
            // blocking JSON run request is itself a tracked mutation, so its
            // cancellation must not wait behind anything. Late registrations
            // fail fast (RunRegistryClosedError → 503 shutting_down).
            runs.sealAndCancel()
            // Phase 3: START the single Cron shutdown immediately — firing,
            // not awaited. Issue #21: stop({ drainMs }) owns 停止领取/drain/
            // 中断剩余执行/释放锁 as one indivisible SDK operation, and its
            // stop-claiming must not sit behind the mutation drain: a slow or
            // hung tracked mutation would otherwise let the Scheduler keep
            // claiming new executions with drainMs not yet started and the
            // directory lock never entering release. (suspend() is the wrong
            // capability — it aborts active executions immediately.)
            const cronStop = cron
              ? cron.stop({ drainMs: config.cron?.drainMs }).then(() => {
                running = false
              })
              : undefined
            // Observe a rejection IMMEDIATELY: the Promise.all below attaches
            // its handler only after the mutation drain resolves — a fast
            // cron.stop() rejection while the gate is held would otherwise sit
            // unhandled for that whole window, and Node terminates the process
            // on unhandled rejections (before orderly cleanup can run). The
            // catch marks the rejection as observed; the ORIGINAL outcome is
            // preserved — Promise.all still rejects with the real error later.
            cronStop?.catch(() => {})
            // Phase 4: wait for in-flight mutations to finish (unblocked by the
            // run cancellation above). Cron shutdown is already in flight and
            // bounded by drainMs, independent of how long this takes.
            await shutdownGate.drained()
            // Phase 5: Run cleanup joins the already-running Cron shutdown.
            await Promise.all([runs.finishCleanup(), ...(cronStop ? [cronStop] : [])])
            // Phase 6: registry cleanup — releases runtime-owned MCP
            // connections (#47 §3).
            await agents.closeAll()
          })()
        }
        return stopPromise
      },
    }
    return host
  } catch (err) {
    // Startup rollback (#47 §3): any construction failure after
    // loadFromConfig must release the materialized MCP connections.
    await agents.closeAll()
    throw err
  }
}
