import type { SessionState } from "@zerone-agent/agent-sdk/store"

/**
 * 测试用 SessionState 构造器（SDK v4 store 形状，issue #131）。
 * 默认自根归属（rootSessionId === sessionId、无 parent）；subagent 幽灵行
 * 的判定形状经 `ownership` 覆盖传入（rootSessionId 指向他者 / 带
 * parentSessionId）。
 */
export function makeSessionState(
  sessionId: string,
  overrides: {
    createdAt?: string
    updatedAt?: string
    model?: string
    messageCount?: number
    ownership?: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string }
  } = {},
): SessionState {
  const createdAt = overrides.createdAt ?? "2025-01-01T00:00:00.000Z"
  const updatedAt = overrides.updatedAt ?? createdAt
  return {
    sessionId,
    metadata: {
      id: sessionId,
      cwd: "/tmp",
      model: overrides.model ?? "test",
      createdAt,
      updatedAt,
      messageCount: overrides.messageCount ?? 1,
    },
    branches: [],
    currentBranchId: "b1",
    revision: 1,
    createdAt,
    updatedAt,
    ownership: overrides.ownership ?? { rootSessionId: sessionId },
  }
}
