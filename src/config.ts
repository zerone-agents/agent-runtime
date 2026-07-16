import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

const ServerConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(3000),
})

const CorsConfigSchema = z.object({
  origins: z.array(z.string()).default(["*"]),
})

const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
})

const AuthConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
})

const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("stdio"), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional() }),
  z.object({ transport: z.literal("sse"), url: z.string(), headers: z.record(z.string()).optional() }),
  z.object({ transport: z.literal("http"), url: z.string(), headers: z.record(z.string()).optional() }),
])

const ThinkingConfigSchema = z.object({
  type: z.enum(["adaptive", "enabled", "disabled"]),
  budgetTokens: z.number().optional(),
})

const SubagentMcpServerConfigSchema = z.union([
  z.string(),
  z.object({ name: z.string(), tools: z.array(z.string()).optional() }),
])

const SubagentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  mcpServers: z.array(SubagentMcpServerConfigSchema).optional(),
  maxTurns: z.number().optional(),
})

const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  model: z.string().default("claude-sonnet-4-6"),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
  maxTurns: z.number().default(10),
  maxSessionTurns: z.number().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  settingSources: z.array(z.enum(["user", "project", "local"])).optional(),
  extraUserSkillDirs: z.array(z.string()).optional(),
  extraProjectSkillDirs: z.array(z.string()).optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional(),
  thinking: ThinkingConfigSchema.optional(),
  datasets: z.record(z.string()).optional(),
  subagents: z.record(SubagentDefinitionSchema).optional(),
}).refine(
  (data) => !(data.systemPrompt && data.systemPromptFile),
  { message: "systemPrompt and systemPromptFile are mutually exclusive" },
)

export const RuntimeConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  cors: CorsConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  agents: z.array(AgentDefinitionSchema).min(1),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

export function formatDatasets(datasets: Record<string, string>): string {
  const lines = Object.entries(datasets)
    .map(([id, description]) => ` - ${id}: ${description}`)
    .join("\n")
  return `<datasets>\n${lines}\n</datasets>`
}

export function resolveSystemPrompt(agent: AgentDefinition, configDir: string): string | undefined {
  let base: string | undefined
  if (agent.systemPrompt) {
    base = agent.systemPrompt
  } else if (agent.systemPromptFile) {
    const filePath = resolve(configDir, agent.systemPromptFile)
    base = readFileSync(filePath, "utf-8")
  }

  if (agent.datasets) {
    const datasetsBlock = formatDatasets(agent.datasets)
    return base ? `${base}\n\n${datasetsBlock}` : datasetsBlock
  }

  return base
}

export function loadYamlConfig(configPath: string): RuntimeConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }
  const raw = readFileSync(configPath, "utf-8")
  const parsed = parseYaml(raw)
  return RuntimeConfigSchema.parse(parsed)
}

export function findConfigDir(explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath)

  const cwd = process.cwd()
  if (existsSync(resolve(cwd, "agents.yaml"))) return cwd
  if (existsSync(resolve(cwd, "agent.config.ts"))) return cwd

  const home = process.env.HOME || process.env.USERPROFILE || ""
  const homeConfig = resolve(home, ".openagent")
  if (existsSync(resolve(homeConfig, "agents.yaml"))) return homeConfig
  if (existsSync(resolve(homeConfig, "agent.config.ts"))) return homeConfig

  throw new Error("No config found. Create agents.yaml or agent.config.ts in current directory or ~/.openagent/")
}

export function defineConfig(config: RuntimeConfig): RuntimeConfig {
  return config
}

export function discoverConfig(configDir: string): Promise<RuntimeConfig> {
  const tsPath = resolve(configDir, "agent.config.ts")
  if (existsSync(tsPath)) {
    return loadTsConfig(tsPath)
  }

  const yamlPath = resolve(configDir, "agents.yaml")
  return Promise.resolve(loadYamlConfig(yamlPath))
}

async function loadTsConfig(path: string): Promise<RuntimeConfig> {
  try {
    // @ts-ignore
    await import("tsx/esm")
  } catch {}

  const fileUrl = path.startsWith("/") ? `file://${path}` : `file:///${path}`
  const mod = await import(`${fileUrl}?t=${Date.now()}`)

  const config = mod.default ?? mod.config
  if (!config) {
    throw new Error(`agent.config.ts must export a config object (export default defineConfig({...}))`)
  }
  return RuntimeConfigSchema.parse(config)
}
