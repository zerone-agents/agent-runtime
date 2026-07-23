import { describe, it, expect, vi } from "vitest"
import { AigcAuditLog, type AigcRunRecord } from "../audit-log.js"

function makeRecord(overrides: Partial<AigcRunRecord> = {}): AigcRunRecord {
  return {
    produceId: "20260723103000-a1b2c3d4e5f6",
    createdAt: new Date().toISOString(),
    agentId: "assistant",
    model: "glm-4.5",
    ...overrides,
  }
}

describe("AigcAuditLog", () => {
  it("records and lists run records", () => {
    const log = new AigcAuditLog()
    const r = makeRecord()
    log.record(r)
    expect(log.list()).toEqual([r])
  })

  it("finds a record by produceId", () => {
    const log = new AigcAuditLog()
    log.record(makeRecord({ produceId: "id-1" }))
    log.record(makeRecord({ produceId: "id-2", agentId: "other" }))
    expect(log.find("id-2")?.agentId).toBe("other")
    expect(log.find("nope")).toBeUndefined()
  })

  it("trims oldest records beyond maxRecords", () => {
    const log = new AigcAuditLog({ maxRecords: 3 })
    for (let i = 0; i < 5; i++) {
      log.record(makeRecord({ produceId: `id-${i}` }))
    }
    expect(log.list().map((r) => r.produceId)).toEqual(["id-2", "id-3", "id-4"])
  })

  it("invokes the onRecord hook for external persistence", () => {
    const onRecord = vi.fn()
    const log = new AigcAuditLog({ onRecord })
    const r = makeRecord()
    log.record(r)
    expect(onRecord).toHaveBeenCalledWith(r)
  })

  it("does not throw when the onRecord hook throws", () => {
    const log = new AigcAuditLog({
      onRecord: () => {
        throw new Error("db down")
      },
    })
    expect(() => log.record(makeRecord())).not.toThrow()
  })

  it("stores optional contentHash and sessionId", () => {
    const log = new AigcAuditLog()
    const r = makeRecord({ contentHash: "abc123", sessionId: "sess-1" })
    log.record(r)
    expect(log.find(r.produceId)?.contentHash).toBe("abc123")
    expect(log.find(r.produceId)?.sessionId).toBe("sess-1")
  })
})
