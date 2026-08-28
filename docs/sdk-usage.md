# SDK Usage

Use `@zerone-agent/agent-runtime` as a library instead of the CLI. The recommended entrypoint is `createRuntime()`, which composes `AgentRegistry` + `RunRegistry` + `MetricsCollector` (plus the shared cron service when `cron.enabled`) into an `AgentRuntimeHost` that owns startup/shutdown ordering:

```ts
import { createRuntime, findConfigDir, discoverConfig } from "@zerone-agent/agent-runtime"
import { serve } from "@hono/node-server"

const configDir = findConfigDir(process.argv[2]) // directory of agents.yaml / agent.config.ts
const config = await discoverConfig(configDir)

const host = await createRuntime(config, { configDir })

// Optional: register a code-built agent. Hooks and custom tool instances
// cannot be expressed in YAML — registering on host.agents after
// createRuntime replaces the config-loaded entry with the same id.
host.agents.register(
  "my-agent",
  { id: "my-agent", description: "helpful assistant", model: "claude-sonnet-4-6" },
  {
    model: "claude-sonnet-4-6",
    agent: {
      description: "helpful assistant",
      prompt: "You are a helpful assistant.",
      maxTurns: 10,
    },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [async (input) => {
        console.log(`Running: ${input.toolInput}`)
        return {}
      }]}],
    },
  },
)

// Cron lock + execution recovery + scheduler start BEFORE listening.
// No-op when cron is not enabled in the config.
await host.start()

const server = serve(
  { fetch: host.app.fetch, port: config.server.port, hostname: config.server.host },
  (info) => console.log(`runtime listening on http://${info.address}:${info.port}`),
)

// Graceful shutdown: stop accepting connections first, then drain active
// runs + cron and close all agents (host.stop()).
const shutdown = () => {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeIdleConnections?.()
  })
  Promise.allSettled([closed, host.stop()]).then(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
```

Notes:

- `host.start()` must run before `serve()`: for cron-enabled runtimes it takes the cron directory lock, recovers interrupted executions and starts the scheduler. When `cron.enabled` is false (the default) it is a no-op.
- `host.cron` is present only when `cron.enabled` is set in the config; it is the single shared cron service also mounted at `/v1/cron`.
- `host.agents` (`AgentRegistry`) and `host.runs` (`RunRegistry`) are exposed for programmatic query and code-built agent registration.
- `createApp()` remains exported as the low-level router factory for tests and embeds that deliberately manage the registry and lifecycle themselves — it is not deprecated, but normal embedding should prefer `createRuntime()`.

See `examples/programmatic/` for a full example: custom tools, hooks, multi-agent, custom routes, graceful shutdown.
