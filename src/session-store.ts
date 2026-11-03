import {
  FileSessionStore,
  WriteCoordinator,
  createSessionManagerV2,
  type SessionManagerV2,
} from "@zerone-agent/agent-sdk/store"

export interface RuntimeSessionInfrastructure {
  store: FileSessionStore
  coordinator: WriteCoordinator
  manager: SessionManagerV2
}

/**
 * File-backed session infrastructure for one data dir
 * (`<dir>/sessions.json`).
 *
 * History: a coordinator wrapper pre-registering the ownership root lived
 * here as the agent-sdk#158 workaround (fresh-session Task/MultiTask spawns
 * failed because the root Agent self-registered only after the engine loop).
 * The upstream fix (agent-sdk#161: register the session before the engine
 * loop) shipped in @zerone-agent/agent-sdk 4.1.2 — wrapper removed per
 * agent-runtime#87; `sdk-subagent-spawn-integration.test.ts` (real spawn
 * through this exact infrastructure) is the regression pin.
 */
export function createSessionInfrastructure(dir: string): RuntimeSessionInfrastructure {
  const store = new FileSessionStore({ dir })
  const coordinator = new WriteCoordinator({ store })
  const manager = createSessionManagerV2({ store, coordinator })
  return { store, coordinator, manager }
}
