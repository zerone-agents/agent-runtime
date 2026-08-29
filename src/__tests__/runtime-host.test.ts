import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime, resolveCronDataRoot } from "../runtime.js"
import type { RuntimeConfig } from "../config.js"

function writeConfigDir(enabled: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "cron-host-"))
  writeFileSync(
    join(dir, "agents.yaml"),
    [
      `cron:`,
      `  enabled: ${enabled}`,
      `  dataRoot: cron-data`,
      `agents:`,
      `  - id: assistant`,
      `    description: test agent`,
      ``,
    ].join("\n"),
  )
  return dir
}

const minimalConfig = (extra: Record<string, unknown> = {}): RuntimeConfig =>
  RuntimeConfigSchema_parse({ agents: [{ id: "assistant", description: "d" }], ...extra })

// local import alias to keep the snippet self-contained
import { RuntimeConfigSchema } from "../config.js"
const RuntimeConfigSchema_parse = RuntimeConfigSchema.parse.bind(RuntimeConfigSchema)

describe("resolveCronDataRoot", () => {
  it("resolves relative dataRoot against configDir", () => {
    expect(resolveCronDataRoot(minimalConfig(), "/cfg/dir")).toBe("/cfg/dir/.zerone")
    expect(
      resolveCronDataRoot(minimalConfig({ cron: { enabled: true, dataRoot: "var/x" } }), "/cfg/dir"),
    ).toBe("/cfg/dir/var/x")
  })

  it("keeps absolute dataRoot as-is", () => {
    expect(
      resolveCronDataRoot(minimalConfig({ cron: { enabled: true, dataRoot: "/abs" } }), "/cfg/dir"),
    ).toBe("/abs")
  })
})

describe("createRuntime lifecycle", () => {
  it("cron disabled: no service, no injection, status endpoint reports disabled", async () => {
    const configDir = writeConfigDir(false)
    try {
      const { loadYamlConfig } = await import("../config.js")
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      expect(host.cron).toBeUndefined()

      const spy = vi.spyOn(host.agents, "resolveOptions")
      await host.agents.resolveOptions("assistant")
      expect((await spy.mock.results[0].value).cronService).toBeUndefined()
      spy.mockRestore()

      const res = await host.app.request("/v1/cron/status")
      expect(res.status).toBe(200)
      expect((await res.json()).enabled).toBe(false)

      await host.stop()
      await host.stop() // idempotent
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("cron enabled: service created with resolved dataRoot, started before start() resolves, registry injected", async () => {
    const configDir = writeConfigDir(true)
    try {
      const { loadYamlConfig } = await import("../config.js")
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      expect(host.cron).toBeDefined()

      // lock + dir exist only after start()
      const dataRoot = resolveCronDataRoot(config, configDir)
      expect(existsSync(join(dataRoot, "cron"))).toBe(false)
      await host.start()
      expect(existsSync(join(dataRoot, "cron", "runtime.lock"))).toBe(true)

      // same instance injected into agent opts
      const opts = await host.agents.resolveOptions("assistant")
      expect(opts?.cronService).toBe(host.cron)

      // HTTP create requires the shared service; use it to verify end-to-end
      const res = await host.app.request("/v1/cron/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "n", cron: "0 18 * * *", prompt: "p", agentId: "assistant" }),
      })
      expect(res.status).toBe(201)
      const task = await res.json()
      expect(task.agentId).toBe("assistant")

      await host.stop()
      expect(existsSync(join(dataRoot, "cron", "runtime.lock"))).toBe(false)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("stop() drains runs and cron, then closes the registry — once", async () => {
    const configDir = writeConfigDir(true)
    try {
      const { loadYamlConfig } = await import("../config.js")
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      await host.start()

      const runsSeal = vi.spyOn(host.runs, "sealAndCancel")
      const agentsClose = vi.spyOn(host.agents, "closeAll")
      await host.stop()
      await host.stop()
      expect(runsSeal).toHaveBeenCalledTimes(1) // stop() phases: seal once, never legacy closeAll
      expect(agentsClose).toHaveBeenCalledTimes(1)
      runsSeal.mockRestore()
      agentsClose.mockRestore()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("Cron stop begins without waiting for Run cleanup (concurrent phase 4)", async () => {
    const configDir = writeConfigDir(true)
    try {
      const { loadYamlConfig } = await import("../config.js")
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      await host.start()

      // Manually-controlled run cleanup: models a stuck agent.close().
      let releaseCleanup!: () => void
      const cleanupPending = new Promise<void>((r) => {
        releaseCleanup = r
      })
      const finishSpy = vi
        .spyOn(host.runs, "finishCleanup")
        .mockReturnValue(cleanupPending)
      const cronStopSpy = vi
        .spyOn(host.cron!, "stop")
        .mockImplementation(async () => {})

      let stopped = false
      const stopPromise = host.stop().then(() => {
        stopped = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))

      // cron.stop was invoked while Run cleanup is still pending — a stuck
      // cleanup must not delay Cron drain or lock release (issue #21).
      expect(cronStopSpy).toHaveBeenCalledTimes(1)
      expect(stopped).toBe(false)

      releaseCleanup()
      await stopPromise
      expect(stopped).toBe(true)

      finishSpy.mockRestore()
      cronStopSpy.mockRestore()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("startup failure (locked dir) rejects and leaves no half-initialized host serving cron", async () => {
    const configDir = writeConfigDir(true)
    try {
      const { loadYamlConfig } = await import("../config.js")
      const config = loadYamlConfig(join(configDir, "agents.yaml"))

      // First host holds the lock
      const first = await createRuntime(config, { configDir })
      await first.start()

      const second = await createRuntime(config, { configDir })
      await expect(second.start()).rejects.toThrow()
      await first.stop()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("stop() suspends Cron scheduling at shutdown start, before cron.stop() drains it", async () => {
    const configDir = writeConfigDir(true)
    try {
      const { loadYamlConfig } = await import("../config.js")
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      await host.start()

      // Call-through spies: exercise the real suspend/stop while recording
      // the invocation order.
      const order: string[] = []
      const suspendOrig = host.cron!.suspend.bind(host.cron!)
      const stopOrig = host.cron!.stop.bind(host.cron!)
      const suspendSpy = vi
        .spyOn(host.cron!, "suspend")
        .mockImplementation(async () => {
          order.push("suspend")
          await suspendOrig()
        })
      const stopSpy = vi
        .spyOn(host.cron!, "stop")
        .mockImplementation(async (options?: { drainMs?: number }) => {
          order.push("stop")
          await stopOrig(options)
        })

      await host.stop()

      expect(suspendSpy).toHaveBeenCalledTimes(1)
      expect(stopSpy).toHaveBeenCalledTimes(1)
      // Suspend must happen BEFORE the drain/stop: the SDK Scheduler keeps
      // firing until suspend() runs, so it must run at shutdown start, ahead
      // of the mutation-drain barrier.
      expect(order.indexOf("suspend")).toBeLessThan(order.indexOf("stop"))
      expect(order).toEqual(["suspend", "stop"])

      suspendSpy.mockRestore()
      stopSpy.mockRestore()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
