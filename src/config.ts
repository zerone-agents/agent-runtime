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

const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("stdio"), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional() }),
  z.object({ transport: z.literal("sse"), url: z.string(), headers: z.record(z.string()).optional() }),
  z.object({ transport: z.literal("http"), url: z.string(), headers: z.record(z.string()).optional() }),
])

const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  model: z.string().default("claude-sonnet-4-6"),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
  maxTurns: z.number().default(10),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional(),
}).refine(
  (data) => !(data.systemPrompt && data.systemPromptFile),
  { message: "systemPrompt and systemPromptFile are mutually exclusive" },
)

export const RuntimeConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  cors: CorsConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  agents: z.array(AgentDefinitionSchema).min(1),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

export function resolveSystemPrompt(agent: AgentDefinition, configDir: string): string | undefined {
  if (agent.systemPrompt) return agent.systemPrompt
  if (agent.systemPromptFile) {
    const filePath = resolve(configDir, agent.systemPromptFile)
    return readFileSync(filePath, "utf-8")
  }
  return undefined
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

export function discoverConfig(configDir: string): RuntimeConfig {
  const tsPath = resolve(configDir, "agent.config.ts")
  if (existsSync(tsPath)) {
    throw new Error("agent.config.ts programmatic mode is not yet supported in Phase 1. Use agents.yaml.")
  }

  const yamlPath = resolve(configDir, "agents.yaml")
  return loadYamlConfig(yamlPath)
}
