import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { AgentRegistry } from "../registry.js"
import { RunRegistry } from "../runs.js"
import { MetricsCollector } from "../metrics.js"
import { createAgentRouter } from "../router/agent.js"

/**
 * Issue #80 regression — "visible ⇒ executable" for materialized skills,
 * behavior-level against the REAL SDK, end-to-end through the HTTP run router:
 *
 *   agents.yaml sets settingSources: ["user"] → the runtime materializes
 *   ~/.agents/skills/<name>/SKILL.md into agent.capabilities.skills → the
 *   model issues a legal Skill tool call → the tool must execute and return
 *   the skill content, NOT `Error: Unknown skill "x". Available skills: none`.
 *
 * The gap this pins (agent-sdk#151, fixed in SDK 4.1.0): the SDK's root
 * resolveAgent path used the (empty) session skill registry for EXECUTION
 * while capabilities.skills drove VISIBILITY — so a listed skill was
 * unexecutable. Existing runtime tests (registry.test.ts /
 * subagent-isolation.test.ts) only assert the capabilities.skills list
 * shape, never an actual invocation, so they could not catch the split.
 *
 * No vi.mock in this file: SDK, AgentRegistry, RunRegistry and the agent
 * router are all real. HOME is pointed at a temp dir so both session
 * transcripts (~/.agents/sessions) and the user skill tree
 * (~/.agents/skills) stay hermetic. The deterministic LLM is a local stub
 * OpenAI-compatible server (127.0.0.1, ephemeral port) — no public network.
 */

const SKILL_NAME = "regression-skill"
const SKILL_MARKER = "REGRESSION-SKILL-BODY-MARKER"

/** OpenAI SSE chunk helpers. */
function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

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
      let body: any = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const stream = Boolean(body.stream)
      // Turn 2 = the conversation already carries a tool result (role: "tool").
      const sawToolResult = Array.isArray(body.messages)
        && body.messages.some((m: any) => m.role === "tool")
      const chunks = sawToolResult
        ? [
            {
              id: "stub",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub-model",
              choices: [
                { index: 0, delta: { role: "assistant", content: "skill loaded ok" }, finish_reason: null },
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
        : // Turn 1: emit a Skill tool_use for the materialized skill.
          [
            {
              id: "stub",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      { index: 0, id: "call_skill_1", type: "function", function: { name: "Skill", arguments: "" } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "stub",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: JSON.stringify({ skill: SKILL_NAME }) } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "stub",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub-model",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
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
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const chunk of chunks) res.write(sseChunk(chunk))
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        const flat = chunks.flatMap((c: any) => c.choices ?? [])
        const content = flat.map((c: any) => c.delta?.content ?? "").join("")
        const toolCalls = flat
          .flatMap((c: any) => c.delta?.tool_calls ?? [])
          .filter((tc: any) => tc.id)
          .map((tc: any) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" },
          }))
        const message: any = { role: "assistant", content: content || null }
        if (toolCalls.length > 0) message.tool_calls = toolCalls
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            id: "stub",
            object: "chat.completion",
            created: 0,
            model: "stub-model",
            choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
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

/** rmSync with retry: the SDK session store flushes transcripts asynchronously
 * (same race as hub-push #30), so files can land between readdir and unlink. */
async function rmRetryAsync(dir: string, attempts = 5, delayMs = 50): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

describe("materialized skill execution through the run router (issue #80, real SDK integration)", () => {
  let stubServer: Server
  let stubBaseUrl: string
  let homeBackup: string | undefined
  let homeDir: string
  let configDir: string

  beforeAll(async () => {
    // Isolate both ~/.agents/sessions (SDK session storage) and
    // ~/.agents/skills (user-level skill tree) into a temp HOME.
    homeDir = mkdtempSync(join(tmpdir(), "skill-exec-home-"))
    homeBackup = process.env.HOME
    process.env.HOME = homeDir
    // Plant a real user-level skill: the registry's materializeSkills scans
    // it via the SDK loader and flows the full definition into
    // agent.capabilities.skills.
    const skillDir = join(homeDir, ".agents", "skills", SKILL_NAME)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: regression skill for issue #80\n---\n\n${SKILL_MARKER}\n`,
      "utf8",
    )
    ;({ server: stubServer, baseUrl: stubBaseUrl } = await startStubProvider())
    configDir = mkdtempSync(join(tmpdir(), "skill-exec-cfg-"))
  })

  afterAll(async () => {
    if (homeBackup === undefined) delete process.env.HOME
    else process.env.HOME = homeBackup
    await rmRetryAsync(homeDir)
    await rmRetryAsync(configDir)
    await new Promise<void>((resolve) => stubServer.close(() => resolve()))
  })

  it(
    "root agent can actually invoke a materialized skill (no 'Available skills: none')",
    async () => {
      const registry = new AgentRegistry()
      await registry.loadFromConfig(
        {
          server: { host: "127.0.0.1", port: 3000 },
          agents: [
            {
              id: "skill-agent",
              description: "agent with a user-level skill",
              model: "stub-model",
              apiType: "openai-completions",
              apiKey: "integration-test-key",
              baseURL: stubBaseUrl,
              maxTurns: 3,
              settingSources: ["user"],
            },
          ],
        },
        configDir,
      )

      // The runtime must have materialized the skill (visible).
      const detail = registry.getDetail("skill-agent")!
      expect(detail.availableSkills?.map((s: any) => s.name)).toContain(SKILL_NAME)

      const runsRegistry = new RunRegistry()
      const app = new Hono()
      app.route("/v1/agents", createAgentRouter(registry, runsRegistry, new MetricsCollector()))

      const res = await app.request("/v1/agents/skill-agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: "use the regression skill" }),
      })
      expect(res.status).toBe(200)
      const text = await res.text()

      // Executable: the Skill tool ran and returned the skill body.
      // (SSE data is JSON-serialized, so inner quotes arrive backslash-escaped —
      // assert on escape-independent substrings.)
      expect(text).toContain("skill_content")
      expect(text).toContain(SKILL_NAME)
      expect(text).toContain(SKILL_MARKER)
      // The tool round-trip completed without error (tools_complete carries
      // per-tool is_error:false, not the pre-fix is_error:true).
      expect(text).toContain('"tool_name":"Skill","is_error":false')
      // The pre-fix failure mode must not appear.
      expect(text).not.toContain("Available skills: none")
      expect(text).not.toContain(`Unknown skill`)
      // The run completes normally after the tool round-trip.
      expect(text).toContain("event: done")
    },
    30_000,
  )
})
