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

export class AgentRegistry {
  private agents = new Map<string, Agent>()
  private statuses = new Map<string, "ready" | "unavailable">()
  private defs = new Map<string, AgentDefinition>()

  register(id: string, agent: Agent, def?: AgentDefinition): void {
    this.agents.set(id, agent)
    this.statuses.set(id, "ready")
    if (def) this.defs.set(id, def)
  }

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
    for (const def of config.agents) {
      try {
        const systemPrompt = resolveSystemPrompt(def, configDir)
        const agent = createAgent({
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
        })

        this.agents.set(def.id, agent)
        this.statuses.set(def.id, "ready")
        this.defs.set(def.id, def)
      } catch (err) {
        console.error(`Failed to create agent "${def.id}":`, err)
        this.statuses.set(def.id, "unavailable")
      }
    }
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId)
  }

  getStatus(agentId: string): "ready" | "unavailable" | "not_found" {
    return this.statuses.get(agentId) ?? "not_found"
  }

  list(): AgentInfo[] {
    const result: AgentInfo[] = []
    for (const [id] of this.agents) {
      const def = this.defs.get(id)
      result.push({
        id,
        name: def?.name ?? def?.id ?? id,
        model: def?.model ?? "",
        status: this.statuses.get(id) ?? "unavailable",
        toolCount: def?.allowedTools?.length ?? 0,
      })
    }
    return result
  }

  async closeAll(): Promise<void> {
    for (const [id, agent] of this.agents) {
      try {
        await agent.close()
      } catch (err) {
        console.error(`Error closing agent "${id}":`, err)
      }
    }
    this.agents.clear()
    this.statuses.clear()
  }
}
