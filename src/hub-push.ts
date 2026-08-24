import type { HubConfig } from "./config.js"
import { getSessionInfo, getSessionMessages } from "@zerone-agent/agent-sdk"
import type { NormalizedContentBlock, NormalizedMessageParam } from "@zerone-agent/agent-sdk"

export interface ResolvedHubConfig {
  baseUrl: string
  chatPushKey: string
}

export function resolveHubConfig(cfg?: HubConfig): ResolvedHubConfig | undefined {
  if (cfg?.enabled !== true) return undefined
  if (!cfg.baseUrl) throw new Error("hub is enabled but baseUrl is not configured")
  if (!cfg.chatPushKey) throw new Error("hub is enabled but chatPushKey is not configured")
  return { baseUrl: cfg.baseUrl.replace(/\/+$/, ""), chatPushKey: cfg.chatPushKey }
}

export interface HubIdentity {
  userName?: string
  org?: string
}

export interface PushSessionInput {
  sessionId: string
  agentId: string
  model: string
  identity: HubIdentity
}

const TITLE_MAX_LEN = 50

function stringifyToolInput(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) out[k] = String(v)
  return out
}

function toSegments(msg: NormalizedMessageParam): unknown[] {
  const blocks: NormalizedContentBlock[] =
    typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content
  const segs: unknown[] = []
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (b.text) segs.push({ type: "text", text: b.text })
        break
      case "thinking":
        if (b.thinking) segs.push({ type: "reasoning", reasoning: b.thinking })
        break
      case "tool_use": {
        const input = stringifyToolInput(b.input)
        segs.push({ type: "tool_use", name: b.name, id: b.id, ...(input ? { input } : {}) })
        break
      }
      case "tool_result":
        segs.push({ type: "tool_result", content: b.content, toolUseId: b.tool_use_id, isError: b.is_error ?? false })
        break
      // image 等其他块跳过：hub segment 格式无对应类型
    }
  }
  return segs
}

function formatTokenUsage(rawUsage: unknown): string | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined
  const u = rawUsage as Record<string, unknown>
  if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return undefined
  return JSON.stringify({
    total_input: u.input_tokens,
    total_output: u.output_tokens,
    total_tokens: u.input_tokens + u.output_tokens,
  })
}

function firstUserText(messages: NormalizedMessageParam[]): string | undefined {
  for (const m of messages) {
    if (m.role !== "user") continue
    const text = typeof m.content === "string"
      ? m.content
      : m.content.find((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text")?.text
    if (text) return text.slice(0, TITLE_MAX_LEN)
  }
  return undefined
}

export async function buildSessionPayload(input: PushSessionInput): Promise<Record<string, unknown> | null> {
  const info = await getSessionInfo(input.sessionId)
  if (!info) return null
  const messages = await getSessionMessages(input.sessionId)

  const out: Record<string, unknown> = {
    id: input.sessionId,
    created_at: info.createdAt,
    updated_at: info.updatedAt,
    model: input.model,
    agent_id: input.agentId,
    ...(input.identity.userName ? { user_name: input.identity.userName } : {}),
    ...(input.identity.org ? { org: input.identity.org } : {}),
  }
  const title = firstUserText(messages)
  if (title) out.title = title

  out.messages = messages.map((m, index) => {
    const segs = toSegments(m)
    const usage = formatTokenUsage(m.rawUsage)
    return {
      // SDK 1.3.1 的 saveSession/loadSession 都会为无 id 消息补 UUID，此 fallback 目前不可达，
      // 仅作为对未来 SDK 行为变化的防御。
      id: m.id ?? `${input.sessionId}:${index}`,
      role: m.role,
      created_at: info.createdAt, // transcript 无消息级时间戳，session createdAt 兜底
      ...(segs.length > 0 ? { content: JSON.stringify(segs) } : {}),
      ...(usage ? { token_usage: usage } : {}),
    }
  })
  return out
}
