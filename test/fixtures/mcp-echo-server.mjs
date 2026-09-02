// Minimal stdio MCP server used by integration smoke tests.
// Spawned via `node test/fixtures/mcp-echo-server.mjs` from
// mcp-stdio-integration.test.ts — exercises the REAL SDK connectMCPServer
// path (transport negotiation + tool materialization) end to end.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "echo", version: "1.0.0" })

server.registerTool(
  "echo",
  {
    description: "Echo back the input text",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
)

await server.connect(new StdioServerTransport())
