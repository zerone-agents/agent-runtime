import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ShutdownGate, createShutdownGateMiddleware } from "../shutdown-gate.js"
import { createRuntime } from "../runtime.js"
import { loadYamlConfig } from "../config.js"

describe("ShutdownGate", () => {
  it("shuttingDown is false until begin()", () => {
    const gate = new ShutdownGate()
    expect(gate.shuttingDown).toBe(false)
    gate.begin()
    expect(gate.shuttingDown).toBe(true)
  })
})

describe("createShutdownGateMiddleware (unit)", () => {
  function makeApp(gate: ShutdownGate) {
    const app = new Hono()
    app.use("/v1/*", createShutdownGateMiddleware(gate))
    app.post("/v1/mutations", (c) => c.json({ ok: true }, 200))
    app.get("/v1/mutations", (c) => c.json({ ok: true }, 200))
    return app
  }

  it("POST passes through before begin()", async () => {
    const res = await makeApp(new ShutdownGate()).request("/v1/mutations", { method: "POST" })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("after begin(): POST is rejected with 503 shutting_down", async () => {
    const gate = new ShutdownGate()
    const app = makeApp(gate)
    gate.begin()
    const res = await app.request("/v1/mutations", { method: "POST" })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "Runtime is shutting down", code: "shutting_down" })
  })

  it("after begin(): GET still passes so probes stay truthful", async () => {
    const gate = new ShutdownGate()
    const app = makeApp(gate)
    gate.begin()
    const res = await app.request("/v1/mutations")
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

describe("createRuntime integration", () => {
  it("host.quiesce() gates mutations ahead of the cron router", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "gate-host-"))
    writeFileSync(
      join(configDir, "agents.yaml"),
      "agents:\n  - id: assistant\n    description: test agent\n",
    )
    try {
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })
      expect(typeof host.quiesce).toBe("function")

      const post = () =>
        host.app.request("/v1/cron/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "n", cron: "0 18 * * *", prompt: "p", agentId: "assistant" }),
        })

      // BEFORE quiesce: the request reaches the cron router (cron disabled → 503 cron_disabled)
      const before = await post()
      expect(before.status).toBe(503)
      expect((await before.json()).code).toBe("cron_disabled")

      // AFTER quiesce: the SAME request is rejected by the gate, mounted ahead
      // of the cron router — code proves middleware ordering.
      host.quiesce()
      const after = await post()
      expect(after.status).toBe(503)
      expect((await after.json()).code).toBe("shutting_down")

      // GET probes remain served during drain
      const health = await host.app.request("/health")
      expect(health.status).toBe(200)

      await host.stop()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
