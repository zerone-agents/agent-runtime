import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"

export interface CronStatusPayload {
  enabled: boolean
  running: boolean
  /** Ephemeral per-process id for diagnostics. */
  runtimeId: string
  /** sha256 of canonical configDir — identity, not a credential. */
  configId: string
  /** sha256 of canonical cron dataRoot — identity, not a credential. */
  dataId: string
  taskCount: number
  activeExecutionCount: number
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** Canonical-realpath identity of a directory; tolerates not-yet-created dirs. */
export function pathIdentity(dir: string): string {
  const abs = resolve(dir)
  let real = abs
  try {
    real = realpathSync(abs)
  } catch {
    // not created yet — resolve() is the best canonical form available
  }
  return sha256Hex(real)
}

export function newRuntimeId(): string {
  return randomUUID()
}

export function disabledCronStatus(runtimeId: string, configId: string, dataId: string): CronStatusPayload {
  return {
    enabled: false,
    running: false,
    runtimeId,
    configId,
    dataId,
    taskCount: 0,
    activeExecutionCount: 0,
  }
}
