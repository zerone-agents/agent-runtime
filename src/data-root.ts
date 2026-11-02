import { resolve } from "node:path"
import type { RuntimeConfig } from "./config.js"

/**
 * Runtime 数据根：cron（`<root>/cron`）与 session transcript
 * （`<root>/sessions`）的共同锚点。单一 data root 是有意的运维选择——
 * 一个卷挂载同时覆盖两类数据（见 docs/configuration.md）。
 */
export function resolveDataRoot(config: RuntimeConfig, configDir: string): string {
  return resolve(configDir, config.cron?.dataRoot ?? ".zerone")
}

/**
 * Session transcript 存储目录：SDK v4 `FileSessionStore` 在其下写
 * `sessions.json`（issue #131）。register()-only 宿主不调用
 * loadFromConfig，无此目录、不落盘。
 */
export function resolveSessionsDir(config: RuntimeConfig, configDir: string): string {
  return resolve(resolveDataRoot(config, configDir), "sessions")
}
