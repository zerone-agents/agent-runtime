# SDK Usage

Use `@zerone-agent/agent-runtime` as a library instead of the CLI:

```ts
import { createApp, AgentRegistry, MetricsCollector } from "@zerone-agent/agent-runtime"
import { createAgent, defineTool } from "@zerone-agent/agent-sdk"
import { serve } from "@hono/node-server"

const agent = createAgent({
  model: "claude-sonnet-4-6",
  systemPrompt: "You are a helpful assistant.",
  maxTurns: 10,
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [async (input) => {
      console.log(`Running: ${input.toolInput}`)
      return {}
    }]}],
  },
})

const registry = new AgentRegistry()
registry.register("my-agent", agent)

const metrics = new MetricsCollector()
const app = createApp(
  { server: { host: "0.0.0.0", port: 3000 }, agents: [{ id: "my-agent", model: "claude-sonnet-4-6" }] },
  registry,
  metrics,
)

serve({ fetch: app.fetch, port: 3000 })
```

See `examples/programmatic/` for a full example: custom tools, hooks, multi-agent, custom routes.
