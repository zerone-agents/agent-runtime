import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { AgentRegistry } from "../registry.js"
import { RunRegistry } from "../runs.js"
import { MetricsCollector } from "../metrics.js"
import { createAgentRouter } from "../router/agent.js"

/**
 * Issue #65 behavior-level integration test against the REAL SDK (3.3.1+),
 * end-to-end through the HTTP run router:
 *
 *   agents.yaml (registry config) sets maxSessionQueries: 3 → run bodies do
 *   NOT carry the field → the same session's 4th query must emit
 *   compact/progress + compact/end SSE events.
 *
 * This reproduces the Hub chat flow: run #1 posts without a sessionId, the
 * runtime returns the agent's sessionId, runs #2-4 pass it back so each new
 * per-run Agent resumes the persisted session transcript. The deterministic
 * LLM is a local stub OpenAI-compatible server (127.0.0.1, ephemeral port) —
 * no public network. If the router passed `{ maxSessionQueries: undefined }`
 * as an override (the pre-fix contract), older SDKs would clobber the
 * configured cap and these compact events would never fire.
 *
 * No vi.mock in this file: the SDK, AgentRegistry, RunRegistry and the agent
 * router under test are all real. HOME is pointed at a temp dir so session
 * transcripts (~/.agents/sessions/<sid>/transcript.json) stay hermetic.
 */

const STUB_ANSWER = "The deterministic answer."

function startStubProvider(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end()
      return
    }
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      let stream = false
      try {
        stream = Boolean(JSON.parse(raw).stream)
      } catch {
        stream = false
      }
      if (stream) {
        const chunks = [
          {
            id: "stub",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub-model",
            choices: [
              { index: 0, delta: { role: "assistant", content: STUB_ANSWER }, finish_reason: null },
            ],
          },
          {
            id: "stub",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ]
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            id: "stub",
            object: "chat.completion",
            created: 0,
            model: "stub-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: STUB_ANSWER },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        )
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` })
    })
  })
}

describe("SDK session compaction through the run router (issue #65, real SDK integration)", () => {
  let stubServer: Server
  let stubBaseUrl: string
  let homeBackup: string | undefined
  let homeDir: string

  beforeAll(async () => {
    // Isolate SDK session storage (~/.agents/sessions) into a temp HOME.
    homeDir = mkdtempSync(join(tmpdir(), "msq-integration-home-"))
    homeBackup = process.env.HOME
    process.env.HOME = homeDir
    ;({ server: stubServer, baseUrl: stubBaseUrl } = await startStubProvider())
  })

  afterAll(async () => {
    if (homeBackup === undefined) delete process.env.HOME
    else process.env.HOME = homeBackup
    rmSync(homeDir, { recursive: true, force: true })
    await new Promise<void>((resolve) => stubServer.close(() => resolve()))
  })

  it(
    "agents.yaml maxSessionQueries survives bodies without the field; 4th same-session query compacts",
    async () => {
      const configDir = mkdtempSync(join(tmpdir(), "msq-integration-cfg-"))
      try {
        // agents.yaml-equivalent config: the session cap comes from here ONLY.
        const registry = new AgentRegistry()
        await registry.loadFromConfig(
          {
            server: { host: "127.0.0.1", port: 3000 },
            agents: [
              {
                id: "compact-agent",
                description: "integration test agent",
                model: "stub-model",
                apiType: "openai-completions",
                apiKey: "integration-test-key",
                baseURL: stubBaseUrl,
                maxSessionQueries: 3,
                maxTurns: 2,
              },
            ],
          },
          configDir,
        )

        const runsRegistry = new RunRegistry()
        const app = new Hono()
        app.route("/v1/agents", createAgentRouter(registry, runsRegistry, new MetricsCollector()))

        const postRun = (message: string, sessionId?: string) =>
          app.request("/v1/agents/compact-agent/runs", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            // Run body deliberately omits maxSessionQueries (issue #65).
            body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
          })

        // Run 1: no sessionId yet — the runtime assigns one and returns it.
        const res1 = await postRun("first question")
        expect(res1.status).toBe(200)
        const text1 = await res1.text()
        const sidMatch = text1.match(/"session_id":"([0-9a-f-]{36})"/)
        expect(sidMatch).not.toBeNull()
        const sessionId = sidMatch![1]
        expect(text1).not.toContain("event: compact")

        // Runs 2-3: same session, still within the configured cap.
        const res2 = await postRun("second question", sessionId)
        const text2 = await res2.text()
        expect(res2.status).toBe(200)
        expect(text2).not.toContain("event: compact")

        const res3 = await postRun("third question", sessionId)
        const text3 = await res3.text()
        expect(res3.status).toBe(200)
        expect(text3).not.toContain("event: compact")

        // Run 4: 4th query in the session exceeds maxSessionQueries: 3 →
        // the engine compacts and the SSE stream carries the compact events.
        const res4 = await postRun("fourth question", sessionId)
        const text4 = await res4.text()
        expect(res4.status).toBe(200)
        expect(text4).toContain("event: compact")
        expect(text4).toContain('"phase":"progress"')
        expect(text4).toContain('"phase":"end"')
        // The run still completes normally after compaction.
        expect(text4).toContain("event: result")
        expect(text4).toContain("event: done")
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
