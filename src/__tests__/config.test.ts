import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { resolve, join } from "node:path"
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import {
  RuntimeConfigSchema,
  resolveSystemPrompt,
  formatDatasets,
  loadYamlConfig,
  findConfigDir,
  discoverConfig,
  validateSubagentRefs,
  type AgentDefinition,
} from "../config.js"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  }
})

const TMP = resolve(import.meta.dirname, "__tmp_config_test__")

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(TMP, { recursive: true, force: true })
})

function tmpFile(name: string, content: string) {
  const p = join(TMP, name)
  writeFileSync(p, content, "utf-8")
  return p
}

describe("RuntimeConfigSchema", () => {
  it("accepts a valid full config with all fields", () => {
    const config = {
      server: { host: "127.0.0.1", port: 4000 },
      cors: { origins: ["http://localhost:3000"] },
      logging: { level: "debug" as const },
      agents: [
        {
          id: "agent-1",
          name: "Test Agent",
          description: "full-feature test agent",
          model: "gpt-4o",
          systemPrompt: "You are helpful.",
          maxTurns: 20,
          allowedTools: ["tool-a"],
          disallowedTools: ["tool-b"],
          mcpServers: {
            myMcp: { transport: "stdio" as const, command: "node", args: ["server.js"] },
          },
          permissionMode: "auto" as const,
        },
      ],
    }
    const result = RuntimeConfigSchema.parse(config)
    expect(result.agents[0].id).toBe("agent-1")
    expect(result.server.port).toBe(4000)
    expect(result.cors?.origins).toEqual(["http://localhost:3000"])
    expect(result.logging?.level).toBe("debug")
  })

  it("accepts agent with datasets", () => {
    const config = {
      agents: [
        {
          id: "dataset-agent",
          description: "agent with datasets",
          datasets: {
            "dataset-1": "Primary dataset",
            "dataset-2": "Secondary dataset",
          },
        },
      ],
    }
    const result = RuntimeConfigSchema.parse(config)
    expect(result.agents[0].datasets).toEqual({
      "dataset-1": "Primary dataset",
      "dataset-2": "Secondary dataset",
    })
  })

  it("accepts a minimal config with only agents", () => {
    const config = {
      agents: [{ id: "minimal", description: "minimal agent" }],
    }
    const result = RuntimeConfigSchema.parse(config)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].model).toBe("claude-sonnet-4-6")
    expect(result.agents[0].maxTurns).toBe(10)
    expect(result.server.host).toBe("0.0.0.0")
    expect(result.server.port).toBe(3000)
    expect(result.cors).toBeUndefined()
    expect(result.logging).toBeUndefined()
  })

  it("accepts aigc config section", () => {
    const result = RuntimeConfigSchema.parse({
      aigc: {
        enabled: true,
        contentProducer: "001191320118MAK93FC72D10001",
        label: "1",
        signingKey: "k",
        explicitHint: true,
        produceIdPrefix: "prod-",
        modelCodes: { "qwen-max": "0002" },
      },
      agents: [{ id: "a", description: "aigc test agent" }],
    })
    expect(result.aigc?.enabled).toBe(true)
    expect(result.aigc?.contentProducer).toBe("001191320118MAK93FC72D10001")
    expect(result.aigc?.modelCodes).toEqual({ "qwen-max": "0002" })
  })

  it("leaves aigc undefined when omitted", () => {
    const result = RuntimeConfigSchema.parse({ agents: [{ id: "a", description: "agent" }] })
    expect(result.aigc).toBeUndefined()
  })

  it("rejects invalid aigc label values", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        aigc: { enabled: true, contentProducer: "x".repeat(27), label: "9" },
        agents: [{ id: "a", description: "agent" }],
      }),
    ).toThrow()
  })

  it("accepts skill loading configuration (settingSources + extra dirs)", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [
        {
          id: "skill-agent",
          description: "agent with skill config",
          settingSources: ["user", "project"],
          extraUserSkillDirs: ["/mnt/shared/skills"],
        },
      ],
    })
    const agent = result.agents[0]
    expect(agent.settingSources).toEqual(["user", "project"])
    expect(agent.extraUserSkillDirs).toEqual(["/mnt/shared/skills"])
  })

  it("rejects invalid settingSources value", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [
          {
            id: "bad",
            description: "agent",
            settingSources: ["global"],
          },
        ],
      }),
    ).toThrow()
  })

  it("rejects removed 'local' settingSource value (SDK 1.1.2 dropped it)", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [
          {
            id: "bad-local",
            description: "agent",
            settingSources: ["user", "local"],
          },
        ],
      }),
    ).toThrow()
  })

  it("provides correct defaults", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "defaults-test", description: "defaults agent" }],
    })
    expect(result.server).toEqual({ host: "0.0.0.0", port: 3000 })
    expect(result.agents[0].maxTurns).toBe(10)
    expect(result.agents[0].model).toBe("claude-sonnet-4-6")
  })

  it("rejects empty agents array", () => {
    expect(() =>
      RuntimeConfigSchema.parse({ agents: [] }),
    ).toThrow()
  })

  it("rejects config without agents", () => {
    expect(() => RuntimeConfigSchema.parse({})).toThrow()
  })

  it("rejects agent with both systemPrompt and systemPromptFile", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [
          {
            id: "conflict",
            description: "agent",
            systemPrompt: "hello",
            systemPromptFile: "prompt.md",
          },
        ],
      }),
    ).toThrow(/mutually exclusive/)
  })

  it("accepts subagents as an id reference list", () => {
    const config = RuntimeConfigSchema.parse({
      server: { host: "0.0.0.0", port: 3000 },
      agents: [
        { id: "general", description: "main agent", model: "gpt-4", subagents: ["coder"] },
        { id: "coder", description: "writes code", model: "gpt-4" },
      ],
    })
    expect(config.agents[0].subagents).toEqual(["coder"])
  })

  it("rejects legacy inline subagent Record form", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [
          {
            id: "a",
            description: "x",
            model: "gpt-4",
            subagents: { coder: { description: "d", prompt: "p" } },
          },
        ],
      }),
    ).toThrow()
  })

  it("rejects agent missing description", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [{ id: "a", model: "gpt-4" }],
      }),
    ).toThrow()
  })

  describe("maxSessionQueries", () => {
    it("parses maxSessionQueries when provided", () => {
      const result = RuntimeConfigSchema.parse({
        agents: [{ id: "assistant", description: "assistant", maxSessionQueries: 50 }],
      })
      expect(result.agents[0].maxSessionQueries).toBe(50)
    })

    it("leaves maxSessionQueries undefined when not provided", () => {
      const result = RuntimeConfigSchema.parse({
        agents: [{ id: "assistant", description: "assistant" }],
      })
      expect(result.agents[0].maxSessionQueries).toBeUndefined()
    })
  })
})

describe("AuthConfigSchema", () => {
  it("accepts config with auth.apiKey", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "a1", description: "agent" }],
      auth: { apiKey: "my-secret" },
    })
    expect(result.auth?.apiKey).toBe("my-secret")
  })

  it("accepts config without auth field", () => {
    const result = RuntimeConfigSchema.parse({ agents: [{ id: "a1", description: "agent" }] })
    expect(result.auth).toBeUndefined()
  })

  it("accepts auth object with no apiKey (optional)", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "a1", description: "agent" }],
      auth: {},
    })
    expect(result.auth).toEqual({})
  })

  it("rejects empty string apiKey", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [{ id: "a1", description: "agent" }],
        auth: { apiKey: "" },
      }),
    ).toThrow()
  })
})

describe("resolveSystemPrompt", () => {
  it("returns inline systemPrompt", () => {
    const agent: AgentDefinition = {
      id: "a",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      systemPrompt: "Be helpful.",
    }
    expect(resolveSystemPrompt(agent, "/some/dir")).toBe("Be helpful.")
  })

  it("reads systemPromptFile from configDir", () => {
    const filePath = tmpFile("prompt.md", "# You are a coder\nWrite clean code.")
    const agent: AgentDefinition = {
      id: "b",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      systemPromptFile: "prompt.md",
    }
    expect(resolveSystemPrompt(agent, TMP)).toBe("# You are a coder\nWrite clean code.")
  })

  it("returns undefined when neither systemPrompt nor systemPromptFile is set", () => {
    const agent: AgentDefinition = {
      id: "c",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
    }
    expect(resolveSystemPrompt(agent, TMP)).toBeUndefined()
  })

  it("appends formatted datasets to systemPrompt", () => {
    const agent: AgentDefinition = {
      id: "a",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      systemPrompt: "Be helpful.",
      datasets: {
        "dataset-1": "Primary dataset",
        "dataset-2": "Secondary dataset",
      },
    }
    expect(resolveSystemPrompt(agent, "/tmp")).toBe(
      "Be helpful.\n\n<datasets>\n - dataset-1: Primary dataset\n - dataset-2: Secondary dataset\n</datasets>",
    )
  })

  it("returns only datasets block when systemPrompt is not set", () => {
    const agent: AgentDefinition = {
      id: "b",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      datasets: {
        "dataset-1": "Primary dataset",
      },
    }
    expect(resolveSystemPrompt(agent, "/tmp")).toBe(
      "<datasets>\n - dataset-1: Primary dataset\n</datasets>",
    )
  })

  it("returns empty datasets block when datasets is empty object", () => {
    const agent: AgentDefinition = {
      id: "c",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      datasets: {},
    }
    expect(resolveSystemPrompt(agent, "/tmp")).toBe("<datasets>\n\n</datasets>")
  })

  it("returns unchanged systemPrompt when datasets is not configured", () => {
    const agent: AgentDefinition = {
      id: "d",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      systemPrompt: "Be helpful.",
    }
    expect(resolveSystemPrompt(agent, "/tmp")).toBe("Be helpful.")
  })

  it("appends datasets to systemPromptFile content", () => {
    const filePath = tmpFile("prompt.md", "File prompt.")
    const agent: AgentDefinition = {
      id: "e",
      description: "agent",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      systemPromptFile: "prompt.md",
      datasets: { "dataset-1": "Primary dataset" },
    }
    expect(resolveSystemPrompt(agent, TMP)).toBe(
      "File prompt.\n\n<datasets>\n - dataset-1: Primary dataset\n</datasets>",
    )
  })
})

describe("loadYamlConfig", () => {
  it("loads a valid YAML config file", () => {
    const path = tmpFile("agents.yaml", `
server:
  host: 0.0.0.0
  port: 8080
agents:
  - id: yaml-agent
    description: yaml test agent
    model: gpt-4o
    systemPrompt: Hello from YAML
`)
    const config = loadYamlConfig(path)
    expect(config.agents[0].id).toBe("yaml-agent")
    expect(config.server.port).toBe(8080)
  })

  it("loads YAML config with subagent references", () => {
    const path = tmpFile(
      "agents-with-subagents.yaml",
      `
server:
  port: 3000
agents:
  - id: general
    description: main agent
    model: gpt-4
    subagents:
      - coder
  - id: coder
    description: code writer
    model: gpt-4
`,
    )
    const config = loadYamlConfig(path)
    expect(config.agents[0].subagents).toEqual(["coder"])
  })

  it("throws for missing file", () => {
    expect(() => loadYamlConfig("/nonexistent/path/agents.yaml")).toThrow(
      /Config file not found/,
    )
  })

  it("throws a migration hint for the legacy inline subagent Record form", () => {
    const path = tmpFile(
      "agents-legacy-inline-subagents.yaml",
      `
agents:
  - id: general
    description: main agent
    model: gpt-4
    subagents:
      coder:
        description: code writer
        prompt: write code
`,
    )
    expect(() => loadYamlConfig(path)).toThrow(
      'Agent "general": inline subagent definitions were removed in 2.0. Define the subagent in the top-level agents list and reference it by id, e.g. subagents: ["coder"]',
    )
  })

  it("throws for malformed YAML parsed to invalid config", () => {
    const path = tmpFile("bad.yaml", `
agents: []
`)
    expect(() => loadYamlConfig(path)).toThrow()
  })

  it("throws for YAML with empty agents array", () => {
    const path = tmpFile("empty-agents.yaml", `
agents: []
`)
    expect(() => loadYamlConfig(path)).toThrow()
  })
})

describe("findConfigDir", () => {
  it("returns resolved explicit path", () => {
    const result = findConfigDir("/my/custom/dir")
    expect(result).toBe(resolve("/my/custom/dir"))
  })

  it("returns cwd when agents.yaml exists in cwd", () => {
    const mockedExists = vi.mocked(existsSync)
    const cwd = process.cwd()
    mockedExists.mockImplementation((p: any) => {
      if (typeof p === "string" && p === resolve(cwd, "agents.yaml")) return true
      return false
    })
    expect(findConfigDir()).toBe(cwd)
  })

  it("returns cwd when agent.config.ts exists in cwd", () => {
    const mockedExists = vi.mocked(existsSync)
    const cwd = process.cwd()
    mockedExists.mockImplementation((p: any) => {
      if (typeof p === "string" && p === resolve(cwd, "agent.config.ts")) return true
      return false
    })
    expect(findConfigDir()).toBe(cwd)
  })

  it("throws when no config found anywhere", () => {
    const mockedExists = vi.mocked(existsSync)
    mockedExists.mockReturnValue(false)
    expect(() => findConfigDir()).toThrow(/No config found/)
  })
})

describe("discoverConfig", () => {
  it("loads config from agents.yaml", async () => {
    tmpFile("agents.yaml", `
agents:
  - id: discovered
    description: discovered agent
    systemPrompt: hi
`)
    const config = await discoverConfig(TMP)
    expect(config.agents[0].id).toBe("discovered")
  })

  it("loads config from agent.config.ts", async () => {
    tmpFile("agent.config.ts", `
export default {
  server: { port: 4000 },
  agents: [{ id: "ts-agent", description: "ts agent", systemPrompt: "hello from ts" }],
}
`)
    const config = await discoverConfig(TMP)
    expect(config.agents[0].id).toBe("ts-agent")
    expect(config.server.port).toBe(4000)
  })
})

describe("validateSubagentRefs", () => {
  const base = (agents: any[]) =>
    ({ server: { host: "0.0.0.0", port: 3000 }, agents }) as any

  it("passes for valid references", () => {
    expect(() =>
      validateSubagentRefs(
        base([
          { id: "a", description: "x", subagents: ["b", "c"] },
          { id: "b", description: "y" },
          { id: "c", description: "z" },
        ]),
      ),
    ).not.toThrow()
  })

  it("throws listing available ids for unknown reference", () => {
    expect(() =>
      validateSubagentRefs(
        base([
          { id: "a", description: "x", subagents: ["ghost"] },
          { id: "b", description: "y" },
        ]),
      ),
    ).toThrow('Agent "a" references unknown subagent "ghost". Available agent ids: a, b')
  })

  it("throws for duplicate reference", () => {
    expect(() =>
      validateSubagentRefs(
        base([
          { id: "a", description: "x", subagents: ["b", "b"] },
          { id: "b", description: "y" },
        ]),
      ),
    ).toThrow('Agent "a" duplicates subagent reference "b"')
  })

  it("allows self and cyclic references", () => {
    expect(() =>
      validateSubagentRefs(
        base([
          { id: "a", description: "x", subagents: ["a", "b"] },
          { id: "b", description: "y", subagents: ["a"] },
        ]),
      ),
    ).not.toThrow()
  })

  it("throws for duplicate agent ids", () => {
    expect(() =>
      validateSubagentRefs(
        base([
          { id: "coder", description: "first definition" },
          { id: "coder", description: "second definition" },
        ]),
      ),
    ).toThrow('Duplicate agent id "coder" in agents list')
  })

  it("is enforced by loadYamlConfig", () => {
    const path = tmpFile(
      "agents-bad-ref.yaml",
      `
agents:
  - id: a
    description: x
    model: gpt-4
    subagents: [ghost]
`,
    )
    expect(() => loadYamlConfig(path)).toThrow('unknown subagent "ghost"')
  })
})

describe("formatDatasets", () => {
  it("formats multiple datasets", () => {
    expect(
      formatDatasets({
        "dataset-1": "Primary dataset",
        "dataset-2": "Secondary dataset",
      }),
    ).toBe("<datasets>\n - dataset-1: Primary dataset\n - dataset-2: Secondary dataset\n</datasets>")
  })

  it("formats empty datasets", () => {
    expect(formatDatasets({})).toBe("<datasets>\n\n</datasets>")
  })
})
