import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDefaultCronService } from "@zerone-agent/agent-sdk/cron/node"
import { createAgent, type DiagnosticsSink } from "@zerone-agent/agent-sdk"

/**
 * Issue #63 BEHAVIORAL acceptance tests (review follow-up): real SDK, no
 * mocks. Three previously identity-only contracts are now executed:
 *
 *  1. Cron replay diagnostics (torn execution-log tail) enter the injected
 *     sink through the composed [cron] channel — deterministically, without
 *     waiting for a scheduled fire.
 *  2. A failing cron event sink reports 'cron event sink failed' into the
 *     diagnostics sink with sanitized fields + RAW cause separation.
 *  3. A subagent ACTUALLY spawned via the Task tool inherits the parent's
 *     construction sink (its resolution diagnostics land there, not in an
 *     independent console sink), while the engine-scoped QueryOverrides
 *     logger never re-binds the construction channel (SDK #78 R5).
 */

interface CapturedCall {
  level: "debug" | "trace" | "warn" | "error"
  msg: string
  fields?: Record<string, unknown>
  cause?: unknown
}

function captureSink(): DiagnosticsSink & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const record =
    (level: CapturedCall["level"]) =>
    (msg: string, fields?: Record<string, unknown>, cause?: unknown) => {
      calls.push({ level, msg, fields, cause })
    }
  const sink: DiagnosticsSink & { calls: CapturedCall[] } = {
    calls,
    debug: record("debug"),
    trace: record("trace"),
    warn: record("warn"),
    error: record("error"),
    child: () => sink,
  }
  return sink
}

const UNUSED_RESOLVER = async () => {
  throw new Error("unused")
}

describe("cron diagnostics enter the injected sink (real service, issue #63)", () => {
  it("torn execution-log tail is reported through the [cron] channel on replay", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "diag-cron-torn-"))
    const sink = captureSink()
    // Corrupt tail: a partial JSON record with NO trailing newline — replay
    // must recover and report "ignored incomplete trailing record" instead
    // of throwing (deterministic, no scheduled fire needed).
    mkdirSync(join(dataDir, "cron"), { recursive: true })
    writeFileSync(join(dataDir, "cron", "executions.jsonl"), '{"id":"torn-record-without-newline')

    const service = createDefaultCronService({
      dataDir,
      diagnostics: sink,
      resolveAgent: UNUSED_RESOLVER,
    })
    try {
      await service.start()
      // Force the execution store load + replay if startup recovery didn't.
      await service.listExecutions()

      const reported = sink.calls.filter(
        (c) => c.level === "warn" && c.msg.includes("[cron]"),
      )
      expect(reported.length).toBeGreaterThanOrEqual(1)
      const text = JSON.stringify(reported.map((c) => c.msg))
      expect(
        text.includes("ignored incomplete trailing record") ||
          text.includes("repaired log tail"),
      ).toBe(true)
    } finally {
      await service.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("a failing cron event sink reports 'cron event sink failed' with sanitized fields + raw cause", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "diag-cron-events-"))
    const sink = captureSink()
    const service = createDefaultCronService({
      dataDir,
      diagnostics: sink,
      // Best-effort delivery contract: a broken event sink must surface via
      // the diagnostics channel (events.js: 'cron event sink failed', err).
      events: () => {
        throw new Error("event sink boom")
      },
      resolveAgent: UNUSED_RESOLVER,
    })
    try {
      await service.start()
      await service.create({ cron: "0 18 * * *", prompt: "integration" })

      const failures = sink.calls.filter(
        (c) => c.level === "warn" && c.msg.includes("cron event sink failed"),
      )
      expect(failures.length).toBeGreaterThanOrEqual(1)
      const call = failures[0]
      // Safe summary: stable errorType only.
      expect(typeof call.fields?.errorType).toBe("string")
      // Raw cause travels separately — object identity, never in the text.
      expect(call.cause).toBeInstanceOf(Error)
      expect((call.cause as Error).message).toBe("event sink boom")
      expect(JSON.stringify({ m: call.msg, f: call.fields })).not.toContain("event sink boom")
    } finally {
      await service.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe("subagent diagnostics inheritance + query-logger scoping (real SDK, issue #63)", () => {
  let homeBackup: string | undefined
  let homeDir: string

  beforeAll(() => {
    // Isolate SDK session storage (~/.agents/sessions).
    homeDir = mkdtempSync(join(tmpdir(), "diag-sub-home-"))
    homeBackup = process.env.HOME
    process.env.HOME = homeDir
  })

  afterAll(() => {
    if (homeBackup === undefined) delete process.env.HOME
    else process.env.HOME = homeBackup
    rmSync(homeDir, { recursive: true, force: true })
  })

  /**
   * Deterministic OpenAI-compatible stub, ONE PER SCENARIO (independent
   * request counter): request #1 → Task tool_call spawning subagent
   * "child-r"; requests ≥2 → plain text. Handles BOTH stream
   * (createMessageStream) and non-stream (createMessage) request shapes.
   */
  function startStub(): Promise<{ server: Server; baseUrl: string }> {
    let requestCount = 0
    const taskArgs = JSON.stringify({
      // Task tool schema: subagent_type is the MODE enum ('Explore'|
      // 'General'); the registered child name goes in subagent_name;
      // description is required.
      subagent_type: "General",
      subagent_name: "child-r",
      prompt: "go",
      description: "test task",
    })
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
        requestCount++
        let stream = false
        try {
          stream = Boolean(JSON.parse(raw).stream)
        } catch {
          stream = false
        }
        const sse = (chunks: Array<Record<string, unknown>>) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          res.write("data: [DONE]\n\n")
          res.end()
        }
        const json = (body: Record<string, unknown>) => {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(body))
        }
        const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
        if (requestCount === 1) {
          const toolCallMessage = {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "Task", arguments: taskArgs } }],
          }
          if (!stream) {
            json({
              id: "stub",
              object: "chat.completion",
              created: 0,
              model: "stub-model",
              choices: [{ index: 0, message: toolCallMessage, finish_reason: "tool_calls" }],
              usage,
            })
            return
          }
          sse([
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
                    tool_calls: [
                      { index: 0, id: "call_1", type: "function", function: { name: "Task", arguments: "" } },
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
                  delta: { tool_calls: [{ index: 0, function: { arguments: taskArgs } }] },
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
              usage,
            },
          ])
          return
        }
        // requests >= 2: plain text answers.
        if (!stream) {
          json({
            id: "stub",
            object: "chat.completion",
            created: 0,
            model: "stub-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "stub answer" },
                finish_reason: "stop",
              },
            ],
            usage,
          })
          return
        }
        sse([
          {
            id: "stub",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub-model",
            choices: [
              { index: 0, delta: { role: "assistant", content: "stub answer" }, finish_reason: null },
            ],
          },
          {
            id: "stub",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          },
        ])
      })
    })
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo
        resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` })
      })
    })
  }

  /** Root agent + a restrictive child whose allowedTools wildcard matches
   *  NOTHING — spawning it deterministically emits the '[tools] agent
   *  resolved to zero tools' diagnostics the scenarios assert on. */
  function buildAgent(baseURL: string, logger: DiagnosticsSink) {
    return createAgent({
      model: "stub-model",
      apiType: "openai-completions",
      apiKey: "integration-test-key",
      baseURL,
      logger,
      agent: { description: "root", prompt: "Run the task." },
      subAgents: {
        "child-r": {
          description: "restrictive child",
          prompt: "p",
          capabilities: { allowedTools: ["Nope*"] },
        },
      },
    })
  }

  /**
   * Shared scenario runner (review R2, Standards): owns the stub server,
   * the console spies and the agent lifecycle in ONE place. Every resource
   * is released in `finally` — an assertion failure can no longer leak an
   * open server handle and hang the suite. The console snapshot is
   * captured BEFORE `mockRestore()` (restore resets mock state, so reading
   * `mock.calls` afterwards would be vacuously empty — a false pass).
   * `console.debug` is spied too: it is the SDK default sink's gated
   * channel for debug/trace output.
   */
  async function runSubagentScenario(opts: {
    agentLogger: DiagnosticsSink
    queryLogger?: DiagnosticsSink
  }): Promise<{ eventTypes: string[]; consoleText: string }> {
    const { server, baseUrl } = await startStub()
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ]
    const agent = buildAgent(baseUrl, opts.agentLogger)
    const eventTypes: string[] = []
    let consoleText = ""
    try {
      // No `as never` (review R2, Standards): the overrides must typecheck
      // against the SDK's public QueryOverrides — a DiagnosticsSink is a
      // Logger superset and is accepted as the engine-scoped logger.
      const overrides = opts.queryLogger ? { logger: opts.queryLogger } : undefined
      for await (const ev of agent.query("run it", overrides)) {
        eventTypes.push(ev.type)
      }
    } finally {
      await agent.close().catch(() => {})
      // Snapshot console calls BEFORE restoring (restore clears them).
      consoleText = JSON.stringify(spies.flatMap((s) => s.mock.calls))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const s of spies) s.mockRestore()
    }
    return { eventTypes, consoleText }
  }

  it(
    "acceptance 4, behavioral: spawned child inherits the construction sink (no separate console sink)",
    async () => {
      const sink = captureSink()
      const { eventTypes, consoleText } = await runSubagentScenario({ agentLogger: sink })

      // Task tool_use → child spawn → child answer → root final answer all
      // completed against the deterministic stub.
      expect(eventTypes).toContain("subagent")
      expect(eventTypes).toContain("result")

      // The SPAWNED child's resolution diagnostics reached the parent's
      // construction sink — the inherited channel.
      const zeroTools = sink.calls.filter((c) => c.msg.includes("agent resolved to zero tools"))
      expect(zeroTools.length).toBeGreaterThanOrEqual(1)

      // No independent console sink: had the child NOT inherited the sink,
      // the zero-tools warning would have gone to the default console sink.
      // (Snapshot taken pre-restore, so this is a real assertion.)
      expect(consoleText).not.toContain("zero tools")
    },
    30_000,
  )

  it(
    "acceptance 6, behavioral: a query logger takes over the engine channel without re-binding the construction sink",
    async () => {
      // SDK #78 R5 semantics (agent.js: engineLogger = opts.logger ??
      // cfg.logger): a per-query logger REPLACES the engine's diagnostics
      // channel for that query — including the tool-executor context the
      // Task tool forwards to spawned children — while the construction
      // sink keeps the Agent-lifetime channels (provider/MCP/skills) and is
      // never re-bound.
      const constructionSink = captureSink()
      const querySink = captureSink()
      const { eventTypes } = await runSubagentScenario({
        agentLogger: constructionSink,
        queryLogger: querySink,
      })
      expect(eventTypes).toContain("result")

      // Engine channel takeover: the child's zero-tools diagnostics followed
      // the query logger for that query, NOT the construction sink.
      expect(
        querySink.calls.some((c) => c.msg.includes("agent resolved to zero tools")),
      ).toBe(true)
      expect(
        constructionSink.calls.some((c) => c.msg.includes("agent resolved to zero tools")),
      ).toBe(false)
    },
    30_000,
  )
})
