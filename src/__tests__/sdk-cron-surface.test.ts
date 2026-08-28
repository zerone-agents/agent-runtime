import { describe, it, expect } from "vitest"
import { createDefaultCronService } from "@zerone-agent/agent-sdk/cron/node"
import type { CronService } from "@zerone-agent/agent-sdk"

describe("SDK cron surface (issue #21 prerequisite)", () => {
  it("exposes createDefaultCronService with a required resolveAgent", () => {
    expect(typeof createDefaultCronService).toBe("function")
  })

  it("CronService interface includes enqueueNow (PR #53) at runtime", () => {
    // Structural probe: the default service must implement the host-trigger API.
    const svc = createDefaultCronService({
      resolveAgent: async () => { throw new Error("unused") },
    })
    expect(typeof (svc as CronService).enqueueNow).toBe("function")
    expect(typeof svc.runNow).toBe("function")
    expect(typeof svc.stop).toBe("function")
  })
})
