import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest"
import { runCli, CLI_EXIT } from "../cli.js"
import { Hono } from "hono"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverConfig, findConfigDir } from "../config.js"
import { pathIdentity } from "../cron-identity.js"
import { resolveCronDataRoot } from "../runtime.js"

// Hermetic config fixture: findConfigDir() discovers this via process.cwd(),
// so the CLI under test never depends on a machine-level ~/.openagent config.
const fixtureDir = mkdtempSync(join(tmpdir(), "cli-cron-"))
writeFileSync(
  join(fixtureDir, "agents.yaml"),
  "agents:\n  - id: assistant\n    description: Fixture agent for CLI tests\n",
)
const originalCwd = process.cwd()

// The write guard compares server identity against the CLI's locally computed
// pathIdentity() values (sha256 hex). The fake server echoes those same values
// by default; tests override them (e.g. "cfg-REMOTE") to force a mismatch.
let localConfigId = ""
let localDataId = ""

beforeAll(async () => {
  process.chdir(fixtureDir)
  const configDir = findConfigDir(undefined)
  const config = await discoverConfig(configDir)
  localConfigId = pathIdentity(configDir)
  localDataId = pathIdentity(resolveCronDataRoot(config, configDir))
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(fixtureDir, { recursive: true, force: true })
})

/** In-process fake /v1/cron server routed through stubbed global fetch. */
function makeFakeServer(statusOverrides: Record<string, unknown> = {}) {
  const app = new Hono({ strict: false })
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  app.get("/v1/cron/status", async (c) => {
    return c.json({
      enabled: true, running: true, runtimeId: "rt", configId: localConfigId, dataId: localDataId,
      taskCount: 1, activeExecutionCount: 0,
      ...statusOverrides,
    })
  })
  app.get("/v1/cron/tasks", async (c) => {
    calls.push({ method: "GET", path: "/v1/cron/tasks" })
    return c.json({
      items: [{ id: "t1", name: "Daily", cron: "0 18 * * *", prompt: "p", createdAt: 1, agentId: "assistant" }],
      limit: 50, offset: 0, total: 1,
    })
  })
  app.post("/v1/cron/tasks", async (c) => {
    const body = await c.req.json()
    calls.push({ method: "POST", path: "/v1/cron/tasks", body })
    return c.json({ id: "t9", createdAt: 2, ...body }, 201)
  })
  app.post("/v1/cron/tasks/:id/run", async (c) => {
    calls.push({ method: "POST", path: `/v1/cron/tasks/${c.req.param("id")}/run` })
    return c.json({ executionId: "e1", status: "pending" }, 202)
  })
  app.delete("/v1/cron/tasks/:id", async (c) => {
    calls.push({ method: "DELETE", path: `/v1/cron/tasks/${c.req.param("id")}` })
    return c.body(null, 204)
  })
  app.get("/v1/cron/executions", (c) => c.json({ items: [], limit: 50, offset: 0, total: 0 }))
  return { app, calls }
}

function stubFetch(app: Hono) {
  const fetchFn = async (input: string | URL, init?: RequestInit) =>
    app.fetch(new Request(typeof input === "string" ? input : input.toString(), init))
  vi.stubGlobal("fetch", fetchFn)
}

// CLI reads config for defaults; point it at an env-driven server URL.
const baseArgs = ["cron", "--server", "http://unit.test"]

describe("cron CLI (online)", () => {
  beforeEach(() => { delete process.env.ZERONE_AGENT_HTTP_API_KEY })
  afterEach(() => { vi.unstubAllGlobals() })

  it("list prints JSON with --json and exits 0", async () => {
    const { app } = makeFakeServer()
    stubFetch(app)
    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)))
    const code = await runCli([...baseArgs, "list", "--json"])
    spy.mockRestore()
    expect(code).toBe(CLI_EXIT.OK)
    const parsed = JSON.parse(logs.join("\n"))
    expect(parsed.items[0].id).toBe("t1")
  })

  it("create sends x-api-key and body; exits 0", async () => {
    process.env.ZERONE_AGENT_HTTP_API_KEY = "secret"
    const { app, calls } = makeFakeServer()
    let seenAuth: string | undefined
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const req = new Request(typeof input === "string" ? input : input.toString(), init)
      seenAuth = req.headers.get("x-api-key") ?? undefined
      return app.fetch(req)
    }
    vi.stubGlobal("fetch", fetchFn)

    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)))
    const code = await runCli([
      ...baseArgs, "create",
      "--name", "Daily", "--cron", "0 18 * * *", "--prompt", "p", "--agent", "assistant", "--json",
    ])
    spy.mockRestore()
    expect(code).toBe(CLI_EXIT.OK)
    expect(seenAuth).toBe("secret")
    expect(calls.find((c) => c.path === "/v1/cron/tasks")?.body).toEqual({
      name: "Daily", cron: "0 18 * * *", prompt: "p", agentId: "assistant",
    })
    expect(logs.join("\n")).toContain("t9")
  })

  it("run posts to /tasks/:id/run and prints execution", async () => {
    const { app, calls } = makeFakeServer()
    stubFetch(app)
    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)))
    const code = await runCli([...baseArgs, "run", "t1", "--json"])
    spy.mockRestore()
    expect(code).toBe(CLI_EXIT.OK)
    expect(calls.some((c) => c.path === "/v1/cron/tasks/t1/run")).toBe(true)
    expect(logs.join("\n")).toContain("e1")
  })

  it("write with mismatched instance identity exits MISMATCH", async () => {
    const { app } = makeFakeServer({ configId: "cfg-REMOTE" })
    stubFetch(app)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const code = await runCli([...baseArgs, "delete", "t1"])
    errSpy.mockRestore()
    expect(code).toBe(CLI_EXIT.MISMATCH)
  })

  it("disabled remote cron exits CRON_DISABLED", async () => {
    const { app } = makeFakeServer({ enabled: false })
    stubFetch(app)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const code = await runCli([...baseArgs, "delete", "t1"])
    errSpy.mockRestore()
    expect(code).toBe(CLI_EXIT.CRON_DISABLED)
  })

  it("connection failure on write exits CONNECT", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED") })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const code = await runCli([...baseArgs, "list"])
    errSpy.mockRestore()
    expect(code).toBe(CLI_EXIT.CONNECT)
  })

  it("404 from server exits NOT_FOUND", async () => {
    const app = new Hono()
    app.get("/v1/cron/status", (c) => c.json({ enabled: true, running: true, runtimeId: "r", configId: "cfg-local", dataId: "data-local", taskCount: 0, activeExecutionCount: 0 }))
    app.get("*", (c) => c.json({ error: "Task not found", code: "task_not_found" }, 404))
    stubFetch(app)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const code = await runCli([...baseArgs, "get", "nope"])
    errSpy.mockRestore()
    expect(code).toBe(CLI_EXIT.NOT_FOUND)
  })

  it("--offline is rejected with offline_not_supported", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const code = await runCli([...baseArgs, "list", "--offline"])
    expect(code).toBe(CLI_EXIT.USAGE)
    // Assert before mockRestore(): restoring clears mock.calls state.
    expect(String(errSpy.mock.calls)).toContain("offline_not_supported")
    errSpy.mockRestore()
  })

  it("unknown command exits USAGE", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const code = await runCli(["frobnicate"])
    errSpy.mockRestore()
    expect(code).toBe(CLI_EXIT.USAGE)
  })

  it("--help/-h print usage and exit 0 before serve flag fallback", async () => {
    for (const args of [["--help"], ["-h"]]) {
      const logs: string[] = []
      const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)))
      const code = await runCli(args)
      spy.mockRestore()
      expect(code).toBe(CLI_EXIT.OK)
      expect(logs.join("\n")).toContain("Usage:")
    }
  })
})
