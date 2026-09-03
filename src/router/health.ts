import { createRequire } from "node:module"
import { Hono } from "hono"
import type { AgentRegistry } from "../registry.js"
import type { MetricsCollector } from "../metrics.js"

// Read version from package.json at runtime (../../ resolves to the package
// root both in dev: src/router/ -> ../../package.json and in dist:
// dist/router/ -> ../../package.json; package.json ships in npm tarball
// and the Docker image). Static JSON import is avoided because rootDir=./src
// would reject it (TS6059).
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string }

export function createHealthRouter(registry: AgentRegistry) {
  const router = new Hono()

  router.get("/", (c) => {
    const agents = registry.list()
    const allReady = agents.every((a) => a.status === "ready")
    return c.json({
      status: allReady ? "ok" : "degraded",
      version,
      agents: agents.length,
      uptime: Date.now(),
      // 能力声明（issue #61）：Hub 探测到该能力且 deployer 返回非空
      // containerId 后才启用附件入口，并携带 X-Expected-Container-Id
      capabilities: {
        attachmentExpectedGeneration: true,
      },
    })
  })

  return router
}

export function createMetricsRouter(metrics: MetricsCollector) {
  const router = new Hono()

  router.get("/", (c) => {
    return c.json(metrics.getSnapshot())
  })

  return router
}
