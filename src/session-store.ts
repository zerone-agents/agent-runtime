import {
  FileSessionStore,
  WriteCoordinator,
  createSessionManagerV2,
  type SessionManagerV2,
  type OperationIntent,
  type OperationReceipt,
} from "@zerone-agent/agent-sdk/store"

/**
 * SDK 4.x register-protocol workaround (agent-sdk#158).
 *
 * The v4 store requires a session's ownership ROOT to be registered before
 * any write carrying a foreign `ownership.rootSessionId` — subagent spawns
 * assert the ancestor chain mid-query (`ensureRow` →
 * `assertAncestorsRegistered`). Two SDK-side gaps make a fresh session fail:
 *
 *  1. the root Agent self-registers only at its first post-engine-loop
 *     checkpoint (`Agent.persistCheckpoint`) — after the spawn already ran;
 *  2. `prepareChildOwnership` registers the engine agentId (`'main'`) instead
 *     of the session id, so its own pre-registration asserts the very
 *     session that does not exist yet.
 *
 * Until the upstream fix lands, this coordinator pre-registers the
 * ownership root (self-root) before such writes. Idempotent: a repeated
 * same-ownership register is a no-op, and the Agent's own later
 * self-register folds into the existing row.
 */
/**
 * intent 的 ownership.rootSessionId 提取（类型守卫）。SDK 的
 * OperationIntent 联合类型只在 register / save-todos 上带 ownership；
 * 守卫让 SDK 字段名/形状变化显式化为 undefined（workaround 静默失效
 * 会被 session-store.test.ts 的行为钉用例拦截），而非靠 as 断言兜底。
 */
function ownershipRootOf(intent: OperationIntent): string | undefined {
  const ownership = (intent as { ownership?: unknown }).ownership
  if (typeof ownership !== "object" || ownership === null) return undefined
  const root = (ownership as { rootSessionId?: unknown }).rootSessionId
  return typeof root === "string" && root.length > 0 ? root : undefined
}

export class OwnershipRootPreRegisteringCoordinator extends WriteCoordinator {
  async execute(sessionId: string, intent: OperationIntent): Promise<OperationReceipt> {
    const root = ownershipRootOf(intent)
    if (root !== undefined && root !== sessionId) {
      await super.execute(root, { kind: "register", ownership: { rootSessionId: root } })
    }
    return super.execute(sessionId, intent)
  }
}

export interface RuntimeSessionInfrastructure {
  store: FileSessionStore
  coordinator: OwnershipRootPreRegisteringCoordinator
  manager: SessionManagerV2
}

/**
 * File-backed session infrastructure for one data dir
 * (`<dir>/sessions.json`). The wrapped coordinator is what Agents receive —
 * every spawn-path write flows through the ownership-root pre-registration.
 */
export function createSessionInfrastructure(dir: string): RuntimeSessionInfrastructure {
  const store = new FileSessionStore({ dir })
  const coordinator = new OwnershipRootPreRegisteringCoordinator({ store })
  const manager = createSessionManagerV2({ store, coordinator })
  return { store, coordinator, manager }
}
