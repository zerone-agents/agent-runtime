import type { MiddlewareHandler } from "hono"

/**
 * Application-level shutdown gate: once begun, mutating requests (/v1/*)
 * are rejected with 503 shutting_down so accepted connections cannot start
 * new run/cron work while the host drains (server.close() alone waits on
 * in-flight requests, which streaming responses can hold open indefinitely).
 * GET/HEAD remain served so health/status probes stay truthful during drain.
 */
export class ShutdownGate {
  private down = false
  begin(): void { this.down = true }
  get shuttingDown(): boolean { return this.down }
}

export function createShutdownGateMiddleware(gate: ShutdownGate): MiddlewareHandler {
  return async (c, next) => {
    if (gate.shuttingDown && c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: "Runtime is shutting down", code: "shutting_down" }, 503)
    }
    await next()
  }
}
