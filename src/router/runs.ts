import { Hono } from "hono"
import type { RunRegistry } from "../runs.js"

export function createRunsRouter(runsRegistry: RunRegistry) {
  const router = new Hono()

  router.post("/:runId/cancel", (c) => {
    const { runId } = c.req.param()

    const outcome = runsRegistry.cancel(runId)
    if (!outcome) {
      return c.json({ error: "Run not found" }, 404)
    }

    if (outcome.state === "cancelling" || outcome.state === "cancelled") {
      return c.json(
        { runId, state: outcome.state, reason: outcome.reason },
        202,
      )
    }

    // completed / failed
    return c.json(
      { runId, state: outcome.state, reason: outcome.reason },
      409,
    )
  })

  return router
}
