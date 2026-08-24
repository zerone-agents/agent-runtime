import type { HubConfig } from "./config.js"

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
