#!/usr/bin/env node
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { discoverConfig, findConfigDir } from "./config.js"
import { AgentRegistry } from "./registry.js"
import { MetricsCollector } from "./metrics.js"
import { createApp } from "./router/index.js"

export { createApp } from "./router/index.js"
export { AgentRegistry, type AgentInfo } from "./registry.js"
export { MetricsCollector, type AgentMetrics, type RuntimeMetrics } from "./metrics.js"
export { streamAgentResponse } from "./sse.js"
export {
  discoverConfig,
  findConfigDir,
  loadYamlConfig,
  defineConfig,
  resolveSystemPrompt,
  RuntimeConfigSchema,
  type RuntimeConfig,
  type AgentDefinition,
} from "./config.js"

const __filename = fileURLToPath(import.meta.url)
const argv1 = process.argv[1]
const isMain = !!argv1 && (
  __filename === fileURLToPath(new URL(argv1, "file:///")) ||
  argv1.endsWith("open-agent-runtime")
)

if (isMain) {
  async function main() {
    const { values } = parseArgs({
      options: {
        config: { type: "string", short: "c" },
        port: { type: "string", short: "p" },
      },
      strict: false,
    })

    const configDir = findConfigDir(values.config as string | undefined)
    const config = await discoverConfig(configDir)

    if (values.port) {
      config.server.port = parseInt(values.port as string, 10)
    }

    console.log(`Loading config from: ${configDir}`)
    console.log(`Agents: ${config.agents.map((a) => a.id).join(", ")}`)

    const registry = new AgentRegistry()
    await registry.loadFromConfig(config, configDir)

    const metrics = new MetricsCollector()
    const app = createApp(config, registry, metrics)

    const { serve } = await import("@hono/node-server")
    serve(
      { fetch: app.fetch, port: config.server.port, hostname: config.server.host },
      (info: { address: string; port: number }) => {
        console.log(`open-agent-runtime listening on http://${info.address}:${info.port}`)
      },
    )
  }

  main().catch((err) => {
    console.error("Failed to start:", err.message)
    process.exit(1)
  })
}
