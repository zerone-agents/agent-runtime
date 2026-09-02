// fd-2 leak probe (#54 review r2). Spawned by mcp-stdio-integration.test.ts
// with PIPED stdio: performs a real acquisition of a server that prints a
// secret to its own stderr. If the child's stderr were inherited (the SDK
// transport default), the secret would surface in THIS process's stderr —
// which the parent test captures and inspects.
//
// Runs on Node's native type stripping (no vitest transform), so it must
// only use erasable TS syntax on its import path.
import { McpConnectionManager } from "../../src/mcp-connections.ts"

const SECRET = "hunter2-token-xyz"
const m = new McpConnectionManager()
try {
  await m.acquire("probe", "leaky", {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", `process.stderr.write("boot failed token=${SECRET}\\n"); process.exit(1)`],
  })
  console.error("unexpected: connected")
  process.exit(1)
} catch (err) {
  const msg = String(err?.message ?? err)
  if (!msg.includes('MCP server "leaky" failed to connect')) {
    console.error("unexpected error shape:", msg)
    process.exit(1)
  }
  console.log("acquire rejected as expected")
} finally {
  await m.closeAll()
}
