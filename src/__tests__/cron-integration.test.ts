import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime, resolveCronDataRoot } from "../runtime.js"
import { loadYamlConfig } from "../config.js"

function writeConfig(enabled: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "cron-e2e-"))
  writeFileSync(
    join(dir, "agents.yaml"),
    [
      ...(enabled ? ["cron:", "  enabled: true", "  dataRoot: .zerone"] : []),
      "agents:",
      "  - id: assistant",
      "    description: test agent",
      "",
    ].join("\n"),
  )
  return dir
}

const json = (body: unknown) => ({ "content-type": "application/json", body: JSON.stringify(body) })

describe("cross-entry cron integration", () => {
  it("disabled runtime never touches the cron data dir", async () => {
    const configDir = writeConfig(false)
    try {
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      await host.start()
      const dataRoot = resolveCronDataRoot(config, configDir)
      expect(existsSync(dataRoot)).toBe(false)
      const res = await host.app.request("/v1/cron/tasks")
      expect(res.status).toBe(503)
      await host.stop()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("tasks persist across host restart and the lock is released", async () => {
    const configDir = writeConfig(true)
    try {
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const dataRoot = resolveCronDataRoot(config, configDir)

      const first = await createRuntime(config, { configDir })
      await first.start()
      const created = await first.app.request("/v1/cron/tasks", {
        method: "POST", ...json({ name: "persisted", cron: "0 18 * * *", prompt: "p", agentId: "assistant" }),
      })
      expect(created.status).toBe(201)
      const task = await created.json()
      await first.stop()

      // restart on the same dataRoot: task survives, lock re-acquirable
      const second = await createRuntime(config, { configDir })
      await second.start()
      const listed = await (await second.app.request("/v1/cron/tasks")).json()
      expect(listed.total).toBe(1)
      expect(listed.items[0].id).toBe(task.id)

      // deletion via the second host stops it scheduling (file removed)
      expect((await second.app.request(`/v1/cron/tasks/${task.id}`, { method: "DELETE" })).status).toBe(204)
      const after = await (await second.app.request("/v1/cron/tasks")).json()
      expect(after.total).toBe(0)
      await second.stop()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it("enqueueNow run persists a manual execution visible in history", async () => {
    const configDir = writeConfig(true)
    try {
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      await host.start()

      const created = await first_task(host.app)
      const run = await host.app.request(`/v1/cron/tasks/${created.id}/run`, { method: "POST" })
      expect(run.status).toBe(202)
      const { executionId, status } = await run.json()
      expect(status).toBe("pending") // claim durable; agent runs in background (will fail: no provider, recorded as terminal state)

      // history projection shows the manual execution
      const history = await (await host.app.request("/v1/cron/executions?trigger=manual")).json()
      expect(history.total).toBeGreaterThanOrEqual(1)
      expect(history.items.some((e: { id: string }) => e.id === executionId)).toBe(true)

      await host.stop()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

async function first_task(app: HonoRequest): Promise<{ id: string }> {
  const res = await app.request("/v1/cron/tasks", {
    method: "POST", ...json({ name: "run-me", cron: "0 18 * * *", prompt: "p", agentId: "assistant" }),
  })
  expect(res.status).toBe(201)
  return res.json()
}
type HonoRequest = { request: (path: string, init?: RequestInit) => Response | Promise<Response> }
