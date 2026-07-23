/**
 * In-memory audit trail for AIGC ProduceIDs (GB 45438-2025 反查机制).
 *
 * The ProduceID embedded in every response must be resolvable back to the
 * run that produced it. This log is the in-process default; production
 * deployments should attach an `onRecord` hook to persist to a DB or log
 * pipeline (regulation-facing retention is typically 6+ months).
 */
export interface AigcRunRecord {
  produceId: string
  createdAt: string
  agentId: string
  model?: string
  sessionId?: string
  /** SHA-256 of the final output text, when available (blocking mode) */
  contentHash?: string
}

export interface AigcAuditLogOptions {
  /** Max in-memory records retained (oldest dropped first). Default 10000. */
  maxRecords?: number
  /** External persistence hook; errors are swallowed (never breaks a run). */
  onRecord?: (record: AigcRunRecord) => void | Promise<void>
}

export class AigcAuditLog {
  private records: AigcRunRecord[] = []
  private maxRecords: number
  private onRecord?: AigcAuditLogOptions["onRecord"]

  constructor(opts: AigcAuditLogOptions = {}) {
    this.maxRecords = opts.maxRecords ?? 10_000
    this.onRecord = opts.onRecord
  }

  record(record: AigcRunRecord): void {
    this.records.push(record)
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords)
    }
    if (this.onRecord) {
      try {
        void Promise.resolve(this.onRecord(record)).catch(() => {})
      } catch {
        // persistence failures must never break a run
      }
    }
  }

  list(): readonly AigcRunRecord[] {
    return this.records
  }

  find(produceId: string): AigcRunRecord | undefined {
    return this.records.find((r) => r.produceId === produceId)
  }
}
