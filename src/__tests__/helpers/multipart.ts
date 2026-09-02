/**
 * 共享 multipart 测试辅助（review PR #48 P3）：手工构造流式 multipart body，
 * 限额测试用大流量分块（共享 1MB 零填充 buffer 的视图，内存 ≈1MB）。
 */
import { Readable } from "node:stream"

export const MB = 1024 * 1024

export function multipartStream(
  parts: { filename: string; type?: string; chunks: Buffer[] }[],
  boundary = "testbound",
): { contentType: string; body: ReadableStream<Uint8Array> } {
  const out: Buffer[] = []
  for (const p of parts) {
    const headers = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="files"; filename="${p.filename}"`,
      ...(p.type ? [`Content-Type: ${p.type}`] : []),
      "",
      "",
    ].join("\r\n")
    out.push(Buffer.from(headers), ...p.chunks, Buffer.from("\r\n"))
  }
  out.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Readable.toWeb(Readable.from(out)) as unknown as ReadableStream<Uint8Array>,
  }
}

/** totalBytes 的载荷：n 个共享同一块 1MB 零填充 buffer 的视图（内存 ≈1MB） */
export function bigChunks(totalBytes: number): Buffer[] {
  const chunkSize = MB
  const zero = Buffer.alloc(chunkSize)
  const n = Math.ceil(totalBytes / chunkSize)
  return Array.from(
    { length: n },
    (_, i) => (i === n - 1 ? zero.subarray(0, totalBytes - (n - 1) * chunkSize) : zero),
  )
}
