import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createFilesRouter } from "../router/files.js"
import { createAgentRouter } from "../router/agent.js"
import { createHealthRouter } from "../router/health.js"
import { RunRegistry } from "../runs.js"
import { CONTAINER_ID_ENV } from "../container-id.js"

// 端点验收测试与宿主环境隔离（review R2 P1）：CI 宿主（Linux VM）存在真实
// /etc/hostname（非 12-hex）与 /proc/self/cgroup，会与注入的 env 身份构成
// 矛盾 → 预期 412/200 被 503 覆盖。mock 三类身份来源为"不存在"，身份仅由
// env 注入决定；来源矩阵的细粒度单元覆盖保留在 container-id.test.ts。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, readFileSync: () => null }
})

// 走快照物化的正向用例依赖内核 fd 绑定（/proc/self/fd）
const describeProcfs = existsSync("/proc/self/fd") ? describe : describe.skip

// issue #61：三入口（uploads / content / 带 attachments 的 run）的
// X-Expected-Container-Id 原子校验。身份经 env 注入（deployer/测试通道）；
// unavailable 用例删除 env 后依赖宿主检测不到容器身份（CI VM / macOS 成立）。

const FULL_A = "a".repeat(64)
const FULL_B = "b".repeat(64)

const HDR = { "X-Expected-Container-Id": FULL_A }
const HDR_MISMATCH = { "X-Expected-Container-Id": FULL_B }

let savedEnv: string | undefined
beforeEach(() => {
  savedEnv = process.env[CONTAINER_ID_ENV]
  process.env[CONTAINER_ID_ENV] = FULL_A
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env[CONTAINER_ID_ENV]
  else process.env[CONTAINER_ID_ENV] = savedEnv
})

function formRequest(path: string, headers?: Record<string, string>): Request {
  const fd = new FormData()
  fd.append("files", new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" }))
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: fd })
}

function makeAgentApp(tmpRoot: string) {
  const agent = { query: vi.fn(), close: vi.fn(), interrupt: vi.fn() }
  const registry: any = {
    list: vi.fn(),
    create: vi.fn().mockReturnValue(agent),
    getStatus: vi.fn().mockReturnValue("ready"),
    getModel: vi.fn().mockReturnValue("test-model"),
  }
  const metrics: any = { recordRun: vi.fn() }
  const app = new Hono({ strict: false })
  app.route("/v1/agents", createAgentRouter(registry, new RunRegistry(), metrics, { cwd: tmpRoot }))
  return { app, registry, agent }
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

describe("GET /health capabilities（能力发现，issue #61）", () => {
  it("声明 attachmentExpectedGeneration: true（Hub 探测后启用附件入口）", async () => {
    const registry: any = { list: vi.fn(() => []) }
    const app = new Hono({ strict: false })
    app.route("/health", createHealthRouter(registry))
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.capabilities).toEqual({ attachmentExpectedGeneration: true })
  })
})

describe("X-Expected-Container-Id: POST /v1/files/uploads", () => {
  let tmpRoot: string
  let app: Hono
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gen-uploads-"))
    app = new Hono({ strict: false })
    app.route("/v1/files", createFilesRouter(tmpRoot))
  })
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

  it("mismatch → 412 generation_mismatch，无任何上传写入（原子性）", async () => {
    const res = await app.request(formRequest("/v1/files/uploads", HDR_MISMATCH))
    expect(res.status).toBe(412)
    const body = await res.json()
    expect(body).toMatchObject({ code: "generation_mismatch" })
    // 不回显敏感信息：错误体不含 expected 值或自身身份
    const bodyText = JSON.stringify(body)
    expect(bodyText).not.toContain(FULL_A.slice(0, 24))
    expect(bodyText).not.toContain(FULL_B.slice(0, 24))
    expect(existsSync(join(tmpRoot, ".zerone-uploads"))).toBe(false)
  })

  it("TOCTOU：查询返回 A 后、请求处理前容器切到 B → 拒绝且零写入", async () => {
    // 模拟 Hub 前置查询拿到 A（Header 携带 A），请求实际由 recreate 后的 B 处理
    process.env[CONTAINER_ID_ENV] = FULL_B
    const res = await app.request(formRequest("/v1/files/uploads", HDR))
    expect(res.status).toBe(412)
    expect(await res.json()).toMatchObject({ code: "generation_mismatch" })
    expect(existsSync(join(tmpRoot, ".zerone-uploads"))).toBe(false)
  })

  it("身份不可确定 → 503 generation_unavailable，禁止忽略 Header 继续", async () => {
    delete process.env[CONTAINER_ID_ENV]
    const res = await app.request(formRequest("/v1/files/uploads", HDR))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "generation_unavailable" })
    expect(existsSync(join(tmpRoot, ".zerone-uploads"))).toBe(false)
  })

  it("expected 非完整 64-hex（12 位前缀形态）→ 412 mismatch（不接受过短前缀）", async () => {
    const res = await app.request(
      formRequest("/v1/files/uploads", { "X-Expected-Container-Id": FULL_A.slice(0, 12) }),
    )
    expect(res.status).toBe(412)
    expect(await res.json()).toMatchObject({ code: "generation_mismatch" })
  })
})

describe("X-Expected-Container-Id: GET /v1/files/content", () => {
  let tmpRoot: string
  let app: Hono
  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gen-content-"))
    await stageUpload(tmpRoot, "a.txt", Buffer.from("GEN-CONTENT"))
    app = new Hono({ strict: false })
    app.route("/v1/files", createFilesRouter(tmpRoot))
  })
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

  const get = (headers?: Record<string, string>) =>
    app.request(`/v1/files/content?path=${encodeURIComponent(".zerone-uploads/a.txt")}`, { headers })

  it("mismatch → 412 generation_mismatch（读取前拒绝）", async () => {
    const res = await get(HDR_MISMATCH)
    expect(res.status).toBe(412)
    expect(await res.json()).toMatchObject({ code: "generation_mismatch" })
  })

  it("身份不可确定 → 503 generation_unavailable", async () => {
    delete process.env[CONTAINER_ID_ENV]
    const res = await get(HDR)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "generation_unavailable" })
  })

  it("TOCTOU：查询返回 A 后、请求处理前容器切到 B → 读取前拒绝", async () => {
    process.env[CONTAINER_ID_ENV] = FULL_B
    const res = await get(HDR)
    expect(res.status).toBe(412)
    expect(await res.json()).toMatchObject({ code: "generation_mismatch" })
  })

  it("Header 缺失 → 旧行为（200 下载）", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("GEN-CONTENT")
  })
})

describe("X-Expected-Container-Id: POST /v1/agents/:agentId/runs（带附件）", () => {
  let tmpRoot: string
  beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "gen-run-")) })
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

  const post = (app: Hono, body: unknown, headers?: Record<string, string>) =>
    app.request("/v1/agents/a1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  it("mismatch → 412：不启动 run（registry.create / agent.query 均未调用），无 SSE 内容", async () => {
    const att = await stageUpload(tmpRoot, "doc.txt", Buffer.from("SAFE"))
    const { app, registry, agent } = makeAgentApp(tmpRoot)
    const res = await post(app, { message: "hi", attachments: [att] }, HDR_MISMATCH)
    expect(res.status).toBe(412)
    expect(await res.json()).toMatchObject({ code: "generation_mismatch" })
    expect(registry.create).not.toHaveBeenCalled()
    expect(agent.query).not.toHaveBeenCalled()
  })

  it("mismatch + SSE Accept → 412 JSON 错误（未进入事件流，无内容可 flush）", async () => {
    const att = await stageUpload(tmpRoot, "doc.txt", Buffer.from("SAFE"))
    const { app, agent } = makeAgentApp(tmpRoot)
    const res = await post(app, { message: "hi", attachments: [att] }, { ...HDR_MISMATCH, Accept: "text/event-stream" })
    expect(res.status).toBe(412)
    expect(res.headers.get("content-type")).not.toContain("text/event-stream")
    expect(agent.query).not.toHaveBeenCalled()
  })

  it("身份不可确定 → 503：不启动 run", async () => {
    delete process.env[CONTAINER_ID_ENV]
    const att = await stageUpload(tmpRoot, "doc.txt", Buffer.from("SAFE"))
    const { app, registry } = makeAgentApp(tmpRoot)
    const res = await post(app, { message: "hi", attachments: [att] }, HDR)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "generation_unavailable" })
    expect(registry.create).not.toHaveBeenCalled()
  })

  it("TOCTOU：查询返回 A 后、请求处理前容器切到 B → run 启动前拒绝（无 query、无 message 产生）", async () => {
    const att = await stageUpload(tmpRoot, "doc.txt", Buffer.from("SAFE"))
    const { app, registry, agent } = makeAgentApp(tmpRoot)
    process.env[CONTAINER_ID_ENV] = FULL_B
    const res = await post(app, { message: "hi", attachments: [att] }, HDR)
    expect(res.status).toBe(412)
    expect(await res.json()).toMatchObject({ code: "generation_mismatch" })
    expect(registry.create).not.toHaveBeenCalled()
    expect(agent.query).not.toHaveBeenCalled()
  })

  it("mismatch 但无 attachments → 不校验（向后兼容，run 正常）", async () => {
    const { app, agent } = makeAgentApp(tmpRoot)
    const res = await post(app, { message: "hi" }, HDR_MISMATCH)
    expect(res.status).toBe(200)
    expect(agent.query).toHaveBeenCalled()
  })

  describeProcfs("Header 缺失/匹配的正向路径（依赖 /proc/self/fd）", () => {
    it("Header 缺失 + attachments → 旧行为（run 正常启动）", async () => {
      const att = await stageUpload(tmpRoot, "doc.txt", Buffer.from("SAFE"))
      const { app, agent } = makeAgentApp(tmpRoot)
      const res = await post(app, { message: "hi", attachments: [att] })
      expect(res.status).toBe(200)
      expect(agent.query).toHaveBeenCalled()
    })

    it("匹配 Header + attachments → 正常 run（校验通过不改变行为）", async () => {
      const att = await stageUpload(tmpRoot, "doc.txt", Buffer.from("SAFE"))
      const { app, agent } = makeAgentApp(tmpRoot)
      const res = await post(app, { message: "hi", attachments: [att] }, HDR)
      expect(res.status).toBe(200)
      expect(agent.query).toHaveBeenCalled()
    })
  })
})
