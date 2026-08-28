import { describe, it, expect, vi } from "vitest"
import { CronApiError, RuntimeCronService } from "../cron-service.js"
import { pathIdentity, sha256Hex, newRuntimeId, type CronStatusPayload } from "../cron-identity.js"
import { AgentRegistry } from "../registry.js"
import type {
  CronService, CronTask, CronExecution, CreateCronTaskInput,
  CronTaskChanges, CronExecutionQuery,
} from "@zerone-agent/agent-sdk"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Recording double of the SDK service. */
class FakeSdkCronService implements CronService {
  created: CreateCronTaskInput[] = []
  updated: Array<{ taskId: string; changes: CronTaskChanges }> = []
  start = vi.fn(async () => {})
  stop = vi.fn(async () => {})
  suspend = vi.fn(async () => {})
  resume = vi.fn(async () => {})
  async create(input: CreateCronTaskInput): Promise<CronTask> {
    this.created.push(input)
    return { id: "t1", createdAt: 0, ...input } as CronTask
  }
  list = vi.fn(async (): Promise<CronTask[]> => [])
  get = vi.fn(async (): Promise<CronTask | null> => null)
  async update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null> {
    this.updated.push({ taskId, changes })
    return { id: taskId, cron: "* * * * *", prompt: "p", createdAt: 0 }
  }
  delete = vi.fn(async () => {})
  runNow = vi.fn(async () => ({}) as CronExecution)
  enqueueNow = vi.fn(async () => ({}) as CronExecution)
  listExecutions = vi.fn(async (_q?: CronExecutionQuery): Promise<CronExecution[]> => [])
  getExecution = vi.fn(async (): Promise<CronExecution | null> => null)
}

function makeRegistryWith(agentId: string, status?: "unavailable") {
  const registry = new AgentRegistry()
  if (status === "unavailable") {
    // register then force unavailable via the loadFromConfig failure path is heavy;
    // instead expose through a registered def + manual status is not public — so
    // model unavailable by registering nothing and relying on "not_found".
    return registry
  }
  registry.register(agentId, { id: agentId, description: "d" } as any, {
    model: "m", agent: { description: "d", prompt: "p", maxTurns: 10 },
  } as any)
  return registry
}

describe("RuntimeCronService agent validation", () => {
  it("create() rejects missing agentId as agent_not_found", async () => {
    const inner = new FakeSdkCronService()
    const svc = new RuntimeCronService(inner, makeRegistryWith("assistant"))
    await expect(svc.create({ cron: "* * * * *", prompt: "p" })).rejects.toMatchObject({
      name: "CronApiError", code: "agent_not_found",
    })
    expect(inner.created).toHaveLength(0)
  })

  it("create() rejects unknown agent and does not delegate", async () => {
    const inner = new FakeSdkCronService()
    const svc = new RuntimeCronService(inner, makeRegistryWith("assistant"))
    await expect(
      svc.create({ cron: "* * * * *", prompt: "p", agentId: "ghost" }),
    ).rejects.toMatchObject({ code: "agent_not_found" })
    expect(inner.created).toHaveLength(0)
  })

  it("create() delegates for a ready agent", async () => {
    const inner = new FakeSdkCronService()
    const svc = new RuntimeCronService(inner, makeRegistryWith("assistant"))
    const task = await svc.create({ cron: "* * * * *", prompt: "p", agentId: "assistant" })
    expect(task.id).toBe("t1")
    expect(inner.created).toHaveLength(1)
  })

  it("update() validates agentId only when present in changes", async () => {
    const inner = new FakeSdkCronService()
    const svc = new RuntimeCronService(inner, makeRegistryWith("assistant"))
    await svc.update("t1", { prompt: "new" }) // no agentId → no validation
    await expect(svc.update("t1", { agentId: "ghost" })).rejects.toMatchObject({
      code: "agent_not_found",
    })
    expect(inner.updated).toHaveLength(1)
  })

  it("delegates everything else verbatim", async () => {
    const inner = new FakeSdkCronService()
    const svc = new RuntimeCronService(inner, makeRegistryWith("assistant"))
    await svc.start()
    await svc.list()
    await svc.get("t1")
    await svc.delete("t1")
    await svc.runNow("t1")
    await svc.enqueueNow("t1")
    await svc.listExecutions({})
    await svc.getExecution("e1")
    await svc.stop({ drainMs: 10 })
    expect(inner.start).toHaveBeenCalled()
    expect(inner.list).toHaveBeenCalled()
    expect(inner.get).toHaveBeenCalledWith("t1")
    expect(inner.delete).toHaveBeenCalledWith("t1")
    expect(inner.runNow).toHaveBeenCalledWith("t1")
    expect(inner.enqueueNow).toHaveBeenCalledWith("t1")
    expect(inner.listExecutions).toHaveBeenCalledWith({})
    expect(inner.getExecution).toHaveBeenCalledWith("e1")
    expect(inner.stop).toHaveBeenCalledWith({ drainMs: 10 })
  })

  it("CronApiError carries code and message", () => {
    const err = new CronApiError("agent_unavailable", "Agent \"x\" is unavailable")
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("agent_unavailable")
    expect(err.message).toContain("unavailable")
  })
})

describe("cron identity helpers", () => {
  it("sha256Hex produces 64-char hex", () => {
    expect(sha256Hex("/tmp/x")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("pathIdentity is stable for the same dir and falls back when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-id-"))
    try {
      expect(pathIdentity(dir)).toBe(pathIdentity(join(dir, "..", dir.split("/").pop()!)))
      const missing = join(dir, "does-not-exist-yet")
      expect(pathIdentity(missing)).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("newRuntimeId is unique per call", () => {
    expect(newRuntimeId()).not.toBe(newRuntimeId())
  })
})
