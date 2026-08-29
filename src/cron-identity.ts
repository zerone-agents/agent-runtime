import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

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
  // Canonicalize the deepest existing ancestor (symlink-safe) and re-append
  // the missing suffix, so the digest is stable whether or not the dir
  // exists yet — server pre-creation and CLI post-creation must agree.
  let current = abs
  const suffix: string[] = []
  for (;;) {
    try {
      const canonical = realpathSync(current)
      return sha256Hex(suffix.length ? resolve(canonical, ...suffix) : canonical)
    } catch {
      const parent = dirname(current)
      if (parent === current) return sha256Hex(abs) // no existing ancestor at all
      suffix.unshift(basename(current))
      current = parent
    }
  }
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
