# File-Based Custom Tools

Agents can declare custom tools as files in a `tools/` directory — no code changes to the runtime config required. Drop a file in, restart, and the tool is available to that agent.

## Directory Convention

```
<configDir>/
  agents.yaml | agent.config.ts
  agents/
    <agent-id>/
      tools/
        get_weather.ts      → tool "get_weather"
        send_slack.mjs      → tool "send_slack"
```

- By default the directory is `<configDir>/agents/<agent-id>/tools/`, matched by config `id`.
- Override per agent with the optional `toolsDir` field in `agents.yaml` / `agent.config.ts` — relative paths resolve against `configDir`, absolute paths are used as-is:

```yaml
agents:
  - id: assistant
    model: claude-sonnet-4-6
    toolsDir: shared/tools        # → <configDir>/shared/tools
```

This follows the same pattern as `systemPromptFile` (explicit path resolved against configDir); unlike the prompt, the tools directory also has a default convention.

- The tool name is derived from the file name (without extension). Do not declare a `name` field.
- Supported extensions: `.ts`, `.mts`, `.js`, `.mjs`.
- The directory is optional — agents without one are unaffected.

## Writing a Tool

```ts
// agents/assistant/tools/get_weather.ts
import { defineTool } from "@zerone-agent/agent-runtime/tools"
import { z } from "zod"

export default defineTool({
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
| `description` | yes | What the tool does; shown to the model. |
| `inputSchema` | yes | A zod object schema. Input is validated before `execute` runs; validation failures are returned to the model as tool errors. |
| `execute(input, context)` | yes | The tool implementation. Return a string, or any value (serialized to JSON text). Thrown errors become tool errors. |
| `annotations` | no | MCP-style hints, e.g. `{ readOnlyHint: true }` marks the tool read-only and concurrency-safe. |

## Rules (v1)

- **Flat only** — subdirectories are ignored.
- **Default export only** — each file must `export default defineTool({...})`.
- **Startup loading** — tools load once at startup; editing a tool file requires a restart. No hot reload.
- **Name collisions are errors** — `foo.ts` and `foo.mjs` in the same directory collide; there is no implicit override.
- **Failure isolation** — if one agent's tools fail to load, that agent is marked `unavailable`; other agents and the HTTP service keep running.
- **Trusted code** — tool files run with full Node.js privileges in the runtime process. Treat them like server code.

## Inspecting Loaded Tools

The agent detail endpoint (`GET /agents/:id`) includes `fileTools` with the names of tools loaded from the directory:

```json
{ "id": "assistant", "status": "ready", "fileTools": ["get_weather"] }
```

## TypeScript Tool Files

`.ts` files are loaded through the bundled `tsx` dependency (same mechanism as `agent.config.ts`). Writing tools in plain `.mjs` works too if you prefer zero transpilation:

```js
// tools/ping.mjs
export default {
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
