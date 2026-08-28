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

      const runsClose = vi.spyOn(host.runs, "closeAll")
      const agentsClose = vi.spyOn(host.agents, "closeAll")
      await host.stop()
      await host.stop()
      expect(runsClose).toHaveBeenCalledTimes(1)
      expect(agentsClose).toHaveBeenCalledTimes(1)
      runsClose.mockRestore()
      agentsClose.mockRestore()
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
})
