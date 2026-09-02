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

const AigcConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Full 27-char provider code; last 4 chars are the model/app code slot */
  contentProducer: z.string().length(27),
  label: z.enum(["1", "2", "3"]).optional(),
  signingKey: z.string().optional(),
  explicitHint: z.boolean().optional(),
  produceIdPrefix: z.string().optional(),
  /** model name -> 4-char model code replacing the last 4 chars */
  modelCodes: z.record(z.string(), z.string().length(4)).optional(),
})

export const HubConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().optional(),
  chatPushKey: z.string().optional(),
  /** 部署级租户：写入回传 session 的 org 字段。缺省时省略该字段，hub 按部署模式解析默认租户。 */
  org: z.string().optional(),
})

export const CronConfigSchema = z.object({
  /** Opt-in: cron runs agents on a schedule and incurs model calls. */
  enabled: z.boolean().default(false),
  /** Data root passed to SDK createDefaultCronService({ dataDir }); cron files live under <dataRoot>/cron/. Relative paths resolve against configDir. */
  dataRoot: z.string().min(1).default(".zerone"),
  executionTimeoutMs: z.number().int().positive().optional(),
  drainMs: z.number().int().positive().optional(),
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

const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  /** Human-readable capability summary. Used for SDK agent.description and Task routing when mounted. */
  description: z.string().min(1),
  model: z.string().default("claude-sonnet-4-6"),
  /** Provider credentials; env vars (ZERONE_AGENT_API_KEY/BASE_URL/API_TYPE) take precedence. Never exposed via the detail endpoint. */
  apiKey: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  apiType: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
  maxTurns: z.number().default(10),
  maxSessionQueries: z.number().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  settingSources: z.array(z.enum(["user", "project"])).optional(),
  extraUserSkillDirs: z.array(z.string()).optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional(),
  thinking: ThinkingConfigSchema.optional(),
  datasets: z.record(z.string()).optional(),
  /** File-based custom tool scripts; relative paths resolve against configDir. Tool names derive from file names. */
  customTools: z.array(z.string().min(1)).optional(),
  /** Agent ids to mount as subagents (Task tool). References are validated by validateSubagentRefs. */
  subagents: z.array(z.string().min(1)).optional(),
}).refine(
  (data) => !(data.systemPrompt && data.systemPromptFile),
  { message: "systemPrompt and systemPromptFile are mutually exclusive" },
)

export const RuntimeConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  cors: CorsConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  aigc: AigcConfigSchema.optional(),
  hub: HubConfigSchema.optional(),
  cron: CronConfigSchema.optional(),
  agents: z.array(AgentDefinitionSchema).min(1),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>
export type HubConfig = z.infer<typeof HubConfigSchema>
export type CronConfig = z.infer<typeof CronConfigSchema>

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

/** Validate subagents id references: unknown ids and duplicates are config errors. Self/cyclic refs are allowed (delegation depth is 1). */
export function validateSubagentRefs(config: RuntimeConfig): void {
  const ids = new Set<string>()
  for (const agent of config.agents) {
    if (ids.has(agent.id)) {
      throw new Error(`Duplicate agent id "${agent.id}" in agents list`)
    }
    ids.add(agent.id)
  }
  for (const agent of config.agents) {
    if (!agent.subagents?.length) continue
    const seen = new Set<string>()
    for (const ref of agent.subagents) {
      if (!ids.has(ref)) {
        throw new Error(
          `Agent "${agent.id}" references unknown subagent "${ref}". Available agent ids: ${[...ids].join(", ")}`,
        )
      }
      if (seen.has(ref)) {
        throw new Error(`Agent "${agent.id}" duplicates subagent reference "${ref}"`)
      }
      seen.add(ref)
    }
  }
}

/**
 * Pre-schema migration hint: the legacy inline subagent Record form was removed
 * in 2.0. Without this check users get a raw Zod error ("Expected array,
 * received object") with no pointer to the new id-reference syntax. Works on
 * raw parsed YAML and on plain TS config exports alike.
 */
function assertNoInlineSubagents(raw: unknown): void {
  if (!raw || typeof raw !== "object") return
  const agents = (raw as { agents?: unknown }).agents
  if (!Array.isArray(agents)) return
  for (const agent of agents) {
    if (!agent || typeof agent !== "object") continue
    const { id, subagents } = agent as { id?: unknown; subagents?: unknown }
    if (subagents === undefined || Array.isArray(subagents)) continue
    const label = typeof id === "string" && id ? `Agent "${id}"` : "An agent"
    throw new Error(
      `${label}: inline subagent definitions were removed in 2.0. Define the subagent in the top-level agents list and reference it by id, e.g. subagents: ["coder"]`,
    )
  }
}

export function loadYamlConfig(configPath: string): RuntimeConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }
  const raw = readFileSync(configPath, "utf-8")
  const parsed = parseYaml(raw)
  assertNoInlineSubagents(parsed)
  const config = RuntimeConfigSchema.parse(parsed)
  validateSubagentRefs(config)
  return config
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
  assertNoInlineSubagents(config)
  const parsedConfig = RuntimeConfigSchema.parse(config)
  validateSubagentRefs(parsedConfig)
  return parsedConfig
}
