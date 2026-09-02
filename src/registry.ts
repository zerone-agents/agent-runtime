import {
  createAgent,
  type Agent,
  type AgentDefinition as SdkAgentDefinition,
  type CronService,
  type SkillDefinition,
  type ToolDefinition,
} from "@zerone-agent/agent-sdk"
import { resolve } from "node:path"
import type { AgentDefinition, RuntimeConfig } from "./config.js"
import { resolveSystemPrompt } from "./config.js"
import { materializeSkills, toSummaries, type SkillSummary } from "./skills.js"
import { loadToolFiles } from "./tools/loader.js"
import { McpConnectionError, McpConnectionManager } from "./mcp-connections.js"

/**
 * Phase-1 materialization product for one agents.yaml entry (issue #47): the
 * entry's COMPLETE Agent-local capability set. Never mixed with another
 * entry's assets — root agents and mounted children are both projected from
 * their own MaterializedEntry via toSdkDefinition.
 */
interface MaterializedEntry {
  description: string
  prompt: string
  maxTurns: number
  connectionTools: ToolDefinition[]
  customTools: ToolDefinition[]
  skills: SkillDefinition[]
  allowedTools?: string[]
  disallowedTools?: string[]
}

export interface AgentInfo {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  toolCount: number
}

export interface McpServerSummary {
  transport: "stdio" | "sse" | "http"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Live connection state from the runtime-owned manager (issue #47 §4). */
  connectionStatus?: "connected" | "error"
  /** True when other entries share this connection (identical config). */
  shared?: boolean
}

export interface AgentDetail {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  maxTurns: number
  maxSessionTurns?: number
  hasSystemPrompt: boolean
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  availableSkills?: SkillSummary[]
  settingSources?: string[]
  extraUserSkillDirs?: string[]
  mcpServers?: Record<string, McpServerSummary>
  subagents?: Array<{ agent_id: string; description: string }>
  datasets?: Record<string, string>
  fileTools?: string[]
  /** Sanitized reason when status is unavailable (issue #47 §4). */
  unavailableReason?: string
}

type CreateOpts = Parameters<typeof createAgent>[0]

export class AgentRegistry {
  private defs = new Map<string, AgentDefinition>()
  private createOpts = new Map<string, CreateOpts>()
  private statuses = new Map<string, "ready" | "unavailable">()
  private scannedSkills = new Map<string, SkillSummary[]>()
  private fileToolNames = new Map<string, string[]>()
  private cronService?: CronService
  private materialized = new Map<string, MaterializedEntry>()
  private unavailableReasons = new Map<string, string>()
  private mcp = new McpConnectionManager()

  register(id: string, def: AgentDefinition, opts: CreateOpts): void {
    this.defs.set(id, def)
    this.createOpts.set(id, opts)
    this.statuses.set(id, "ready")
  }

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
    // ------------------------------------------------------------------
    // Transactional load (review finding): a reload must atomically replace
    // the previous state — agents deleted from the config and their
    // connections must not linger. All new state is built in fresh
    // containers and committed in one swap; on an unexpected whole-load
    // failure the partial new state is discarded and the previous registry
    // stays intact.
    // ------------------------------------------------------------------
    const mcp = new McpConnectionManager()
    const defs = new Map<string, AgentDefinition>()
    const statuses = new Map<string, "ready" | "unavailable">()
    const unavailableReasons = new Map<string, string>()
    const materialized = new Map<string, MaterializedEntry>()
    const scannedSkills = new Map<string, SkillSummary[]>()
    const fileToolNames = new Map<string, string[]>()

    try {
      // ----------------------------------------------------------------
      // Phase 1: materialize each entry's Agent-local assets independently
      // (issue #47 §2). A failure marks ONLY this entry unavailable; other
      // entries and shared connections are unaffected.
      // ----------------------------------------------------------------
      const failedEntryIds: string[] = []
      for (const def of config.agents) {
        defs.set(def.id, def)
        try {
          const entry = await this.materializeEntry(def, configDir, mcp)
          materialized.set(def.id, entry)
          const summaries = toSummaries(entry.skills)
          if (summaries.length > 0) {
            scannedSkills.set(def.id, summaries)
          }
          if (entry.customTools.length > 0) {
            fileToolNames.set(def.id, entry.customTools.map((t) => t.name))
          }
          statuses.set(def.id, "ready")
        } catch (err) {
          const reason =
            err instanceof McpConnectionError
              ? err.message
              : err instanceof Error
                ? err.message
                : "materialization failed"
          statuses.set(def.id, "unavailable")
          unavailableReasons.set(def.id, reason)
          failedEntryIds.push(def.id)
          console.error(`Failed to configure agent "${def.id}": ${reason}`)
        }
      }

      // Roll back failed entries' connection refs AFTER the full pass, when
      // every entry's refs are known: a connection shared with any
      // successful entry survives; connections that served only failed
      // entries are closed instead of leaking until shutdown (review
      // finding).
      for (const failedId of failedEntryIds) {
        await mcp.release(failedId)
      }

      // ----------------------------------------------------------------
      // Phase 2: assemble root CreateOpts. Mounted-child usability is
      // phase-1 materialization success (materialized.has) — NEVER the
      // mutable statuses — so assembly is independent of config order: an
      // entry whose own root assembly failed can still be mounted by its
      // parent (its phase-1 capabilities are complete; its own subagent
      // references are irrelevant at delegation depth 1).
      // ----------------------------------------------------------------
      const createOpts = new Map<string, CreateOpts>()
      for (const def of config.agents) {
        if (statuses.get(def.id) !== "ready") continue
        const own = materialized.get(def.id)!
        let subAgents: Record<string, SdkAgentDefinition> | undefined
        if (def.subagents?.length) {
          subAgents = {}
          let failed: string | undefined
          for (const id of def.subagents) {
            const child = materialized.get(id)
            if (!child) {
              failed = id
              break
            }
            subAgents[id] = this.toSdkDefinition(child)
          }
          if (failed !== undefined) {
            // Explicit failure — never silently mount an empty-capability child.
            statuses.set(def.id, "unavailable")
            unavailableReasons.set(def.id, `subagent "${failed}" unavailable`)
            continue
          }
        }
        createOpts.set(
          def.id,
          this.buildCreateOpts(def, this.toSdkDefinition(own), subAgents),
        )
      }

      // Commit: swap all state at once, then release the previous load's
      // connections.
      const previousMcp = this.mcp
      this.mcp = mcp
      this.defs = defs
      this.statuses = statuses
      this.unavailableReasons = unavailableReasons
      this.materialized = materialized
      this.scannedSkills = scannedSkills
      this.fileToolNames = fileToolNames
      this.createOpts = createOpts
      await previousMcp.closeAll()
    } catch (err) {
      // Whole-load failure (defensive — per-entry errors are contained
      // above): discard the partial new state, keep the previous registry.
      await mcp.closeAll()
      throw err
    }
  }

  /**
   * Phase 1 helper: materialize ONE entry's Agent-local assets — resolved
   * prompt (own datasets injected), MCP connectionTools via the manager,
   * file customTools, and the full skill set. Throws on failure; state
   * mutation is limited to the manager's connection refs (rolled back by
   * the caller for failed entries).
   */
  private async materializeEntry(
    def: AgentDefinition,
    configDir: string,
    mcp: McpConnectionManager,
  ): Promise<MaterializedEntry> {
    const prompt = resolveSystemPrompt(def, configDir) ?? ""

    // Connect this entry's OWN MCP servers via the runtime-owned manager
    // (config-key dedup; failure throws a sanitized error).
    const connectionTools: ToolDefinition[] = []
    if (def.mcpServers) {
      for (const [name, cfg] of Object.entries(def.mcpServers)) {
        const conn = await mcp.acquire(def.id, name, cfg as Record<string, unknown>)
        connectionTools.push(...conn.tools)
      }
    }

    // Load this entry's file tools (relative paths anchor to configDir).
    const customTools = def.customTools?.length
      ? await loadToolFiles(def.customTools.map((p) => resolve(configDir, p)))
      : []

    // Materialize the entry's full skill set — agent-local by construction;
    // the SDK session-registry view never applies.
    const skills = await materializeSkills({
      cwd: process.cwd(),
      settingSources: def.settingSources,
      extraUserSkillDirs: def.extraUserSkillDirs,
    })

    return {
      description: def.description,
      prompt,
      maxTurns: def.maxTurns,
      connectionTools,
      customTools,
      skills,
      allowedTools: def.allowedTools,
      disallowedTools: def.disallowedTools,
    }
  }

  /** Phase 2 helper: root CreateOpts from the entry's SDK definition. */
  private buildCreateOpts(
    def: AgentDefinition,
    agent: SdkAgentDefinition,
    subAgents?: Record<string, SdkAgentDefinition>,
  ): CreateOpts {
    return {
      model: process.env.ZERONE_AGENT_MODEL ?? def.model,
      apiType: (process.env.ZERONE_AGENT_API_TYPE as any) ?? (def.apiType as any) ?? undefined,
      apiKey: process.env.ZERONE_AGENT_API_KEY ?? def.apiKey ?? undefined,
      baseURL: process.env.ZERONE_AGENT_BASE_URL ?? def.baseURL ?? undefined,
      agent,
      maxSessionTurns: def.maxSessionTurns,
      permissionMode: def.permissionMode,
      thinking: def.thinking as any,
      ...(subAgents ? { subAgents } : {}),
    }
  }

  /**
   * Uniform SDK AgentDefinition projection for root agents AND mounted
   * children (#47): capabilities are strictly Agent-local (own MCP tools,
   * own file tools, own skills, own policy) — never inherited, never
   * merged. No subAgents field: delegation depth is structurally 1.
   */
  private toSdkDefinition(m: MaterializedEntry): SdkAgentDefinition {
    return {
      description: m.description,
      prompt: m.prompt,
      maxTurns: m.maxTurns,
      capabilities: {
        connectionTools: m.connectionTools,
        customTools: m.customTools,
        skills: m.skills,
        ...(m.allowedTools ? { allowedTools: m.allowedTools } : {}),
        ...(m.disallowedTools ? { disallowedTools: m.disallowedTools } : {}),
      },
    }
  }

  create(agentId: string, sessionId?: string): Agent | undefined {
    const opts = this.createOpts.get(agentId)
    if (!opts) return undefined
    if (this.statuses.get(agentId) !== "ready") return undefined

    const base = this.cronService ? { ...opts, cronService: this.cronService } : opts
    const merged = sessionId ? { ...base, resume: sessionId } : base
    return createAgent(merged)
  }

  /** Single RuntimeCronService shared by HTTP runs, CLI and Agent Tools. Set by the runtime host after wrapping. */
  setCronService(service: CronService | undefined): void {
    this.cronService = service
  }

  /**
   * Latest AgentOptions for an agent, with cronService injected (issue #21).
   * Used by the SDK default cron executor's resolveAgent on every fire so
   * long-lived tasks always run the current config; credentials/models are
   * never persisted in tasks. Returns undefined when unknown or unavailable.
   */
  async resolveOptions(
    agentId: string,
    options?: { cronService?: CronService },
  ): Promise<CreateOpts | undefined> {
    const opts = this.createOpts.get(agentId)
    if (!opts || this.statuses.get(agentId) !== "ready") return undefined
    const cronService = options?.cronService ?? this.cronService
    return cronService ? { ...opts, cronService } : { ...opts }
  }

  getStatus(agentId: string): "ready" | "unavailable" | "not_found" {
    return this.statuses.get(agentId) ?? "not_found"
  }

  getModel(agentId: string): string | undefined {
    const def = this.defs.get(agentId)
    if (!def) return undefined
    return process.env.ZERONE_AGENT_MODEL ?? def.model ?? undefined
  }

  getDetail(agentId: string): AgentDetail | null {
    const def = this.defs.get(agentId)
    if (!def) return null

    const status = this.statuses.get(agentId) ?? "unavailable"
    const detail: AgentDetail = {
      id: def.id,
      name: def.name ?? def.id,
      model: def.model ?? "",
      status,
      maxTurns: def.maxTurns ?? 10,
      hasSystemPrompt: Boolean(def.systemPrompt || def.systemPromptFile),
    }
    if (status === "unavailable") {
      const reason = this.unavailableReasons.get(agentId)
      if (reason !== undefined) detail.unavailableReason = reason
    }
    if (def.permissionMode !== undefined) detail.permissionMode = def.permissionMode
    if (def.maxSessionTurns !== undefined) detail.maxSessionTurns = def.maxSessionTurns
    if (def.allowedTools !== undefined) detail.allowedTools = def.allowedTools
    if (def.disallowedTools !== undefined) detail.disallowedTools = def.disallowedTools
    const scanned = this.scannedSkills.get(agentId)
    if (scanned !== undefined) detail.availableSkills = scanned
    if (def.settingSources !== undefined) detail.settingSources = def.settingSources
    if (def.extraUserSkillDirs !== undefined) detail.extraUserSkillDirs = def.extraUserSkillDirs
    const mcp = sanitizeMcpServers(def.mcpServers)
    if (mcp !== undefined) {
      // Merge live per-server connection state from the manager (#47 §4).
      const described = new Map(
        this.mcp.describe(agentId).map((d) => [d.name, d] as const),
      )
      for (const [name, summary] of Object.entries(mcp)) {
        const d = described.get(name)
        if (d) {
          summary.connectionStatus = d.status === "connected" ? "connected" : "error"
          summary.shared = d.shared
        }
      }
      detail.mcpServers = mcp
    }
    if (def.subagents !== undefined) {
      detail.subagents = def.subagents.map((id) => ({
        agent_id: id,
        description: this.defs.get(id)?.description ?? "",
      }))
    }
    if (def.datasets !== undefined) detail.datasets = def.datasets
    const fileTools = this.fileToolNames.get(def.id)
    if (fileTools && fileTools.length > 0) detail.fileTools = fileTools
    return detail
  }

  list(): AgentInfo[] {
    const envModel = process.env.ZERONE_AGENT_MODEL
    const result: AgentInfo[] = []
    for (const [id, def] of this.defs) {
      const status = this.statuses.get(id)
      if (status !== "ready") continue
      result.push({
        id,
        name: def.name ?? def.id,
        model: envModel ?? def.model ?? "",
        status: "ready",
        toolCount: def.allowedTools?.length ?? 0,
      })
    }
    return result
  }

  async closeAll(): Promise<void> {
    // Release runtime-owned MCP connections first (#47 §3): agents created
    // from these opts never owned them (the SDK closes only what it
    // connected itself; pre-materialized connections are registry assets).
    await this.mcp.closeAll()
    this.defs.clear()
    this.createOpts.clear()
    this.statuses.clear()
    this.scannedSkills.clear()
    this.fileToolNames.clear()
    this.cronService = undefined
    this.materialized.clear()
    this.unavailableReasons.clear()
  }
}

type McpServerConfig = NonNullable<AgentDefinition["mcpServers"]>[string]

/**
 * Sanitize MCP server config for safe HTTP exposure.
 *
 * Policy: `env` and `headers` values are replaced with "***" (keys preserved).
 * `command`, `args`, and `url` are returned as-is.
 *
 * Note: `args` and `url` may carry secrets in user-supplied forms (e.g.,
 * `--token=xxx` in args, `?token=xxx` or `user:pass@host` in url). These are
 * NOT redacted — callers must avoid logging them verbatim.
 */
function sanitizeMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerSummary> | undefined {
  if (!servers) return undefined

  const result: Record<string, McpServerSummary> = {}
  for (const [name, cfg] of Object.entries(servers)) {
    const summary: McpServerSummary = { transport: cfg.transport }
    if (cfg.transport === "stdio") {
      if (cfg.command !== undefined) summary.command = cfg.command
      if (cfg.args !== undefined) summary.args = cfg.args
      if (cfg.env !== undefined) {
        summary.env = Object.fromEntries(
          Object.keys(cfg.env).map((k) => [k, "***"]),
        )
      }
    } else {
      // sse | http
      if (cfg.url !== undefined) summary.url = cfg.url
      if (cfg.headers !== undefined) {
        summary.headers = Object.fromEntries(
          Object.keys(cfg.headers).map((k) => [k, "***"]),
        )
      }
    }
    result[name] = summary
  }
  return result
}
