import type { MiddlewareHandler } from "hono"

/**
 * Application-level shutdown gate: once begun, mutating requests (/v1/*)
 * are rejected with 503 shutting_down, and in-flight mutations are tracked
 * so shutdown can await their completion (drained()). The shutdown
 * sequence cancels registered Runs BEFORE awaiting drained() — cancellation
 * is what unblocks tracked run handlers — then awaits Run cleanup and Cron
 * drain concurrently (see AgentRuntimeHost.stop()). GET/HEAD are neither
 * rejected nor tracked (status probes stay truthful, SSE streams must not
 * block shutdown).
 */
export class ShutdownGate {
  private down = false
  private active = 0
  private idleResolvers: Array<() => void> = []

  begin(): void {
    this.down = true
    this.notifyIfIdle()
  }

  get shuttingDown(): boolean {
    return this.down
  }

  /** Track an in-flight mutating request. Must pair with leave(). */
  enter(): void {
    this.active++
  }

  leave(): void {
    this.active = Math.max(0, this.active - 1)
    this.notifyIfIdle()
  }

  /**
   * Resolves when no tracked mutating request remains in flight. Call after
   * begin(): later mutations are rejected by the middleware, in-flight ones
   * finish first — the drain boundary for Host stop.
   */
  drained(): Promise<void> {
    return new Promise((resolve) => {
      if (this.active === 0) resolve()
      else this.idleResolvers.push(resolve)
    })
  }

  private notifyIfIdle(): void {
    if (this.active === 0) {
      const waiters = this.idleResolvers
      this.idleResolvers = []
      for (const w of waiters) w()
    }
  }
}

export function createShutdownGateMiddleware(gate: ShutdownGate): MiddlewareHandler {
  return async (c, next) => {
    const mutating = c.req.method !== "GET" && c.req.method !== "HEAD"
    if (mutating && gate.shuttingDown) {
      return c.json({ error: "Runtime is shutting down", code: "shutting_down" }, 503)
    }
    if (!mutating) return next()
    // Track in-flight mutations: a request that entered before begin() must
    // hold drained() until its handler finishes.
    gate.enter()
    try {
      await next()
    } finally {
      gate.leave()
    }
  }
}
