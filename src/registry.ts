import { createAgent, type Agent, type AgentDefinition as SdkAgentDefinition } from "@zerone-agent/agent-sdk"
import type { CronService } from "@zerone-agent/agent-sdk"
import { resolve } from "node:path"
import type { AgentDefinition, RuntimeConfig } from "./config.js"
import { resolveSystemPrompt } from "./config.js"
import { scanSkills, type SkillSummary } from "./skills.js"
import { loadToolFiles } from "./tools/loader.js"

function convertMcpServers(
  mcpServers: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!mcpServers) return undefined
  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, cfg]) => {
      const { transport, ...rest } = cfg
      return [name, { ...rest, type: transport }]
    }),
  )
}

/**
 * Materialize SDK subAgents from id references. Only the 5 fields the SDK
 * actually consumes are mapped. A child dataset catalog is folded into its
 * resolved prompt by resolveSystemPrompt before mapping; credentials, skills,
 * customTools and the mounted agent's own subagents do NOT apply in mounted context
 * (delegation depth is 1, matching the SDK's spawn-subagent design).
 */
function buildSubAgents(
  def: AgentDefinition,
  defsById: Map<string, AgentDefinition>,
  configDir: string,
): Record<string, SdkAgentDefinition> | undefined {
  if (!def.subagents?.length) return undefined
  const result: Record<string, SdkAgentDefinition> = {}
  for (const id of def.subagents) {
    const sub = defsById.get(id)
    if (!sub) continue // refs validated at config load; defensive skip
    result[id] = {
      description: sub.description,
      prompt: resolveSystemPrompt(sub, configDir) ?? "",
      allowedTools: sub.allowedTools,
      disallowedTools: sub.disallowedTools,
      maxTurns: sub.maxTurns,
    }
  }
  return result
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
}

type CreateOpts = Parameters<typeof createAgent>[0]

export class AgentRegistry {
  private defs = new Map<string, AgentDefinition>()
  private createOpts = new Map<string, CreateOpts>()
  private statuses = new Map<string, "ready" | "unavailable">()
  private scannedSkills = new Map<string, SkillSummary[]>()
  private fileToolNames = new Map<string, string[]>()
  private cronService?: CronService

  register(id: string, def: AgentDefinition, opts: CreateOpts): void {
    this.defs.set(id, def)
    this.createOpts.set(id, opts)
    this.statuses.set(id, "ready")
  }

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
    const defsById = new Map(config.agents.map((a) => [a.id, a] as const))
    for (const def of config.agents) {
      try {
        const systemPrompt = resolveSystemPrompt(def, configDir)

        // Eagerly scan filesystem for available skills (per-agent view).
        // SDK's skill registry is process-global and cannot distinguish
        // multiple agents with different settingSources; we keep our own
        // per-agent snapshot so the detail endpoint is accurate regardless
        // of which agents have been run.
        let availableSkills: SkillSummary[] = []
        try {
          availableSkills = await scanSkills({
            cwd: process.cwd(),
            settingSources: def.settingSources,
            extraUserSkillDirs: def.extraUserSkillDirs,
          })
        } catch (err) {
          console.error(`Failed to scan skills for agent "${def.id}":`, err)
        }
        if (availableSkills.length > 0) {
          this.scannedSkills.set(def.id, availableSkills)
        }

        // Load file-based custom tools listed in def.customTools.
        // Relative paths resolve against configDir; absolute paths are
        // used as-is. Failures mark this agent unavailable.
        const fileTools = def.customTools?.length
          ? await loadToolFiles(
              def.customTools.map((p) => resolve(configDir, p)),
            )
          : []
        if (fileTools.length > 0) {
          this.fileToolNames.set(def.id, fileTools.map((t) => t.name))
        }

        // NOTE: do not pass `allowedSkills` to SDK. New SDK semantics:
        // omitting it means "no filter" — every scanned skill is exposed.
        // SDK 1.0.0 API: systemPrompt/allowedTools/disallowedTools/maxTurns moved
        // into the `agent` field (AgentDefinition).
        const opts: CreateOpts = {
          model: process.env.ZERONE_AGENT_MODEL ?? def.model,
          apiType: (process.env.ZERONE_AGENT_API_TYPE as any) ?? (def.apiType as any) ?? undefined,
          apiKey: process.env.ZERONE_AGENT_API_KEY ?? def.apiKey ?? undefined,
          baseURL: process.env.ZERONE_AGENT_BASE_URL ?? def.baseURL ?? undefined,
          agent: {
            description: def.description,
            prompt: systemPrompt ?? "",
            allowedTools: def.allowedTools,
            disallowedTools: def.disallowedTools,
            maxTurns: def.maxTurns,
          },
          maxSessionTurns: def.maxSessionTurns,
          permissionMode: def.permissionMode,
          settingSources: def.settingSources,
          extraUserSkillDirs: def.extraUserSkillDirs,
          mcpServers: convertMcpServers(def.mcpServers),
          thinking: def.thinking as any,
          subAgents: buildSubAgents(def, defsById, configDir),
          customTools: fileTools.length > 0 ? fileTools : undefined,
        }

        this.defs.set(def.id, def)
        this.createOpts.set(def.id, opts)
        this.statuses.set(def.id, "ready")
      } catch (err) {
        console.error(`Failed to configure agent "${def.id}":`, err)
        this.defs.set(def.id, def)
        this.statuses.set(def.id, "unavailable")
      }
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
    if (def.permissionMode !== undefined) detail.permissionMode = def.permissionMode
    if (def.maxSessionTurns !== undefined) detail.maxSessionTurns = def.maxSessionTurns
    if (def.allowedTools !== undefined) detail.allowedTools = def.allowedTools
    if (def.disallowedTools !== undefined) detail.disallowedTools = def.disallowedTools
    const scanned = this.scannedSkills.get(agentId)
    if (scanned !== undefined) detail.availableSkills = scanned
    if (def.settingSources !== undefined) detail.settingSources = def.settingSources
    if (def.extraUserSkillDirs !== undefined) detail.extraUserSkillDirs = def.extraUserSkillDirs
    const mcp = sanitizeMcpServers(def.mcpServers)
    if (mcp !== undefined) detail.mcpServers = mcp
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
    this.defs.clear()
    this.createOpts.clear()
    this.statuses.clear()
    this.scannedSkills.clear()
    this.fileToolNames.clear()
    this.cronService = undefined
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
