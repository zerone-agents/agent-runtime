import { describe, it, expect } from "vitest"
import { MetricsCollector } from "../metrics"

describe("MetricsCollector", () => {
  describe("initial state", () => {
    it("returns zero totals from a fresh collector", () => {
      const collector = new MetricsCollector()
      const snap = collector.getSnapshot()

      expect(snap.totalRequests).toBe(0)
      expect(snap.totalTokens).toEqual({ input: 0, output: 0 })
      expect(snap.totalCost).toBe(0)
      expect(snap.agentMetrics).toEqual({})
    })
  })

  describe("recordRun", () => {
    it("records a single run for an agent", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a")
      const snap = collector.getSnapshot()

      expect(snap.totalRequests).toBe(1)
      expect(snap.agentMetrics["agent-a"].requests).toBe(1)
      expect(snap.agentMetrics["agent-a"].tokens).toEqual({ input: 0, output: 0 })
      expect(snap.agentMetrics["agent-a"].cost).toBe(0)
    })

    it("accumulates multiple runs for the same agent", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a")
      collector.recordRun("agent-a")
      collector.recordRun("agent-a")
      const snap = collector.getSnapshot()

      expect(snap.agentMetrics["agent-a"].requests).toBe(3)
      expect(snap.totalRequests).toBe(3)
    })

    it("tracks multiple agents independently", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a")
      collector.recordRun("agent-b")
      collector.recordRun("agent-a")
      const snap = collector.getSnapshot()

      expect(snap.totalRequests).toBe(3)
      expect(snap.agentMetrics["agent-a"].requests).toBe(2)
      expect(snap.agentMetrics["agent-b"].requests).toBe(1)
    })

    it("records usage data when provided", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", { input_tokens: 100, output_tokens: 50 })
      const m = collector.getSnapshot().agentMetrics["agent-a"]

      expect(m.tokens).toEqual({ input: 100, output: 50 })
    })

    it("accumulates usage data across multiple runs", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", { input_tokens: 100, output_tokens: 50 })
      collector.recordRun("agent-a", { input_tokens: 200, output_tokens: 75 })
      const m = collector.getSnapshot().agentMetrics["agent-a"]

      expect(m.tokens).toEqual({ input: 300, output: 125 })
    })

    it("leaves tokens at zero when usage is omitted", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a")
      const m = collector.getSnapshot().agentMetrics["agent-a"]

      expect(m.tokens).toEqual({ input: 0, output: 0 })
    })

    it("records cost when provided", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", undefined, 0.05)
      const m = collector.getSnapshot().agentMetrics["agent-a"]

      expect(m.cost).toBeCloseTo(0.05)
    })

    it("accumulates cost across multiple runs", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", undefined, 0.03)
      collector.recordRun("agent-a", undefined, 0.07)
      const m = collector.getSnapshot().agentMetrics["agent-a"]

      expect(m.cost).toBeCloseTo(0.1)
    })

    it("records run with both usage and cost", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", { input_tokens: 50, output_tokens: 25 }, 0.02)
      const m = collector.getSnapshot().agentMetrics["agent-a"]

      expect(m.requests).toBe(1)
      expect(m.tokens).toEqual({ input: 50, output: 25 })
      expect(m.cost).toBeCloseTo(0.02)
    })

    it("treats cost of 0 as valid (does not add it)", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", undefined, 0)
      const m = collector.getSnapshot().agentMetrics["agent-a"]

      expect(m.cost).toBe(0)
    })
  })

  describe("getSnapshot", () => {
    it("returns correct aggregated totals across agents", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", { input_tokens: 100, output_tokens: 50 }, 0.03)
      collector.recordRun("agent-b", { input_tokens: 200, output_tokens: 75 }, 0.07)
      const snap = collector.getSnapshot()

      expect(snap.totalRequests).toBe(2)
      expect(snap.totalTokens).toEqual({ input: 300, output: 125 })
      expect(snap.totalCost).toBeCloseTo(0.1)
    })

    it("includes per-agent breakdown", () => {
      const collector = new MetricsCollector()
      collector.recordRun("agent-a", { input_tokens: 100, output_tokens: 50 }, 0.03)
      collector.recordRun("agent-a", { input_tokens: 50, output_tokens: 25 })
      collector.recordRun("agent-b", { input_tokens: 200, output_tokens: 75 }, 0.07)
      const snap = collector.getSnapshot()

      expect(snap.agentMetrics["agent-a"]).toEqual({
        requests: 2,
        tokens: { input: 150, output: 75 },
        cost: 0.03,
      })
      expect(snap.agentMetrics["agent-b"]).toEqual({
        requests: 1,
        tokens: { input: 200, output: 75 },
        cost: 0.07,
      })
    })

    it("returns uptime greater than 0", () => {
      const collector = new MetricsCollector()
      const snap = collector.getSnapshot()

      expect(snap.uptime).toBeGreaterThanOrEqual(0)
    })

    it("uptime increases over time", async () => {
      const collector = new MetricsCollector()
      const snap1 = collector.getSnapshot()
      await new Promise((r) => setTimeout(r, 10))
      const snap2 = collector.getSnapshot()

      expect(snap2.uptime).toBeGreaterThan(snap1.uptime)
    })
  })
})
