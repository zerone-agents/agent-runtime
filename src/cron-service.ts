import type {
  CronService, CreateCronTaskInput, CronTask, CronTaskChanges,
  CronExecution, CronExecutionQuery,
} from "@zerone-agent/agent-sdk"
import type { AgentRegistry } from "./registry.js"

export type CronErrorCode =
  | "agent_not_found"
  | "agent_unavailable"
  | "cron_invalid"
  | "cron_disabled"

export class CronApiError extends Error {
  constructor(readonly code: CronErrorCode, message: string) {
    super(message)
    this.name = "CronApiError"
  }
}

/**
 * Runtime policy layer over the SDK CronService (issue #21). Same interface,
 * adds only the Runtime-owned agent association policy: create/update must
 * reference a known, currently-available agent — enforced identically for
 * Agent Tools, HTTP and CLI because they all share this instance. Everything
 * else delegates verbatim; no scheduling/persistence logic is duplicated.
 */
export class RuntimeCronService implements CronService {
  constructor(
    private readonly inner: CronService,
    private readonly registry: AgentRegistry,
  ) {}

  private assertAgent(agentId: string | undefined): void {
    if (!agentId) {
      throw new CronApiError("agent_not_found", "agentId is required")
    }
    const status = this.registry.getStatus(agentId)
    if (status === "not_found") {
      throw new CronApiError("agent_not_found", `Unknown agent "${agentId}"`)
    }
    if (status === "unavailable") {
      throw new CronApiError("agent_unavailable", `Agent "${agentId}" is currently unavailable`)
    }
  }

  start(): Promise<void> { return this.inner.start() }
  stop(options?: { drainMs?: number }): Promise<void> { return this.inner.stop(options) }
  suspend(): Promise<void> { return this.inner.suspend() }
  resume(): Promise<void> { return this.inner.resume() }

  async create(input: CreateCronTaskInput): Promise<CronTask> {
    this.assertAgent(input.agentId)
    return this.inner.create(input)
  }

  list(): Promise<CronTask[]> { return this.inner.list() }
  get(taskId: string): Promise<CronTask | null> { return this.inner.get(taskId) }

  async update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null> {
    // Issue #21: create AND update must reference a valid, currently-available
    // agent. Effective agentId = explicit change when present, otherwise the
    // task's existing binding; an unbound task must therefore provide one.
    if (changes.agentId !== undefined) {
      this.assertAgent(changes.agentId)
    } else {
      const existing = await this.inner.get(taskId)
      if (existing !== null) {
        // assertAgent(undefined) throws agent_not_found ("agentId is required")
        // — unbound tasks cannot be updated without an explicit agentId.
        this.assertAgent(existing.agentId)
      }
      // existing === null → unknown task: delegate; inner.update returns null
      // and the router maps it to 404 task_not_found.
    }
    return this.inner.update(taskId, changes)
  }

  delete(taskId: string): Promise<void> { return this.inner.delete(taskId) }
  runNow(taskId: string): Promise<CronExecution> { return this.inner.runNow(taskId) }
  enqueueNow(taskId: string): Promise<CronExecution> { return this.inner.enqueueNow(taskId) }
  listExecutions(query?: CronExecutionQuery): Promise<CronExecution[]> {
    return this.inner.listExecutions(query)
  }
  getExecution(executionId: string): Promise<CronExecution | null> {
    return this.inner.getExecution(executionId)
  }
}
