import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ShutdownGate, createShutdownGateMiddleware } from "../shutdown-gate.js"
import { createRuntime } from "../runtime.js"
import { loadYamlConfig } from "../config.js"

/** Real-timer microtask/macrotask flush — fake timers are NOT used here. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Manually-controlled latch promise (deferred) for holding handlers open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("ShutdownGate", () => {
  it("shuttingDown is false until begin()", () => {
    const gate = new ShutdownGate()
    expect(gate.shuttingDown).toBe(false)
    gate.begin()
    expect(gate.shuttingDown).toBe(true)
  })

  it("drained() resolves immediately when idle (no tracked mutations)", async () => {
    const gate = new ShutdownGate()
    gate.begin()
    let resolved = false
    gate.drained().then(() => {
      resolved = true
    })
    await flush()
    expect(resolved).toBe(true)
  })

  it("drained() stays pending after one leave() with two tracked mutations, resolves after the second", async () => {
    const gate = new ShutdownGate()
    gate.enter()
    gate.enter()
    gate.begin()
    let resolved = false
    gate.drained().then(() => {
      resolved = true
    })

    gate.leave()
    await flush()
    expect(resolved).toBe(false) // one mutation still in flight

    gate.leave()
    await flush()
    expect(resolved).toBe(true)
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

  it("after begin(): GET still passes and is NOT tracked (probes never block drain)", async () => {
    const gate = new ShutdownGate()
    const app = makeApp(gate)
    gate.begin()
    const res = await app.request("/v1/mutations")
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    // GET/HEAD never enter(): drained() settles immediately after the request.
    let drained = false
    gate.drained().then(() => {
      drained = true
    })
    await flush()
    expect(drained).toBe(true)
  })
})

describe("createShutdownGateMiddleware — held-request regression", () => {
  it("in-flight mutation past the gate holds drained(); NEW mutations get 503 while it is held", async () => {
    const gate = new ShutdownGate()
    const hold = deferred()
    const app = new Hono()
    app.use("*", createShutdownGateMiddleware(gate))
    app.post("/v1/held", async (c) => {
      await hold.promise // park in the handler, past the gate check
      return c.json({ ok: true }, 200)
    })

    // Fire the POST but do NOT await: it passes the gate before begin() and
    // parks inside the handler.
    let responseSettled = false
    const inFlight = Promise.resolve(app.request("/v1/held", { method: "POST" })).then((res) => {
      responseSettled = true
      return res
    })
    await flush() // let the middleware enter() + the handler park

    gate.begin()

    // The held request has not settled yet.
    expect(responseSettled).toBe(false)

    // NEW mutation after begin(): rejected immediately, while the old one is held.
    const rejected = await app.request("/v1/held", { method: "POST" })
    expect(rejected.status).toBe(503)
    expect(await rejected.json()).toEqual({ error: "Runtime is shutting down", code: "shutting_down" })
    expect(responseSettled).toBe(false) // old one STILL held

    // drained() must stay pending while the in-flight mutation is held —
    // this is the boundary host.stop() awaits before touching Run/Cron state.
    let drained = false
    gate.drained().then(() => {
      drained = true
    })
    await flush()
    expect(drained).toBe(false)

    // Release the held handler: the response settles AND drained() settles.
    hold.resolve()
    const res = await inFlight
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(responseSettled).toBe(true)
    await flush()
    expect(drained).toBe(true)
  })
})

describe("createRuntime integration", () => {
  it("host.stop() begins the gate synchronously: mutations during drain get 503 shutting_down", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "gate-host-"))
    writeFileSync(
      join(configDir, "agents.yaml"),
      "agents:\n  - id: assistant\n    description: test agent\n",
    )
    try {
      const config = loadYamlConfig(join(configDir, "agents.yaml"))
      const host = await createRuntime(config, { configDir })

      const post = () =>
        host.app.request("/v1/cron/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "n", cron: "0 18 * * *", prompt: "p", agentId: "assistant" }),
        })

      // BEFORE stop: the request reaches the cron router (cron disabled → 503 cron_disabled)
      const before = await post()
      expect(before.status).toBe(503)
      expect((await before.json()).code).toBe("cron_disabled")

      // stop() invoked but NOT awaited: begin() runs as the first synchronous
      // statement, so mutations arriving during drain are already rejected by
      // the gate, mounted ahead of the cron router.
      const stopPromise = host.stop()
      const after = await post()
      expect(after.status).toBe(503)
      expect((await after.json()).code).toBe("shutting_down")

      // GET probes remain served during drain
      const health = await host.app.request("/health")
      expect(health.status).toBe(200)

      // Cron-disabled host has nothing to drain: stop resolves.
      await stopPromise
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
