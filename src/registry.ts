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

  register(id: string, agent: Agent): void {
    this.agents.set(id, agent)
    this.statuses.set(id, "ready")
  }

  async loadFromConfig(config: RuntimeConfig, configDir: string): Promise<void> {
    for (const def of config.agents) {
      try {
        const systemPrompt = resolveSystemPrompt(def, configDir)
        const agent = createAgent({
          model: def.model,
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
      result.push({
        id,
        name: id,
        model: "",
        status: this.statuses.get(id) ?? "unavailable",
        toolCount: 0,
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
