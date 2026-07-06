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
          model: "gpt-4o",
          systemPrompt: "You are helpful.",
          maxTurns: 20,
          allowedTools: ["tool-a"],
          disallowedTools: ["tool-b"],
          skills: ["skill-1"],
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
      agents: [{ id: "minimal" }],
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

  it("accepts skill loading configuration (settingSources + extra dirs)", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [
        {
          id: "skill-agent",
          skills: ["cbt"],
          settingSources: ["user", "project", "local"],
          extraUserSkillDirs: ["/mnt/shared/skills"],
          extraProjectSkillDirs: ["/opt/project/skills"],
        },
      ],
    })
    const agent = result.agents[0]
    expect(agent.skills).toEqual(["cbt"])
    expect(agent.settingSources).toEqual(["user", "project", "local"])
    expect(agent.extraUserSkillDirs).toEqual(["/mnt/shared/skills"])
    expect(agent.extraProjectSkillDirs).toEqual(["/opt/project/skills"])
  })

  it("rejects invalid settingSources value", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [
          {
            id: "bad",
            settingSources: ["global"],
          },
        ],
      }),
    ).toThrow()
  })

  it("provides correct defaults", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "defaults-test" }],
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
            systemPrompt: "hello",
            systemPromptFile: "prompt.md",
          },
        ],
      }),
    ).toThrow(/mutually exclusive/)
  })

  it("accepts agents with subagent definitions", () => {
    const config = {
      agents: [
        {
          id: "coordinator",
          systemPrompt: "Delegate to subagents.",
          allowedTools: ["Task"],
          subagents: {
            coder: {
              description: "Coder subagent",
              prompt: "You are a coder.",
              tools: ["Read", "Write", "Edit"],
              model: "claude-sonnet-4-6",
              maxTurns: 30,
            },
            researcher: {
              description: "Researcher subagent",
              prompt: "You are a researcher.",
              tools: ["WebSearch", "WebFetch"],
              mcpServers: [{ name: "github", tools: ["search_issues"] }],
              skills: ["research"],
              maxTurns: 15,
            },
          },
        },
      ],
    }
    const result = RuntimeConfigSchema.parse(config)
    const agent = result.agents[0]
    expect(agent.subagents).toBeDefined()
    expect(agent.subagents?.coder.description).toBe("Coder subagent")
    expect(agent.subagents?.coder.maxTurns).toBe(30)
    expect(agent.subagents?.researcher.mcpServers).toEqual([
      { name: "github", tools: ["search_issues"] },
    ])
    expect(agent.subagents?.researcher.skills).toEqual(["research"])
  })

  it("rejects subagent definition missing required description", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [
          {
            id: "coordinator",
            subagents: {
              bad: {
                prompt: "missing description",
              },
            },
          },
        ],
      }),
    ).toThrow()
  })

  it("rejects subagent definition missing required prompt", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [
          {
            id: "coordinator",
            subagents: {
              bad: {
                description: "missing prompt",
              },
            },
          },
        ],
      }),
    ).toThrow()
  })
})

describe("AuthConfigSchema", () => {
  it("accepts config with auth.apiKey", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "a1" }],
      auth: { apiKey: "my-secret" },
    })
    expect(result.auth?.apiKey).toBe("my-secret")
  })

  it("accepts config without auth field", () => {
    const result = RuntimeConfigSchema.parse({ agents: [{ id: "a1" }] })
    expect(result.auth).toBeUndefined()
  })

  it("accepts auth object with no apiKey (optional)", () => {
    const result = RuntimeConfigSchema.parse({
      agents: [{ id: "a1" }],
      auth: {},
    })
    expect(result.auth).toEqual({})
  })

  it("rejects empty string apiKey", () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        agents: [{ id: "a1" }],
        auth: { apiKey: "" },
      }),
    ).toThrow()
  })
})

describe("resolveSystemPrompt", () => {
  it("returns inline systemPrompt", () => {
    const agent: AgentDefinition = {
      id: "a",
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
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      systemPromptFile: "prompt.md",
    }
    expect(resolveSystemPrompt(agent, TMP)).toBe("# You are a coder\nWrite clean code.")
  })

  it("returns undefined when neither systemPrompt nor systemPromptFile is set", () => {
    const agent: AgentDefinition = {
      id: "c",
      model: "claude-sonnet-4-6",
      maxTurns: 10,
    }
    expect(resolveSystemPrompt(agent, TMP)).toBeUndefined()
  })

  it("appends formatted datasets to systemPrompt", () => {
    const agent: AgentDefinition = {
      id: "a",
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
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      datasets: {},
    }
    expect(resolveSystemPrompt(agent, "/tmp")).toBe("<datasets>\n\n</datasets>")
  })

  it("returns unchanged systemPrompt when datasets is not configured", () => {
    const agent: AgentDefinition = {
      id: "d",
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
    model: gpt-4o
    systemPrompt: Hello from YAML
`)
    const config = loadYamlConfig(path)
    expect(config.agents[0].id).toBe("yaml-agent")
    expect(config.server.port).toBe(8080)
  })

  it("loads YAML config with subagent definitions", () => {
    const path = tmpFile("agents-with-subagents.yaml", `
agents:
  - id: coordinator
    systemPrompt: Delegate tasks.
    allowedTools:
      - Task
    subagents:
      coder:
        description: Code writer
        prompt: You write code.
        tools:
          - Read
          - Write
        maxTurns: 25
`)
    const config = loadYamlConfig(path)
    expect(config.agents[0].id).toBe("coordinator")
    expect(config.agents[0].subagents?.coder.description).toBe("Code writer")
    expect(config.agents[0].subagents?.coder.maxTurns).toBe(25)
  })

  it("throws for missing file", () => {
    expect(() => loadYamlConfig("/nonexistent/path/agents.yaml")).toThrow(
      /Config file not found/,
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
    systemPrompt: hi
`)
    const config = await discoverConfig(TMP)
    expect(config.agents[0].id).toBe("discovered")
  })

  it("loads config from agent.config.ts", async () => {
    tmpFile("agent.config.ts", `
export default {
  server: { port: 4000 },
  agents: [{ id: "ts-agent", systemPrompt: "hello from ts" }],
}
`)
    const config = await discoverConfig(TMP)
    expect(config.agents[0].id).toBe("ts-agent")
    expect(config.server.port).toBe(4000)
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
