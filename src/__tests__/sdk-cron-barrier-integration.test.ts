import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdir, open, unlink } from "node:fs/promises"
import { CronServiceStoppingError, createCronService } from "@zerone-agent/agent-sdk"
import type { CronRuntimeLock } from "@zerone-agent/agent-sdk"
import {
  createDefaultCronService,
  FileCronStorage,
  FileExecutionStore,
} from "@zerone-agent/agent-sdk/cron/node"

/**
 * Issue #40: integration tests against the REAL SDK (2.3.0+) cron service
 * proving the stop() service-operation barrier contract end-to-end
 * (zerone-agents/agent-sdk#57 / #58):
 *
 *  1. An in-flight CRUD operation delays the storage-lock release.
 *  2. A new mutation arriving after the stop intent rejects with the typed
 *     CronServiceStoppingError.
 *
 * Everything here is real: the SDK state machine, FileCronStorage /
 * FileExecutionStore on disk, and the O_EXCL `runtime.lock` directory lock.
 * The only seam is a promise gate wrapped around FileCronStorage.add (the
 * same pattern the SDK's own barrier tests use) so a create can be held
 * mid-flight — real storage writes cannot be paused any other way.
 */

const EVERY_MINUTE = { cron: "0 18 * * *", prompt: "integration" }

describe("SDK cron stop() barrier (issue #40, real SDK integration)", () => {
  it("a held create settles before the directory lock is released", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cron-barrier-held-"))
    const cronDir = join(dataDir, "cron")
    const lockPath = join(cronDir, "runtime.lock")
    const order: string[] = []

    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => {
      unhandled.push(err)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      // Real file storage with a gate on add() to hold the create mid-flight.
      const storage = new FileCronStorage(cronDir)
      let releaseAdd!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseAdd = resolve
      })
      const originalAdd = storage.add.bind(storage)
      ;(storage as unknown as { add: (t: unknown) => Promise<unknown> }).add = async (input) => {
        await gate // parked here: the operation is entered but unsettled
        const task = await originalAdd(input as never)
        order.push("add-done")
        return task
      }

      // Real O_EXCL directory lock, same semantics as the SDK's lock.ts
      // (mkdir + O_EXCL create + unlink release; acquire is idempotent).
      let lockHeld = false
      const lock: CronRuntimeLock = {
        acquire: async () => {
          if (lockHeld) return
          await mkdir(cronDir, { recursive: true })
          const handle = await open(lockPath, "wx")
          await handle.close()
          lockHeld = true
        },
        release: async () => {
          await unlink(lockPath).catch(() => {})
          lockHeld = false
          order.push("lock-release")
        },
      }

      const service = createCronService({
        taskStorage: storage,
        executionStore: new FileExecutionStore(cronDir),
        executor: async () => ({}),
        lock,
      })
      await service.start()
      expect(existsSync(lockPath)).toBe(true)

      const held = service.create(EVERY_MINUTE)
      await new Promise((r) => setImmediate(r)) // entered; parked at the gate

      const stopping = service.stop({ drainMs: 0 })
      // Observe a rejection immediately (the R9 lesson): this promise is
      // parked on the barrier for as long as the create is held.
      stopping.catch(() => {})
      await new Promise((r) => setImmediate(r))

      // stop() is parked on the barrier — the entered create has not
      // settled, so the lock must NOT be released yet.
      expect(existsSync(lockPath)).toBe(true)
      expect(order).not.toContain("lock-release")

      releaseAdd()
      const task = await held
      expect(task.id).toBeTruthy()
      await stopping

      // The storage write settled strictly before the lock release.
      expect(order.indexOf("add-done")).toBeLessThan(order.indexOf("lock-release"))
      expect(existsSync(lockPath)).toBe(false)

      // Cross-process semantics: only after the release can a second real
      // service acquire the same directory.
      const second = createDefaultCronService({
        dataDir,
        resolveAgent: async () => {
          throw new Error("unused")
        },
      })
      await second.start()
      expect(existsSync(lockPath)).toBe(true)
      await second.stop()
      expect(existsSync(lockPath)).toBe(false)

      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("mutations after the stop intent reject with the typed CronServiceStoppingError", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cron-barrier-typed-"))
    const lockPath = join(dataDir, "cron", "runtime.lock")
    try {
      // Zero doubles: the pure default factory (real storage, real lock).
      const service = createDefaultCronService({
        dataDir,
        resolveAgent: async () => {
          throw new Error("unused")
        },
      })
      await service.start()
      expect(existsSync(lockPath)).toBe(true)
      const task = await service.create(EVERY_MINUTE)

      const stopping = service.stop({ drainMs: 0 })
      // The stop intent closes operation intake synchronously — these
      // rejections hold even before stop() settles.
      await expect(service.create(EVERY_MINUTE)).rejects.toBeInstanceOf(CronServiceStoppingError)
      await expect(service.update(task.id, { prompt: "nope" })).rejects.toBeInstanceOf(
        CronServiceStoppingError,
      )
      await expect(service.delete(task.id)).rejects.toBeInstanceOf(CronServiceStoppingError)
      await expect(service.enqueueNow(task.id)).rejects.toBeInstanceOf(CronServiceStoppingError)

      await stopping
      expect(existsSync(lockPath)).toBe(false)

      // The barrier stays closed after stop() completes (phase: stopped).
      await expect(service.create(EVERY_MINUTE)).rejects.toBeInstanceOf(CronServiceStoppingError)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
