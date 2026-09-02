import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFilesRouter } from "../router/files.js"
import { createAuthMiddleware } from "../auth.js"
import { MB, multipartStream, bigChunks } from "./helpers/multipart.js"

function formRequest(path: string, files: { name: string; type: string; bytes: Uint8Array }[]): Request {
  const fd = new FormData()
  for (const f of files) {
    fd.append("files", new File([f.bytes], f.name, { type: f.type }))
  }
  return new Request(`http://localhost${path}`, { method: "POST", body: fd })
}

describe("POST /v1/files/uploads", () => {
  let tmpRoot: string
  let app: Hono

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "router-uploads-"))
    app = new Hono({ strict: false })
    app.route("/v1/files", createFilesRouter(tmpRoot))
  })
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

  const uploadsDir = () => join(tmpRoot, ".zerone-uploads")

  it("returns 201 with file metadata", async () => {
    const res = await app.request(
      formRequest("/v1/files/uploads", [
        { name: "a.pdf", type: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
        { name: "b.txt", type: "text/plain", bytes: new Uint8Array([4]) },
      ]),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.files).toHaveLength(2)
    expect(body.files[0]).toMatchObject({
      name: "a.pdf", mime: "application/pdf", size: 3, path: ".zerone-uploads/a.pdf",
    })
    expect(body.files[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(readdirSync(uploadsDir()).sort()).toEqual(["a.pdf", "b.txt"])
  })

  it("renames duplicate filenames within one request", async () => {
    const res = await app.request(
      formRequest("/v1/files/uploads", [
        { name: "dup.pdf", type: "application/pdf", bytes: new Uint8Array([1]) },
        { name: "dup.pdf", type: "application/pdf", bytes: new Uint8Array([1, 2]) },
      ]),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.files.map((f: any) => f.path)).toEqual([
      ".zerone-uploads/dup.pdf", ".zerone-uploads/dup-2.pdf",
    ])
  })

  it("concurrent requests with the same filename never overwrite", async () => {
    const [r1, r2] = await Promise.all([
      app.request(formRequest("/v1/files/uploads", [{ name: "dup.pdf", type: "application/pdf", bytes: new Uint8Array([1]) }])),
      app.request(formRequest("/v1/files/uploads", [{ name: "dup.pdf", type: "application/pdf", bytes: new Uint8Array([2]) }])),
    ])
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    const names = [(await r1.json()).files[0].name, (await r2.json()).files[0].name].sort()
    expect(names).toEqual(["dup-2.pdf", "dup.pdf"])
    expect(readdirSync(uploadsDir()).sort()).toEqual(["dup-2.pdf", "dup.pdf"])
  })

  it("rejects non-multipart content type with 400 invalid_multipart", async () => {
    const res = await app.request("/v1/files/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "invalid_multipart" })
  })

  it("enforces single-file limit with 413 and cleans up (all-or-none)", async () => {
    // 先成功上传一个文件，验证失败请求不影响既有产物
    const ok = await app.request(
      formRequest("/v1/files/uploads", [{ name: "keep.pdf", type: "application/pdf", bytes: new Uint8Array([9]) }]),
    )
    expect(ok.status).toBe(201)

    const { contentType, body } = multipartStream([
      { filename: "small.txt", type: "text/plain", chunks: [Buffer.from("ok")] },
      { filename: "big.bin", chunks: bigChunks(20 * MB + 1) },
    ])
    const res = await app.request("/v1/files/uploads", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      // undici 流式 body 需要 duplex；TS 类型不识别时用双重初始化对象绕过类型层
      ...( { duplex: "half" } as object),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: "upload_limit_exceeded" })
    expect(readdirSync(uploadsDir())).toEqual(["keep.pdf"])
  })

  it("is protected by the API key middleware (401 without/with wrong key)", async () => {
    const secured = new Hono({ strict: false })
    secured.use("/v1/*", createAuthMiddleware("secret"))
    secured.route("/v1/files", createFilesRouter(tmpRoot))

    const noKey = await secured.request(
      formRequest("/v1/files/uploads", [{ name: "a.pdf", type: "application/pdf", bytes: new Uint8Array([1]) }]),
    )
    expect(noKey.status).toBe(401)

    const wrongKey = await secured.request("/v1/files/uploads", {
      method: "POST",
      headers: { "x-api-key": "nope" },
    })
    expect(wrongKey.status).toBe(401)

    const ok = await secured.request("/v1/files/uploads", {
      method: "POST",
      headers: { "x-api-key": "secret", "Content-Type": "application/pdf" },
      body: "x",
    })
    expect(ok.status).toBe(400) // 鉴权通过，进入 multipart 校验
  })
})
