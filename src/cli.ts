#!/usr/bin/env node
import { parseArgs } from "node:util"
import { discoverConfig, findConfigDir, type RuntimeConfig } from "./config.js"
import { createRuntime, resolveCronDataRoot } from "./runtime.js"
import { pathIdentity } from "./cron-identity.js"
import type { CronStatusPayload } from "./cron-identity.js"

export const CLI_EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CRON_DISABLED: 3,
  CONNECT: 4,
  MISMATCH: 5,
  NOT_FOUND: 6,
  SERVER: 7,
} as const

const USAGE = `Usage:
  zerone-agent [serve] [--config <dir>] [--port <port>]   start the HTTP runtime
  zerone-agent cron <command> [options]                   manage cron tasks online

Cron commands:
  list [--agent <id>] [--json]           list tasks
  get <task-id> [--json]                 show one task
  create --name <n> --cron <expr> --prompt <p> --agent <id> [--json]
  update <task-id> [--name|--cron|--prompt|--agent <v>] [--json]
  delete <task-id>
  run <task-id> [--json]                 trigger immediate execution (202)
  history [--task <id>] [--status <s>] [--json]

Common options:
  --server <url>    explicit runtime base URL (default: config server, 0.0.0.0 → 127.0.0.1)
  --json            machine-readable output
  --offline         NOT SUPPORTED YET (SDK maintenance session pending)
API key: env ZERONE_AGENT_HTTP_API_KEY or agents.yaml auth.apiKey (never a flag).`

function fail(msg: string, code: number): number {
  console.error(msg)
  return code
}

/**
 * Stop an HTTP server: stops accepting new connections and closes idle
 * keep-alive ones; resolves when all connections have closed. Structural
 * feature-detect because @hono/node-server returns an http1/http2
 * ServerType union and closeIdleConnections is not declared on every arm.
 */
export function closeHttpServer(server: { close(cb?: () => void): unknown }): Promise<void> {
  return new Promise<void>((resolve) => {
    ;(server as { closeIdleConnections?: () => void }).closeIdleConnections?.()
    server.close(() => resolve())
  })
}

/**
 * Graceful-shutdown orchestrator: stop accepting new connections FIRST
 * (closeServer), then drain runs + cron (stopHost) in parallel with the
 * connection close-out, and exit only after both settle. Exported for testing.
 */
export function buildShutdown(opts: {
  closeServer: () => Promise<void>
  stopHost: () => Promise<void>
  exit: (code: number) => void
}): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    const serverClosed = opts.closeServer() // FIRST: stop accepting new connections
    const hostStopped = opts.stopHost() // then drain runs + cron in parallel with connection close-out
    Promise.allSettled([serverClosed, hostStopped]).then((results) => {
      const failed = results.filter((r) => r.status === "rejected")
      if (failed.length > 0) {
        for (const r of failed as PromiseRejectedResult[]) {
          console.error(`Shutdown step failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
        opts.exit(1)
        return
      }
      opts.exit(0)
    })
  }
}

async function serveCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
    },
    strict: false,
    args: argv,
  })

  const configDir = findConfigDir(values.config as string | undefined)
  const config = await discoverConfig(configDir)
  if (values.port) config.server.port = parseInt(values.port as string, 10)

  console.log(`Loading config from: ${configDir}`)
  console.log(`Agents: ${config.agents.map((a) => a.id).join(", ")}`)

  const host = await createRuntime(config, { configDir })
  await host.start() // cron lock+recovery+scheduler BEFORE listening

  const { serve } = await import("@hono/node-server")
  const server = serve(
    { fetch: host.app.fetch, port: config.server.port, hostname: config.server.host },
    (info: { address: string; port: number }) => {
      console.log(`agent-runtime listening on http://${info.address}:${info.port}`)
    },
  )

  const shutdown = buildShutdown({
    // host.stop() owns the shutdown gate: it begins rejecting new mutations
    // synchronously (503 shutting_down) and drains in-flight ones before
    // touching Run/Cron state.
    closeServer: () => closeHttpServer(server),
    stopHost: () => host.stop(),
    exit: (code) => process.exit(code),
  })
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  return CLI_EXIT.OK
}

interface OnlineContext {
  baseUrl: string
  apiKey?: string
  localConfigId: string
  localDataId: string
  json: boolean
}

async function buildContext(argv: string[], config: RuntimeConfig, configDir: string): Promise<OnlineContext> {
  const host = (config.server.host === "0.0.0.0" || config.server.host === "::")
    ? "127.0.0.1"
    : config.server.host
  return {
    baseUrl: (argv.find((_, i) => argv[i - 1] === "--server") ?? `http://${host}:${config.server.port}`) as string,
    apiKey: process.env.ZERONE_AGENT_HTTP_API_KEY ?? config.auth?.apiKey,
    localConfigId: pathIdentity(configDir),
    localDataId: pathIdentity(resolveCronDataRoot(config, configDir)),
    json: argv.includes("--json"),
  }
}

function authHeaders(ctx: OnlineContext): Record<string, string> {
  return ctx.apiKey ? { "x-api-key": ctx.apiKey } : {}
}

type FetchResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; kind: "connect" }

async function call(ctx: OnlineContext, path: string, init?: RequestInit): Promise<FetchResult> {
  let res: Response
  let text: string
  try {
    res = await fetch(`${ctx.baseUrl}${path}`, { ...init, headers: { ...authHeaders(ctx), ...(init?.headers ?? {}) } })
    text = await res.text()
  } catch {
    // Transport failure only (fetch itself or body read): server unreachable.
    return { ok: false, kind: "connect" }
  }
  // Decode failure is NOT a connection failure: the server is reachable but
  // returned a non-JSON body. Surface it as a reachable response with a null
  // body; guardWrite rejects invalid payloads with SERVER, not CONNECT.
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { ok: true, status: res.status, body }
}

/** Write-guard: server online, cron enabled, and configId/dataId match this config. */
async function guardWrite(ctx: OnlineContext): Promise<number | null> {
  const status = await call(ctx, "/v1/cron/status")
  if (!status.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
  if (status.status !== 200) return fail(`Runtime server rejected status probe (HTTP ${status.status})`, CLI_EXIT.SERVER)
  if (!status.body || typeof status.body !== "object")
    return fail("Runtime server returned an invalid status payload", CLI_EXIT.SERVER)
  const payload = status.body as CronStatusPayload
  if (!payload.enabled) return fail("Cron is disabled on the runtime (cron_disabled)", CLI_EXIT.CRON_DISABLED)
  if (payload.configId !== ctx.localConfigId || payload.dataId !== ctx.localDataId) {
    return fail(
      "Instance identity mismatch: the server manages a different config/cron directory (instance_mismatch)",
      CLI_EXIT.MISMATCH,
    )
  }
  return null
}

function exitCodeFromStatus(status: number): number {
  if (status === 404) return CLI_EXIT.NOT_FOUND
  if (status === 503) return CLI_EXIT.CRON_DISABLED
  if (status >= 500) return CLI_EXIT.SERVER
  if (status === 400 || status === 409) return CLI_EXIT.USAGE
  return CLI_EXIT.ERROR
}

function printResult(ctx: OnlineContext, body: unknown) {
  if (ctx.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  // Human output: simple table for arrays of records, key:value otherwise.
  if (Array.isArray(body)) printTable(ctx, body as Record<string, unknown>[])
  else if (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
    printTable(ctx, (body as { items: Record<string, unknown>[] }).items)
  } else {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) console.log(`${k}: ${v}`)
  }
}

function printTable(ctx: OnlineContext, rows: Record<string, unknown>[]): void {
  const cols = ["id", "name", "cron", "agentId", "status", "scheduledFireTime"].filter((c) =>
    rows.some((r) => r[c] !== undefined),
  )
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)))
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "))
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  "))
}

async function cronCommand(argv: string[]): Promise<number> {
  if (argv.includes("--offline")) {
    return fail(
      "offline_not_supported: offline CLI requires withCronMaintenanceSession (SDK issue #52); use online mode",
      CLI_EXIT.USAGE,
    )
  }

  const configDir = findConfigDir(undefined)
  const config = await discoverConfig(configDir)
  const ctx = await buildContext(argv, config, configDir)

  const flags = parseArgs({
    options: {
      server: { type: "string" },
      json: { type: "boolean" },
      offline: { type: "boolean" },
      agent: { type: "string" }, task: { type: "string" }, status: { type: "string" },
      name: { type: "string" }, cron: { type: "string" }, prompt: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
    args: argv,
  })
  const positional = flags.positionals ?? [] // [subcommand, <id>?, ...]
  const cmd = positional[0]

  switch (cmd) {
    case "list": {
      const params = new URLSearchParams()
      if (flags.values.agent) params.set("agentId", String(flags.values.agent))
      const qs = params.toString()
      const res = await call(ctx, `/v1/cron/tasks${qs ? `?${qs}` : ""}`)
      if (!res.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
      if (res.status !== 200) return fail(String((res.body as { error?: string })?.error ?? "list failed"), exitCodeFromStatus(res.status))
      printResult(ctx, res.body)
      return CLI_EXIT.OK
    }
    case "get": {
      const id = positional[1]
      if (!id) return fail("Usage: zerone-agent cron get <task-id>", CLI_EXIT.USAGE)
      const res = await call(ctx, `/v1/cron/tasks/${encodeURIComponent(id)}`)
      if (!res.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
      if (res.status === 404) return fail(`Task not found: ${id}`, CLI_EXIT.NOT_FOUND)
      if (res.status !== 200) return fail(String((res.body as { error?: string })?.error ?? "get failed"), exitCodeFromStatus(res.status))
      printResult(ctx, res.body)
      return CLI_EXIT.OK
    }
    case "create": {
      const guard = await guardWrite(ctx)
      if (guard !== null) return guard
      const { name, cron, prompt, agent } = flags.values as Record<string, string | undefined>
      if (!cron || !prompt || !agent) {
        return fail("create requires --cron, --prompt and --agent", CLI_EXIT.USAGE)
      }
      const res = await call(ctx, "/v1/cron/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, cron, prompt, agentId: agent }),
      })
      if (!res.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
      if (res.status !== 201) return fail(String((res.body as { error?: string })?.error ?? "create failed"), exitCodeFromStatus(res.status))
      printResult(ctx, res.body)
      return CLI_EXIT.OK
    }
    case "update": {
      const id = positional[1]
      if (!id) return fail("Usage: zerone-agent cron update <task-id> [--name|--cron|--prompt|--agent <v>]", CLI_EXIT.USAGE)
      const guard = await guardWrite(ctx)
      if (guard !== null) return guard
      const { name, cron, prompt, agent } = flags.values as Record<string, string | undefined>
      const changes: Record<string, string> = {}
      if (name !== undefined) changes.name = name
      if (cron !== undefined) changes.cron = cron
      if (prompt !== undefined) changes.prompt = prompt
      if (agent !== undefined) changes.agentId = agent
      const res = await call(ctx, `/v1/cron/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      })
      if (!res.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
      if (res.status === 404) return fail(`Task not found: ${id}`, CLI_EXIT.NOT_FOUND)
      if (res.status !== 200) return fail(String((res.body as { error?: string })?.error ?? "update failed"), exitCodeFromStatus(res.status))
      printResult(ctx, res.body)
      return CLI_EXIT.OK
    }
    case "delete": {
      const id = positional[1]
      if (!id) return fail("Usage: zerone-agent cron delete <task-id>", CLI_EXIT.USAGE)
      const guard = await guardWrite(ctx)
      if (guard !== null) return guard
      const res = await call(ctx, `/v1/cron/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
      if (!res.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
      if (res.status === 404) return fail(`Task not found: ${id}`, CLI_EXIT.NOT_FOUND)
      if (res.status !== 204) return fail(String((res.body as { error?: string })?.error ?? "delete failed"), exitCodeFromStatus(res.status))
      if (ctx.json) console.log(JSON.stringify({ deleted: true, id }, null, 2))
      else console.log(`Deleted ${id}`)
      return CLI_EXIT.OK
    }
    case "run": {
      const id = positional[1]
      if (!id) return fail("Usage: zerone-agent cron run <task-id>", CLI_EXIT.USAGE)
      const guard = await guardWrite(ctx)
      if (guard !== null) return guard
      const res = await call(ctx, `/v1/cron/tasks/${encodeURIComponent(id)}/run`, { method: "POST" })
      if (!res.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
      if (res.status === 404) return fail(`Task not found: ${id}`, CLI_EXIT.NOT_FOUND)
      if (res.status !== 202) return fail(String((res.body as { error?: string })?.error ?? "run failed"), exitCodeFromStatus(res.status))
      printResult(ctx, res.body) // { executionId, status }
      return CLI_EXIT.OK
    }
    case "history": {
      const params = new URLSearchParams()
      if (flags.values.task) params.set("taskId", String(flags.values.task))
      if (flags.values.status) params.set("status", String(flags.values.status))
      const qs = params.toString()
      const res = await call(ctx, `/v1/cron/executions${qs ? `?${qs}` : ""}`)
      if (!res.ok) return fail("Cannot reach runtime server", CLI_EXIT.CONNECT)
      if (res.status !== 200) return fail(String((res.body as { error?: string })?.error ?? "history failed"), exitCodeFromStatus(res.status))
      printResult(ctx, res.body)
      return CLI_EXIT.OK
    }
    default:
      return fail(`Unknown cron command: ${cmd ?? "(none)"}\n${USAGE}`, CLI_EXIT.USAGE)
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd] = argv
  // Help must be checked before the serve flag fallback: "--help"/"-h" also
  // start with "-", so the fallback would otherwise swallow them into serve.
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE)
    return CLI_EXIT.OK
  }
  if (cmd === undefined || cmd === "serve" || cmd.startsWith("-")) {
    return serveCommand(argv)
  }
  if (cmd === "cron") {
    return cronCommand(argv.slice(1))
  }
  return fail(`Unknown command: ${cmd}\n${USAGE}`, CLI_EXIT.USAGE)
}
