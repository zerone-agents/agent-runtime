import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import sharp from "sharp"
import { createAgentRouter } from "../router/agent.js"
import { RunRegistry } from "../runs.js"

// 附件 run 集成测试走快照物化（依赖内核 fd 绑定）；无 /proc/self/fd 的
// 平台 fail-closed 拒绝，由 attachments.test.ts 的 itFallback 反向覆盖
const describeProcfs = existsSync("/proc/self/fd") ? describe : describe.skip

vi.mock("../sse.js", () => ({
  streamAgentResponse: vi.fn().mockReturnValue(new Response("sse-stream", { status: 200 })),
}))

const metrics: any = { recordRun: vi.fn() }

function makeAgent() {
  const queryStream = (async function* () {})()
  return {
    query: vi.fn().mockReturnValue(queryStream),
    prompt: vi.fn().mockResolvedValue({
      text: "ok", usage: {}, num_turns: 1, duration_ms: 5,
    }),
    getSessionId: vi.fn().mockReturnValue("s1"),
    close: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
  }
}

function makeApp(tmpRoot: string, agent: ReturnType<typeof makeAgent>) {
  const registry: any = {
    list: vi.fn(),
    create: vi.fn().mockReturnValue(agent),
    getStatus: vi.fn().mockReturnValue("ready"),
    getModel: vi.fn().mockReturnValue("test-model"),
  }
  const app = new Hono({ strict: false })
  app.route("/v1/agents", createAgentRouter(registry, new RunRegistry(), metrics, { cwd: tmpRoot }))
  return { app, registry }
}

async function stageUpload(tmpRoot: string, name: string, bytes: Buffer) {
  const dir = join(tmpRoot, ".zerone-uploads")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), bytes)
  return {
    id: randomUUID(), name, mime: "application/octet-stream",
    size: bytes.length, path: `.zerone-uploads/${name}`,
  }
}

describeProcfs("POST /v1/agents/:agentId/runs with attachments", () => {
  let tmpRoot: string
  beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "agent-attachments-")) })
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

  const post = (app: Hono, body: unknown, accept?: string) =>
    app.request("/v1/agents/a1/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accept ? { Accept: accept } : {}),
      },
      body: JSON.stringify(body),
    })

  it("legacy message-only request passes the plain string (compat)", async () => {
    const agent = makeAgent()
    const { app } = makeApp(tmpRoot, agent)
    const res = await post(app, { message: "hi" })
    expect(res.status).toBe(200)
    expect(agent.query.mock.calls[0][0]).toBe("hi")
  })

  it("attachments: null behaves like absent", async () => {
    const agent = makeAgent()
    const { app } = makeApp(tmpRoot, agent)
    const res = await post(app, { message: "hi", attachments: null })
    expect(res.status).toBe(200)
    expect(agent.query.mock.calls[0][0]).toBe("hi")
  })

  it("non-array attachments → 400 invalid_attachment, no agent created", async () => {
    const agent = makeAgent()
    const { app, registry } = makeApp(tmpRoot, agent)
    const res = await post(app, { message: "hi", attachments: "oops" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "invalid_attachment" })
    expect(registry.create).not.toHaveBeenCalled()
  })

  it("missing file → 400 attachment_missing with path, no agent created", async () => {
    const agent = makeAgent()
    const { app, registry } = makeApp(tmpRoot, agent)
    const att = { id: "x", name: "g.pdf", mime: "application/pdf", size: 1, path: ".zerone-uploads/ghost.pdf" }
    const res = await post(app, { message: "hi", attachments: [att] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "attachment_missing", path: ".zerone-uploads/ghost.pdf" })
    expect(registry.create).not.toHaveBeenCalled()
  })

  it("traversal path → 400 invalid_attachment", async () => {
    const agent = makeAgent()
    const { app } = makeApp(tmpRoot, agent)
    const att = { id: "x", name: "e", mime: "m", size: 3, path: "../agents.yaml" }
    const res = await post(app, { message: "hi", attachments: [att] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "invalid_attachment" })
  })

  it("more than 10 descriptors → 413 upload_limit_exceeded", async () => {
    const agent = makeAgent()
    const { app } = makeApp(tmpRoot, agent)
    const list = Array.from({ length: 11 }, () => ({
      id: "x", name: "f", mime: "m", size: 0, path: ".zerone-uploads/f",
    }))
    const res = await post(app, { message: "hi", attachments: list })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: "upload_limit_exceeded" })
  })

  it("real image attachment → query receives [text, image] blocks (SSE default)", async () => {
    const png = await sharp({ create: { width: 6, height: 6, channels: 3, background: "#ff0000" } }).png().toBuffer()
    const att = await stageUpload(tmpRoot, "img.png", png)
    const agent = makeAgent()
    const { app } = makeApp(tmpRoot, agent)
    const res = await post(app, { message: "看图", attachments: [att] })
    expect(res.status).toBe(200)
    const input = agent.query.mock.calls[0][0]
    expect(Array.isArray(input)).toBe(true)
    expect(input[0].type).toBe("text")
    expect(input[0].text).toMatch(/\.zerone-uploads\/snap-[0-9a-f]{8}-img\.png/)
    expect(input[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
    })
  })

  it("normal file attachment → query receives text with Read instruction", async () => {
    const att = await stageUpload(tmpRoot, "doc.pdf", Buffer.from("%PDF-fake"))
    const agent = makeAgent()
    const { app } = makeApp(tmpRoot, agent)
    const res = await post(app, { message: "总结", attachments: [att] })
    expect(res.status).toBe(200)
    const input = agent.query.mock.calls[0][0]
    expect(Array.isArray(input)).toBe(true)
    expect(input).toHaveLength(1)
    expect(input[0].text).toContain("请使用 Read 工具读取后再回答")
    expect(input[0].text).toMatch(/\.zerone-uploads\/snap-[0-9a-f]{8}-doc\.pdf/)
  })

  it("JSON blocking mode: prompt receives blocks and returns 200", async () => {
    const att = await stageUpload(tmpRoot, "doc.pdf", Buffer.from("%PDF-fake"))
    const agent = makeAgent()
    const { app } = makeApp(tmpRoot, agent)
    const res = await post(app, { message: "总结", attachments: [att] }, "application/json")
    expect(res.status).toBe(200)
    const input = agent.prompt.mock.calls[0][0]
    expect(Array.isArray(input)).toBe(true)
    expect((await res.json()).text).toBe("ok")
  })
})
