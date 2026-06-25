import { createAgent, type Agent } from "@zerone-agent/open-agent-sdk"
import type { AgentDefinition, RuntimeConfig } from "./config.js"
import { resolveSystemPrompt } from "./config.js"

export interface AgentInfo {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  toolCount: number
}

type CreateOpts = Parameters<typeof createAgent>[0]

export class AgentRegistry {
  private defs = new Map<string, AgentDefinition>()
  private createOpts = new Map<string, CreateOpts>()
  private statuses = new Map<string, "ready" | "unavailable">()

  register(id: string, def: AgentDefinition, opts: CreateOpts): void {
    this.defs.set(id, def)
    this.createOpts.set(id, opts)
    this.statuses.set(id, "ready")
  }

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
    for (const def of config.agents) {
      try {
        const systemPrompt = resolveSystemPrompt(def, configDir)
        const opts: CreateOpts = {
          model: process.env.OPENAGENT_MODEL ?? def.model,
          apiType: (process.env.OPENAGENT_API_TYPE as any) ?? undefined,
          apiKey: process.env.OPENAGENT_API_KEY ?? undefined,
          baseURL: process.env.OPENAGENT_BASE_URL ?? undefined,
          systemPrompt,
          allowedTools: def.allowedTools,
          disallowedTools: def.disallowedTools,
          maxTurns: def.maxTurns,
          permissionMode: def.permissionMode,
          allowedSkills: def.skills,
          mcpServers: def.mcpServers as any,
          thinking: def.thinking as any,
          agents: def.subagents as any,
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

  list(): AgentInfo[] {
    const envModel = process.env.OPENAGENT_MODEL
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
  }
}
