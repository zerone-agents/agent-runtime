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

describe("createShutdownGateMiddleware — phased stop order (deadlock regression)", () => {
  it("cancellation-first stop order unblocks a blocked tracked mutation (deadlock regression)", async () => {
    const gate = new ShutdownGate()
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const runsFake = {
      // Cancellation is what unblocks the blocked run handler (models
      // RunRegistry.cancel → agent abort): no external/manual release.
      sealAndCancel() { release() },
      finishCleanup() { return Promise.resolve() },
    }
    const app = new Hono()
    app.use("*", createShutdownGateMiddleware(gate))
    app.post("/run", (c) => blocked.then(() => c.json({ done: true })))

    const request = app.request("/run", { method: "POST" })
    await new Promise((r) => setTimeout(r, 0)) // let it enter the middleware + handler

    // Mirror of AgentRuntimeHost.stop() phase order (1-4):
    let completed = false
    const stopP = (async () => {
      gate.begin()
      runsFake.sealAndCancel()
      await gate.drained()
      await runsFake.finishCleanup()
    })().then(() => { completed = true })

    await new Promise((r) => setTimeout(r, 20))
    // With the old order (drained before cancellation) completed stays false — the deadlock.
    expect(completed).toBe(true)
    expect((await request).status).toBe(200)
    await stopP
  })

  it("cleanup may resolve only after the handler unwinds; drain must not wait behind it", async () => {
    const gate = new ShutdownGate()
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    // Models an Agent whose close() resolves only after its active handler
    // unwinds — and that handler is the tracked mutation holding the gate.
    let cleanupResolve!: () => void
    const cleanup = new Promise<void>((r) => { cleanupResolve = r })
    const runsFake = {
      sealAndCancel() { release() }, // phase A: cancel only, NO cleanup await
      finishCleanup() { return cleanup }, // phase B: agent cleanup
    }

    const app = new Hono()
    app.use("*", createShutdownGateMiddleware(gate))
    app.post("/run", (c) => blocked.then(() => c.json({ done: true })))

    const request = app.request("/run", { method: "POST" })
    await new Promise((r) => setTimeout(r, 0)) // let it enter the middleware + handler

    // Mirror of AgentRuntimeHost.stop() phase order (1-4):
    const phases: string[] = []
    const stopP = (async () => {
      gate.begin() // phase 1
      phases.push("begin")
      runsFake.sealAndCancel() // phase 2: cancellation, never awaits cleanup
      phases.push("sealAndCancel")
      await gate.drained() // phase 3: unblocked by the cancellation above
      phases.push("drained")
      await runsFake.finishCleanup() // phase 4: agent cleanup
      phases.push("finishCleanup")
    })()

    await new Promise((r) => setTimeout(r, 20))
    // (a) seal/cancel released the blocked handler immediately — without
    // awaiting cleanup — so the tracked request settled and drained()
    // resolved while cleanup was still pending.
    const res = await request
    expect(res.status).toBe(200)
    expect(phases).toEqual(["begin", "sealAndCancel", "drained"])
    // (b) the run's closePromise (cleanup) resolves only AFTER the tracked
    // request completes: stop is parked in phase 4, past the drain. Under
    // the OLD order (monolithic closeAll awaiting cleanup BEFORE drained)
    // stop would still be parked before drain — the shutdown cycle this
    // regression pins.

    // The handler has unwound: cleanup may resolve, and stop completes.
    cleanupResolve()
    await stopP
    expect(phases).toEqual(["begin", "sealAndCancel", "drained", "finishCleanup"])
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

  it("cron stop is STARTED before the mutation gate drains (held mutation)", async () => {
    const gate = new ShutdownGate()
    let releaseHandler!: () => void
    const held = new Promise<void>((r) => { releaseHandler = r })
    const app = new Hono()
    app.use("*", createShutdownGateMiddleware(gate))
    app.post("/mutate", (c) => held.then(() => c.json({ done: true })))

    const request = app.request("/mutate", { method: "POST" })
    await new Promise((r) => setTimeout(r, 0)) // enters middleware + handler (now tracked)

    let cronStopStarted = false
    const cronStop = async () => { cronStopStarted = true }

    // Mirror of AgentRuntimeHost.stop() phase order: cron.stop is FIRED
    // right after begin/sealAndCancel — not awaited — so a slow or hung
    // tracked mutation cannot delay stop-claiming/drainMs/lock release.
    let drainedResolved = false
    const stopP = (async () => {
      gate.begin()
      const fired = cronStop()
      await gate.drained().then(() => { drainedResolved = true })
      await fired
    })()

    await new Promise((r) => setTimeout(r, 10))
    // Gate NOT drained (handler still held) but cron.stop already started:
    expect(drainedResolved).toBe(false)
    expect(cronStopStarted).toBe(true)

    releaseHandler()
    expect((await request).status).toBe(200)
    await stopP
    expect(drainedResolved).toBe(true)
  })
})
