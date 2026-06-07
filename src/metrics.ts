export interface AgentMetrics {
  requests: number
  tokens: { input: number; output: number }
  cost: number
}

export interface RuntimeMetrics {
  totalRequests: number
  totalTokens: { input: number; output: number }
  totalCost: number
  agentMetrics: Record<string, AgentMetrics>
  uptime: number
}

export class MetricsCollector {
  private startTime = Date.now()
  private agents: Record<string, AgentMetrics> = {}

  recordRun(agentId: string, usage?: { input_tokens: number; output_tokens: number }, cost?: number) {
    if (!this.agents[agentId]) {
      this.agents[agentId] = { requests: 0, tokens: { input: 0, output: 0 }, cost: 0 }
    }
    const m = this.agents[agentId]
    m.requests++
    if (usage) {
      m.tokens.input += usage.input_tokens
      m.tokens.output += usage.output_tokens
    }
    if (cost != null) {
      m.cost += cost
    }
  }

  getSnapshot(): RuntimeMetrics {
    let totalRequests = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0
    for (const m of Object.values(this.agents)) {
      totalRequests += m.requests
      totalInput += m.tokens.input
      totalOutput += m.tokens.output
      totalCost += m.cost
    }
    return {
      totalRequests,
      totalTokens: { input: totalInput, output: totalOutput },
      totalCost,
      agentMetrics: { ...this.agents },
      uptime: Date.now() - this.startTime,
    }
  }
}
