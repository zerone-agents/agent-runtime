# File-Based Custom Tools

Agents can declare custom tools as script files listed in the config — no code changes to the runtime required. Add a file, list it under `customTools`, restart, and the tool is available to that agent.

## Declaring Tools

List tool script files per agent in `agents.yaml` / `agent.config.ts`:

```yaml
agents:
  - id: assistant
    model: claude-sonnet-4-6
    allowedTools: [Task, Read, Write, Edit, Bash, Glob, Grep, WebSearch]
    customTools:
      - ./tools/get_weather.ts
      - ./tools/send_slack.mjs
```

- Paths resolve against `configDir`; absolute paths are used as-is.
- The tool name comes from the definition's required `name` field — consistent with the SDK's `ToolDefinition` / `tool()` convention.
- Supported extensions: `.ts`, `.mts`, `.js`, `.mjs`.
- `customTools` is optional — agents without it are unaffected.

## Writing a Tool

```ts
// tools/get_weather.ts
import { defineTool } from "@zerone-agent/agent-runtime/tools"
import { z } from "zod"

export default defineTool({
  name: "GetWeather",
  description: "Get weather for a city",

  inputSchema: z.object({
    cityName: z.string().describe("City name"),
  }),

  async execute(input) {
    const weather = await fetchWeather(input.cityName)
    return `${input.cityName}: ${weather.temp}°C, ${weather.condition}`
  },
})
```

`defineTool()` is a pure authoring helper — it provides type inference and editor hints, and returns the definition unchanged. It never scans, registers, or executes anything; the runtime gives the file its meaning at startup.

### Definition Fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Tool name, consistent with the SDK's `ToolDefinition` / `tool()` convention. |
| `description` | yes | What the tool does; shown to the model. |
| `inputSchema` | yes | A zod object schema. Input is validated before `execute` runs; validation failures are returned to the model as tool errors. |
| `execute(input, context)` | yes | The tool implementation. Return a string, or any value (serialized to JSON text). Thrown errors become tool errors. |
| `annotations` | no | MCP-style hints, e.g. `{ readOnlyHint: true }` marks the tool read-only and concurrency-safe. |

## Rules (v1)

- **Explicit list only** — tools load only from files listed in `customTools`; there is no directory scanning.
- **Default export only** — each file must `export default defineTool({...})`.
- **Startup loading** — tools load once at startup; editing a tool file requires a restart. No hot reload.
- **Name collisions are errors** — two listed files defining the same `name` collide; there is no implicit override.
- **Failure isolation** — if one agent's tools fail to load, that agent is marked `unavailable`; other agents and the HTTP service keep running.
- **Trusted code** — tool files run with full Node.js privileges in the runtime process. Treat them like server code.

## Inspecting Loaded Tools

The agent detail endpoint (`GET /agents/:id`) includes `fileTools` with the names of tools loaded from `customTools` files:

```json
{ "id": "assistant", "status": "ready", "fileTools": ["get_weather"] }
```

## TypeScript Tool Files

`.ts` files are loaded through the bundled `tsx` dependency (same mechanism as `agent.config.ts`). Writing tools in plain `.mjs` works too if you prefer zero transpilation:

```js
// tools/ping.mjs
export default {
  name: "Ping",
  description: "Ping",
  inputSchema: { parse: (i) => i },  // or use zod if installed
  async execute() { return "pong" },
}
```

## Not Yet Supported

These are deliberate v1 scope cuts; file an issue if you need them:

- Overriding built-in tools by name (`tools/Bash.ts`)
- `disableTool()` to remove a built-in tool
- Recursive directory scanning
- File watching / hot reload
- Sandboxed execution
