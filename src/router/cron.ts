import { Hono } from "hono"
import { CRON_EXECUTION_STATUSES, CronServiceStoppingError, type CronExecution, type CronTask } from "@zerone-agent/agent-sdk"
import { CronApiError, type RuntimeCronService } from "../cron-service.js"
import { type CronStatusPayload } from "../cron-identity.js"

export interface CronRouterDeps {
  cron?: RuntimeCronService
  getStatus: () => Promise<CronStatusPayload>
}

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

// Status validation uses the SDK-exported CRON_EXECUTION_STATUSES so future SDK
// statuses are accepted without a runtime change. The SDK does not export a
// trigger set — mirror the CronExecutionTrigger union here, keep in sync.
const EXECUTION_TRIGGERS = new Set(["scheduled", "manual"])

interface ErrorBody {
  error: string
  code: string
}

function jsonError(error: string, code: string, status: number) {
  return (c: { json: (b: ErrorBody, s: number) => Response }) => c.json({ error, code }, status)
}

/** SDK throws plain Errors for invalid cron specs; detect by message prefix. */
function isInvalidCronError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message.startsWith("Invalid cron expression:") ||
      err.message.startsWith("Cron expression has no matching run time"))
  )
}

function toErrorResponse(err: unknown) {
  if (err instanceof CronApiError) {
    switch (err.code) {
      case "agent_not_found":
        return { status: 404, body: { error: err.message, code: err.code } }
      case "agent_unavailable":
        return { status: 503, body: { error: err.message, code: err.code } }
      case "cron_invalid":
        return { status: 400, body: { error: err.message, code: err.code } }
      case "cron_disabled":
        return { status: 503, body: { error: err.message, code: err.code } }
    }
  }
  if (err instanceof CronServiceStoppingError) {
    // SDK 2.3.0 lifecycle barrier (SDK #57/#58): protected operations reject
    // once stop() begins — map to the same stable response the shutdown gate
    // gives, so clients see one code for "shutting down" either way.
    return { status: 503, body: { error: err.message, code: "shutting_down" } }
  }
  if (isInvalidCronError(err)) {
    return { status: 400, body: { error: err.message, code: "cron_invalid" } }
  }
  return { status: 500, body: { error: "Cron service error", code: "internal" } }
}

/** Parse a uint query param. undefined = absent; null = present but invalid. */
function parseUintParam(url: URL, name: string, min: number, max: number): number | null | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

/** In-memory projection over SDK list()+listExecutions() (issue #21: low-frequency management queries). */
async function projectExecutions(
  cron: RuntimeCronService,
  filters: { taskId?: string; agentId?: string; status?: string; trigger?: string; from?: number; to?: number },
  limit: number,
  offset: number,
) {
  const [executions, tasks] = await Promise.all([cron.listExecutions(), cron.list()])
  const agentByTask = new Map<string, string | undefined>(tasks.map((t) => [t.id, t.agentId]))

  let rows = executions.filter((e) => {
    if (filters.taskId !== undefined && e.cronTaskId !== filters.taskId) return false
    if (filters.agentId !== undefined && agentByTask.get(e.cronTaskId) !== filters.agentId) return false
    if (filters.status !== undefined && e.status !== filters.status) return false
    if (filters.trigger !== undefined && e.trigger !== filters.trigger) return false
    if (filters.from !== undefined && e.scheduledFireTime < filters.from) return false
    if (filters.to !== undefined && e.scheduledFireTime > filters.to) return false
    return true
  })
  rows = rows.sort((a, b) =>
    b.scheduledFireTime - a.scheduledFireTime || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )

  const total = rows.length
  return { items: rows.slice(offset, offset + limit), limit, offset, total }
}

async function paginateTasks(cron: RuntimeCronService, agentId: string | undefined, limit: number, offset: number) {
  const tasks = await cron.list()
  const rows = agentId !== undefined ? tasks.filter((t) => t.agentId === agentId) : tasks
  return { items: rows.slice(offset, offset + limit), limit, offset, total: rows.length }
}

const TASK_BODY_FIELDS = ["name", "cron", "prompt", "agentId"] as const

export function createCronRouter(deps: CronRouterDeps): Hono {
  const app = new Hono({ strict: false })

  app.get("/status", async (c) => c.json(await deps.getStatus()))

  // Everything below requires an enabled service.
  app.use("/tasks/*", async (c, next) => {
    if (!deps.cron) return jsonError("Cron is disabled", "cron_disabled", 503)(c)
    await next()
  })
  app.use("/tasks", async (c, next) => {
    if (!deps.cron) return jsonError("Cron is disabled", "cron_disabled", 503)(c)
    await next()
  })
  app.use("/executions/*", async (c, next) => {
    if (!deps.cron) return jsonError("Cron is disabled", "cron_disabled", 503)(c)
    await next()
  })
  app.use("/executions", async (c, next) => {
    if (!deps.cron) return jsonError("Cron is disabled", "cron_disabled", 503)(c)
    await next()
  })
  const cron = () => deps.cron!

  app.get("/tasks", async (c) => {
    try {
      const url = new URL(c.req.url)
      const rawLimit = parseUintParam(url, "limit", 1, MAX_LIMIT)
      const rawOffset = parseUintParam(url, "offset", 0, Number.MAX_SAFE_INTEGER)
      if (rawLimit === null || rawOffset === null) {
        return jsonError("Invalid pagination parameters (limit: 1-200, offset: >= 0)", "invalid_request", 400)(c)
      }
      const limit = rawLimit ?? DEFAULT_LIMIT
      const offset = rawOffset ?? 0
      return c.json(await paginateTasks(cron(), url.searchParams.get("agentId") ?? undefined, limit, offset))
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  app.post("/tasks", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>().catch(() => null)
      if (!body || typeof body !== "object") {
        return jsonError("Request body must be a JSON object", "invalid_request", 400)(c)
      }
      for (const field of ["cron", "prompt", "agentId"] as const) {
        if (typeof body[field] !== "string" || !(body[field] as string).trim()) {
          return jsonError(`Missing or invalid field "${field}"`, "invalid_request", 400)(c)
        }
      }
      if (body.name !== undefined && typeof body.name !== "string") {
        return jsonError("Field \"name\" must be a string", "invalid_request", 400)(c)
      }
      const task = await cron().create({
        cron: body.cron as string,
        prompt: body.prompt as string,
        agentId: body.agentId as string,
        name: body.name as string | undefined,
      })
      return c.json(task, 201)
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  app.get("/tasks/:taskId", async (c) => {
    try {
      const task = await cron().get(c.req.param("taskId"))
      if (!task) return jsonError("Task not found", "task_not_found", 404)(c)
      return c.json(task)
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  app.patch("/tasks/:taskId", async (c) => {
    try {
      const taskId = c.req.param("taskId")
      const body = await c.req.json<Record<string, unknown>>().catch(() => null)
      if (!body || typeof body !== "object") {
        return jsonError("Request body must be a JSON object", "invalid_request", 400)(c)
      }
      const changes: Record<string, string> = {}
      for (const [key, value] of Object.entries(body)) {
        if (!TASK_BODY_FIELDS.includes(key as (typeof TASK_BODY_FIELDS)[number])) {
          return jsonError(`Unknown or immutable field "${key}"`, "invalid_request", 400)(c)
        }
        if (value !== undefined && typeof value !== "string") {
          return jsonError(`Field "${key}" must be a string`, "invalid_request", 400)(c)
        }
        if (value !== undefined) changes[key] = value
      }
      const task = await cron().update(taskId, changes)
      if (!task) return jsonError("Task not found", "task_not_found", 404)(c)
      return c.json(task)
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  app.delete("/tasks/:taskId", async (c) => {
    try {
      const taskId = c.req.param("taskId")
      const existing = await cron().get(taskId)
      if (!existing) return jsonError("Task not found", "task_not_found", 404)(c)
      await cron().delete(taskId)
      return c.body(null, 204)
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  app.post("/tasks/:taskId/run", async (c) => {
    try {
      const taskId = c.req.param("taskId")
      const existing = await cron().get(taskId)
      if (!existing) return jsonError("Task not found", "task_not_found", 404)(c)
      const execution = await cron().enqueueNow(taskId)
      // enqueueNow returns after the claim is durable: pending | skipped | duplicate.
      return c.json({ executionId: execution.id, status: execution.status }, 202)
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  app.get("/executions", async (c) => {
    try {
      const url = new URL(c.req.url)
      const rawLimit = parseUintParam(url, "limit", 1, MAX_LIMIT)
      const rawOffset = parseUintParam(url, "offset", 0, Number.MAX_SAFE_INTEGER)
      if (rawLimit === null || rawOffset === null) {
        return jsonError("Invalid pagination parameters (limit: 1-200, offset: >= 0)", "invalid_request", 400)(c)
      }
      const limit = rawLimit ?? DEFAULT_LIMIT
      const offset = rawOffset ?? 0
      const rawStatus = url.searchParams.get("status")
      const rawTrigger = url.searchParams.get("trigger")
      // Absent (null) → undefined (no filter). Empty string is a supplied value
      // and fails the enum check below → 400, like any other invalid value.
      const status = rawStatus ?? undefined
      const trigger = rawTrigger ?? undefined
      const from = parseUintParam(url, "from", 0, Number.MAX_SAFE_INTEGER)
      const to = parseUintParam(url, "to", 0, Number.MAX_SAFE_INTEGER)
      if (
        (status !== undefined && !CRON_EXECUTION_STATUSES.has(status)) ||
        (trigger !== undefined && !EXECUTION_TRIGGERS.has(trigger)) ||
        from === null || to === null
      ) {
        return jsonError("Invalid filter parameters (status/trigger/from/to)", "invalid_request", 400)(c)
      }
      return c.json(
        await projectExecutions(
          cron(),
          {
            taskId: url.searchParams.get("taskId") ?? undefined,
            agentId: url.searchParams.get("agentId") ?? undefined,
            status,
            trigger,
            from: from ?? undefined,
            to: to ?? undefined,
          },
          limit,
          offset,
        ),
      )
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  app.get("/executions/:executionId", async (c) => {
    try {
      const execution = await cron().getExecution(c.req.param("executionId"))
      if (!execution) return jsonError("Execution not found", "execution_not_found", 404)(c)
      return c.json(execution)
    } catch (err) {
      const mapped = toErrorResponse(err)
      return jsonError(mapped.body.error, mapped.body.code, mapped.status)(c)
    }
  })

  return app
}
