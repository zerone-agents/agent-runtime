import { describe, it, expect } from "vitest"
import { RuntimeConfigSchema, loadYamlConfig } from "../config.js"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const baseAgents = [{ id: "a1", description: "test agent" }]

describe("cron config schema", () => {
  it("omits cron by default (disabled)", () => {
    const cfg = RuntimeConfigSchema.parse({ agents: baseAgents })
    expect(cfg.cron).toBeUndefined()
  })

  it("applies defaults when cron section is present but empty", () => {
    const cfg = RuntimeConfigSchema.parse({ agents: baseAgents, cron: {} })
    expect(cfg.cron).toEqual({ enabled: false, dataRoot: ".zerone" })
  })

  it("parses a full cron section", () => {
    const cfg = RuntimeConfigSchema.parse({
      agents: baseAgents,
      cron: { enabled: true, dataRoot: ".zerone", executionTimeoutMs: 600000, drainMs: 5000 },
    })
    expect(cfg.cron).toEqual({
      enabled: true, dataRoot: ".zerone", executionTimeoutMs: 600000, drainMs: 5000,
    })
  })

  it("rejects non-positive timeouts", () => {
    expect(() =>
      RuntimeConfigSchema.parse({ agents: baseAgents, cron: { enabled: true, executionTimeoutMs: 0 } }),
    ).toThrow()
    expect(() =>
      RuntimeConfigSchema.parse({ agents: baseAgents, cron: { enabled: true, drainMs: -1 } }),
    ).toThrow()
  })

  it("rejects non-integer timeouts", () => {
    expect(() =>
      RuntimeConfigSchema.parse({ agents: baseAgents, cron: { enabled: true, executionTimeoutMs: 1.5 } }),
    ).toThrow()
  })

  it("parses cron section from YAML config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-cfg-"))
    try {
      writeFileSync(join(dir, "agents.yaml"), [
        "cron:",
        "  enabled: true",
        "  dataRoot: var/cron-data",
        "agents:",
        "  - id: a1",
        "    description: test agent",
        "",
      ].join("\n"))
      const cfg = loadYamlConfig(join(dir, "agents.yaml"))
      expect(cfg.cron).toEqual({ enabled: true, dataRoot: "var/cron-data" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
