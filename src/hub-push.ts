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

const PUSH_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [1_000, 2_000] // 首次 + 2 次重试 = 最多 3 次尝试

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class HubChatPusher {
  constructor(
    private readonly config: ResolvedHubConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Fire-and-forget 推送；永不 reject，失败仅记日志。
   *
   * 取舍：进程退出时 in-flight 推送会丢失（不 drain）——最坏丢该 session
   * 最后一次 run 的快照，下次 run 的全量重推（hub 幂等 upsert）可补。
   */
  async pushSession(input: PushSessionInput): Promise<void> {
    try {
      const session = await buildSessionPayload(input)
      if (!session) return
      const body = JSON.stringify({ sessions: [session] })
      const url = `${this.config.baseUrl}/api/v1/chat/push`

      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        let retryable = false
        try {
          const res = await this.fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Chat-Push-Key": this.config.chatPushKey },
            body,
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          })
          if (res.ok) {
            const result = await res.json().catch(() => null) as { skipped_sessions?: number; conflicts?: unknown[] } | null
            if (result && ((result.skipped_sessions ?? 0) > 0 || (result.conflicts?.length ?? 0) > 0)) {
              console.warn("[hub-push] pushed with skips", { sessionId: input.sessionId, skipped: result.skipped_sessions, conflicts: result.conflicts?.length })
            }
            return
          }
          const snippet = await res.text().then((t) => t.slice(0, 200)).catch(() => "")
          if (res.status >= 400 && res.status < 500) {
            console.error("[hub-push] push rejected (no retry)", { sessionId: input.sessionId, status: res.status, body: snippet })
            return
          }
          retryable = true // 5xx
          console.error("[hub-push] push failed, will retry", { sessionId: input.sessionId, status: res.status, body: snippet, attempt })
        } catch (err) {
          retryable = true // 网络错误 / 超时
          console.error("[hub-push] push error, will retry", { sessionId: input.sessionId, error: (err as Error).message, attempt })
        }
        if (retryable && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt])
        }
      }
      console.error("[hub-push] push failed after all retries", { sessionId: input.sessionId })
    } catch (err) {
      // buildSessionPayload 等意外错误：吞掉，绝不影响 run
      console.error("[hub-push] unexpected error", { sessionId: input.sessionId, error: (err as Error).message })
    }
  }
}
