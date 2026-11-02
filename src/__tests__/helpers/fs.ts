import { rmSync } from "node:fs"

/**
 * rmSync 带重试：SDK 的异步落盘（SessionStore flush / SnapshotEngine 快照）
 * 可能在测试结束后才写入文件，与 readdir→unlink 竞态出 ENOTEMPTY
 * （同类于 hub-push #30 的 transcript 竞态）。afterAll 清理用。
 */
export async function rmRetryAsync(dir: string, attempts = 5, delayMs = 50): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}
