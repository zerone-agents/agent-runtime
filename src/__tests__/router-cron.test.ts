import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { createCronRouter } from "../router/cron.js"
import { CronApiError, RuntimeCronService } from "../cron-service.js"
import { disabledCronStatus } from "../cron-identity.js"
import { AgentRegistry } from "../registry.js"
import { createApp } from "../router/index.js"
import { MetricsCollector } from "../metrics.js"
import type {
  CronService, CronTask, CronExecution, CreateCronTaskInput,
  CronTaskChanges, CronExecutionQuery,
} from "@zerone-agent/agent-sdk"

const enabledStatus = {
  enabled: true, running: true, runtimeId: "rt-1", configId: "cfg-1", dataId: "data-1",
  taskCount: 0, activeExecutionCount: 0,
}

class FakeService implements CronService {
  tasks = new Map<string, CronTask>()
  executions = new Map<string, CronExecution>()
  start = vi.fn(async () => {})
  stop = vi.fn(async () => {})
  suspend = vi.fn(async () => {})
  resume = vi.fn(async () => {})
  async create(input: CreateCronTaskInput): Promise<CronTask> {
    if (input.cron === "bad cron") throw new Error('Invalid cron expression: "bad cron". Must be a valid 5-field cron (e.g. "0 16 * * *").')
    const task: CronTask = { id: `t${this.tasks.size + 1}`, createdAt: 1, ...input }
    this.tasks.set(task.id, task)
    return task
  }
  async list(): Promise<CronTask[]> { return [...this.tasks.values()] }
  async get(id: string): Promise<CronTask | null> { return this.tasks.get(id) ?? null }
  async update(id: string, changes: CronTaskChanges): Promise<CronTask | null> {
    const t = this.tasks.get(id)
    if (!t) return null
    const next = { ...t, ...changes } as CronTask
    this.tasks.set(id, next)
    return next
  }
  async delete(id: string): Promise<void> { this.tasks.delete(id) }
  async runNow(id: string): Promise<CronExecution> { throw new Error("not used") }
  async enqueueNow(id: string): Promise<CronExecution> {
    const exec: CronExecution = {
      id: "e-run-1", cronTaskId: id, scheduledFireTime: 5, trigger: "manual", status: "pending",
    }
    this.executions.set(exec.id, exec)
    return exec
  }
  async listExecutions(q?: CronExecutionQuery): Promise<CronExecution[]> {
    let all = [...this.executions.values()]
    if (q?.cronTaskId) all = all.filter((e) => e.cronTaskId === q.cronTaskId)
    return all
  }
  async getExecution(id: string): Promise<CronExecution | null> { return this.executions.get(id) ?? null }
}

function makeRegistry() {
  const registry = new AgentRegistry()
  registry.register("assistant", { id: "assistant", description: "d" } as any, {
    model: "m", agent: { description: "d", prompt: "p", maxTurns: 10 },
  } as any)
  return registry
}

function makeApp(fake: FakeService, registry = makeRegistry()) {
  const runtime = new RuntimeCronService(fake, registry)
  const getStatus = vi.fn(async () => ({ ...enabledStatus, taskCount: fake.tasks.size }))
  return { app: createCronRouter({ cron: runtime, getStatus }), fake, getStatus }
}

describe("GET /status", () => {
  it("always responds 200 with the status payload", async () => {
    const { app } = makeApp(new FakeService())
    const res = await app.request("/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ enabled: true, running: true, runtimeId: "rt-1" })
  })

  it("works with cron absent (disabled)", async () => {
    const app = createCronRouter({
      getStatus: async () => disabledCronStatus("rt", "cfg", "data"),
    })
    const res = await app.request("/status")
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
  })
})

describe("task CRUD", () => {
  it("POST /tasks → 201 with created task", async () => {
    const { app } = makeApp(new FakeService())
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Daily summary", cron: "0 18 * * *", prompt: "Summarize", agentId: "assistant" }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: "t1", agentId: "assistant" })
  })

  it("POST /tasks missing required fields → 400 invalid_request", async () => {
    const { app } = makeApp(new FakeService())
    for (const body of [{}, { cron: "0 18 * * *" }, { prompt: "p" }, { agentId: "assistant" }]) {
      const res = await app.request("/tasks", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("invalid_request")
    }
  })

  it("POST /tasks unknown agent → 404 agent_not_found", async () => {
    const { app } = makeApp(new FakeService())
    const res = await app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron: "0 18 * * *", prompt: "p", agentId: "ghost" }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("agent_not_found")
  })

  it("POST /tasks invalid cron expression → 400 cron_invalid", async () => {
    const { app } = makeApp(new FakeService())
    const res = await app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron: "bad cron", prompt: "p", agentId: "assistant" }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("cron_invalid")
  })

  it("GET /tasks filters by agentId and paginates", async () => {
    const fake = new FakeService()
    fake.tasks.set("t1", { id: "t1", cron: "0 1 * * *", prompt: "p", createdAt: 1, agentId: "assistant" })
    fake.tasks.set("t2", { id: "t2", cron: "0 2 * * *", prompt: "p", createdAt: 2, agentId: "other" })
    fake.tasks.set("t3", { id: "t3", cron: "0 3 * * *", prompt: "p", createdAt: 3, agentId: "assistant" })
    const { app } = makeApp(fake)

    const all = await (await app.request("/tasks")).json()
    expect(all.total).toBe(3)

    const filtered = await (await app.request("/tasks?agentId=assistant")).json()
    expect(filtered.total).toBe(2)
    expect(filtered.items.map((t: CronTask) => t.id)).toEqual(["t1", "t3"])

    const paged = await (await app.request("/tasks?limit=1&offset=1")).json()
    expect(paged.items.map((t: CronTask) => t.id)).toEqual(["t2"])
    expect(paged).toMatchObject({ limit: 1, offset: 1, total: 3 })
  })

  it("GET /tasks/:id → 200 / 404 task_not_found", async () => {
    const fake = new FakeService()
    fake.tasks.set("t1", { id: "t1", cron: "0 1 * * *", prompt: "p", createdAt: 1 })
    const { app } = makeApp(fake)
    expect((await app.request("/tasks/t1")).status).toBe(200)
    const miss = await app.request("/tasks/nope")
    expect(miss.status).toBe(404)
    expect((await miss.json()).code).toBe("task_not_found")
  })

  it("PATCH /tasks/:id updates allowed fields and rejects unknown ones", async () => {
    const fake = new FakeService()
    fake.tasks.set("t1", { id: "t1", cron: "0 1 * * *", prompt: "p", createdAt: 1, agentId: "assistant" })
    const { app } = makeApp(fake)

    const ok = await app.request("/tasks/t1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "new prompt" }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).prompt).toBe("new prompt")

    const bad = await app.request("/tasks/t1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "hacked", createdAt: 999 }),
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).code).toBe("invalid_request")
  })

  it("DELETE /tasks/:id → 204 / 404", async () => {
    const fake = new FakeService()
    fake.tasks.set("t1", { id: "t1", cron: "0 1 * * *", prompt: "p", createdAt: 1 })
    const { app } = makeApp(fake)
    expect((await app.request("/tasks/t1", { method: "DELETE" })).status).toBe(204)
    expect((await app.request("/tasks/t1", { method: "DELETE" })).status).toBe(404)
  })

  it("disabled cron → 503 cron_disabled on non-status routes", async () => {
    const app = createCronRouter({ getStatus: async () => disabledCronStatus("rt", "cfg", "data") })
    for (const [method, path] of [["GET", "/tasks"], ["POST", "/tasks"], ["GET", "/executions"]] as const) {
      const res = await app.request(path, { method })
      expect(res.status).toBe(503)
      expect((await res.json()).code).toBe("cron_disabled")
    }
  })
})

describe("POST /tasks/:taskId/run (enqueueNow)", () => {
  it("returns 202 with durable claim", async () => {
    const fake = new FakeService()
    fake.tasks.set("t1", { id: "t1", cron: "0 1 * * *", prompt: "p", createdAt: 1 })
    const { app } = makeApp(fake)
    const res = await app.request("/tasks/t1/run", { method: "POST" })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ executionId: "e-run-1", status: "pending" })
  })

  it("unknown task → 404 task_not_found", async () => {
    const { app } = makeApp(new FakeService())
    const res = await app.request("/tasks/nope/run", { method: "POST" })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("task_not_found")
  })
})

describe("executions projection", () => {
  function seed(fake: FakeService) {
    fake.tasks.set("t1", { id: "t1", cron: "0 1 * * *", prompt: "p", createdAt: 1, agentId: "assistant" })
    fake.tasks.set("t2", { id: "t2", cron: "0 2 * * *", prompt: "p", createdAt: 2, agentId: "other" })
    const rows: Array<[string, string, string, string, number]> = [
      // [id, taskId, status, trigger, scheduledFireTime]
      ["e1", "t1", "succeeded", "scheduled", 100],
      ["e2", "t1", "failed", "manual", 200],
      ["e3", "t2", "succeeded", "scheduled", 300],
      ["e4", "t1", "running", "manual", 200],
    ]
    for (const [id, cronTaskId, status, trigger, scheduledFireTime] of rows) {
      fake.executions.set(id, { id, cronTaskId, status, trigger, scheduledFireTime } as CronExecution)
    }
  }

  it("filters by taskId/agentId/status/trigger and sorts scheduledFireTime DESC, id ASC", async () => {
    const fake = new FakeService()
    seed(fake)
    const { app } = makeApp(fake)

    const byAgent = await (await app.request("/executions?agentId=assistant")).json()
    expect(byAgent.total).toBe(3)
    expect(byAgent.items.map((e: CronExecution) => e.id)).toEqual(["e2", "e4", "e1"])

    const byStatus = await (await app.request("/executions?status=succeeded")).json()
    expect(byStatus.items.map((e: CronExecution) => e.id)).toEqual(["e3", "e1"])

    const byTrigger = await (await app.request("/executions?trigger=manual")).json()
    expect(byTrigger.items.map((e: CronExecution) => e.id)).toEqual(["e2", "e4"])

    const byTask = await (await app.request("/executions?taskId=t2")).json()
    expect(byTask.items.map((e: CronExecution) => e.id)).toEqual(["e3"])
  })

  it("time-range filters (from/to on scheduledFireTime) and pagination", async () => {
    const fake = new FakeService()
    seed(fake)
    const { app } = makeApp(fake)

    const ranged = await (await app.request("/executions?from=150&to=250")).json()
    expect(ranged.items.map((e: CronExecution) => e.id)).toEqual(["e2", "e4"])

    const paged = await (await app.request("/executions?limit=2&offset=1")).json()
    expect(paged.items.map((e: CronExecution) => e.id)).toEqual(["e2", "e4"])
    expect(paged).toMatchObject({ limit: 2, offset: 1, total: 4 })
  })

  it("GET /executions/:id → 200 / 404 execution_not_found", async () => {
    const fake = new FakeService()
    seed(fake)
    const { app } = makeApp(fake)
    expect((await app.request("/executions/e1")).status).toBe(200)
    const miss = await app.request("/executions/nope")
    expect(miss.status).toBe(404)
    expect((await miss.json()).code).toBe("execution_not_found")
  })
})

describe("API key inheritance via createApp", () => {
  beforeEach(() => { process.env.ZERONE_AGENT_HTTP_API_KEY = "secret" })
  afterEach(() => { delete process.env.ZERONE_AGENT_HTTP_API_KEY })

  it("requires x-api-key on /v1/cron/*", async () => {
    const registry = makeRegistry()
    const config: any = { server: {}, agents: [{ id: "assistant", description: "d" }], auth: { apiKey: "secret" } }
    const app = createApp(config, registry, new MetricsCollector(), {
      cron: {
        cron: new RuntimeCronService(new FakeService(), registry),
        getStatus: async () => ({ ...enabledStatus }),
      },
    })
    expect((await app.request("/v1/cron/status")).status).toBe(401)
    expect(
      (await app.request("/v1/cron/status", { headers: { "x-api-key": "secret" } })).status,
    ).toBe(200)
  })

  it("createApp mounts /v1/cron with disabled status when cron option omitted", async () => {
    // This describe's beforeEach sets the API key env var, which alone mounts auth in
    // createApp; this test asserts the unauthenticated default mount, so clear it first.
    delete process.env.ZERONE_AGENT_HTTP_API_KEY
    const registry = makeRegistry()
    const config: any = { server: {}, agents: [{ id: "assistant", description: "d" }] }
    const app = createApp(config, registry, new MetricsCollector())
    const res = await app.request("/v1/cron/status")
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
    const disabled = await app.request("/v1/cron/tasks")
    expect(disabled.status).toBe(503)
    expect((await disabled.json()).code).toBe("cron_disabled")
  })
})
