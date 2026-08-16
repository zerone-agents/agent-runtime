import { createAgent, type Agent } from "@zerone-agent/agent-sdk"
import { resolve } from "node:path"
import type { AgentDefinition, RuntimeConfig } from "./config.js"
import { resolveSystemPrompt } from "./config.js"
import { scanSkills, type SkillSummary } from "./skills.js"
import { loadToolDirectory } from "./tools/loader.js"

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
  subagents?: Record<string, { description: string }>
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

  register(id: string, def: AgentDefinition, opts: CreateOpts): void {
    this.defs.set(id, def)
    this.createOpts.set(id, opts)
    this.statuses.set(id, "ready")
  }

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
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

        // Load file-based custom tools. Defaults to agents/<id>/tools under
        // configDir; def.toolsDir overrides (relative paths resolve against
        // configDir). Failures mark this agent unavailable.
        const toolsDir = def.toolsDir
          ? resolve(configDir, def.toolsDir)
          : resolve(configDir, "agents", def.id, "tools")
        const fileTools = await loadToolDirectory(toolsDir)
        if (fileTools.length > 0) {
          this.fileToolNames.set(def.id, fileTools.map((t) => t.name))
        }

        // NOTE: do not pass `allowedSkills` to SDK. New SDK semantics:
        // omitting it means "no filter" — every scanned skill is exposed.
        // SDK 1.0.0 API: systemPrompt/allowedTools/disallowedTools/maxTurns moved
        // into the `agent` field (AgentDefinition).
        const opts: CreateOpts = {
          model: process.env.ZERONE_AGENT_MODEL ?? def.model,
          apiType: (process.env.ZERONE_AGENT_API_TYPE as any) ?? undefined,
          apiKey: process.env.ZERONE_AGENT_API_KEY ?? undefined,
          baseURL: process.env.ZERONE_AGENT_BASE_URL ?? undefined,
          agent: {
            description: def.name ?? def.id,
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
          subAgents: def.subagents as any,
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

    const merged = sessionId ? { ...opts, resume: sessionId } : opts
    return createAgent(merged)
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
      const sub: Record<string, { description: string }> = {}
      for (const [id, s] of Object.entries(def.subagents)) {
        sub[id] = { description: s.description }
      }
      detail.subagents = sub
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
