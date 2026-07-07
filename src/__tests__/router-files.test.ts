import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFilesRouter } from "../router/files.js"

describe("Files Router", () => {
  let tmpRoot: string
  let app: Hono

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "router-files-test-"))
    writeFileSync(join(tmpRoot, "agents.yaml"), "agents: []")
    writeFileSync(join(tmpRoot, "README.md"), "# hi")
    mkdirSync(join(tmpRoot, "src"))
    writeFileSync(join(tmpRoot, "src", "index.ts"), "console.log('hi')")
    mkdirSync(join(tmpRoot, "src", "router"))
    writeFileSync(join(tmpRoot, "src", "router", "agent.ts"), "export {}")

    // strict:false so both /v1/files and /v1/files/ match the mounted sub-router
    // (Hono 4.7 default strict mode treats them as distinct paths)
    app = new Hono({ strict: false })
    app.route("/v1/files", createFilesRouter(tmpRoot))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe("GET /v1/files/", () => {
    it("returns top-level entries", async () => {
      const res = await app.request("http://localhost/v1/files/")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe("")
      const names = body.entries.map((e: any) => e.name)
      expect(names).toContain("agents.yaml")
      expect(names).toContain("README.md")
      expect(names).toContain("src")
    })

    it("supports ?path= to list subdirectory", async () => {
      const res = await app.request("http://localhost/v1/files/?path=src")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe("src")
      const names = body.entries.map((e: any) => e.name)
      // sort order (per files.ts): directories first, then alphabetical — so
      // router/ comes before index.ts
      expect(names).toEqual(["router", "index.ts"])
    })

    it("supports ?recursive=true with nested paths", async () => {
      const res = await app.request("http://localhost/v1/files/?recursive=true")
      expect(res.status).toBe(200)
      const body = await res.json()
      const names = body.entries.map((e: any) => e.name)
      expect(names).toContain("src/index.ts")
      expect(names).toContain("src/router/agent.ts")
    })

    it("supports ?recursive=true&depth=1", async () => {
      const res = await app.request(
        "http://localhost/v1/files/?recursive=true&depth=1",
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      const names = body.entries.map((e: any) => e.name)
      expect(names).toContain("src/index.ts")
      expect(names).toContain("src/router")
      expect(names).not.toContain("src/router/agent.ts")
    })

    it("returns 404 for missing path", async () => {
      const res = await app.request("http://localhost/v1/files/?path=does-not-exist")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("Directory not found")
    })

    it("returns 400 when path is a file", async () => {
      const res = await app.request("http://localhost/v1/files/?path=agents.yaml")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Not a directory")
    })

    it("returns 400 for path traversal attempt", async () => {
      const res = await app.request("http://localhost/v1/files/?path=../etc")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Invalid path")
    })

    it("returns 400 for invalid depth (non-numeric)", async () => {
      const res = await app.request("http://localhost/v1/files/?recursive=true&depth=abc")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Invalid depth parameter")
    })

    it("returns 400 for negative depth", async () => {
      const res = await app.request("http://localhost/v1/files/?recursive=true&depth=-1")
      expect(res.status).toBe(400)
    })
  })
})

describe("Files Router /content", () => {
  let tmpRoot: string
  let app: Hono

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "router-files-content-test-"))
    writeFileSync(join(tmpRoot, "hello.txt"), "Hello, World!")
    writeFileSync(join(tmpRoot, "data.json"), JSON.stringify({ ok: true }))
    mkdirSync(join(tmpRoot, "subdir"))
    // symlink 逃出 cwd：指向 tmpRoot 的父目录
    symlinkSync(tmpRoot, join(tmpRoot, "self-out"), "file")
    // symlink 逃出 cwd：指向 tmpRoot 的父目录
    symlinkSync(join(tmpRoot, ".."), join(tmpRoot, "escape"), "dir")

    app = new Hono()
    app.route("/v1/files", createFilesRouter(tmpRoot))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe("GET /v1/files/content", () => {
    it("streams file content with correct headers", async () => {
      const res = await app.request("http://localhost/v1/files/content?path=hello.txt")
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe("text/plain")
      expect(res.headers.get("Content-Disposition")).toContain("hello.txt")
      expect(res.headers.get("Content-Length")).toBe("13")
      expect(res.headers.get("Accept-Ranges")).toBe("bytes")
      expect(res.headers.get("Last-Modified")).toBeTruthy()
      const body = await res.text()
      expect(body).toBe("Hello, World!")
    })

    it("returns correct Content-Type for json", async () => {
      const res = await app.request("http://localhost/v1/files/content?path=data.json")
      expect(res.headers.get("Content-Type")).toBe("application/json")
    })

    it("handles URL-encoded filenames", async () => {
      writeFileSync(join(tmpRoot, "中文.txt"), "你好")
      const res = await app.request(
        "http://localhost/v1/files/content?path=" + encodeURIComponent("中文.txt"),
      )
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toBe("你好")
      expect(res.headers.get("Content-Disposition")).toContain("UTF-8''")
    })
  })

  describe("HEAD /v1/files/content", () => {
    it("returns same headers as GET but empty body", async () => {
      const res = await app.request("http://localhost/v1/files/content?path=hello.txt", {
        method: "HEAD",
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe("text/plain")
      expect(res.headers.get("Content-Length")).toBe("13")
      expect(res.headers.get("Accept-Ranges")).toBe("bytes")
      const body = await res.text()
      expect(body).toBe("")
    })
  })

  describe("error handling", () => {
    it("returns 400 for path traversal", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=../etc/passwd",
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Invalid path")
    })

    it("returns 400 for absolute path", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=" + encodeURIComponent("/etc/passwd"),
      )
      expect(res.status).toBe(400)
    })

    it("returns 400 for null byte", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=evil%00.txt",
      )
      expect(res.status).toBe(400)
    })

    it("returns 400 when path is a directory", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=subdir",
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe("Not a file")
    })

    it("returns 404 for missing file", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=does-not-exist.txt",
      )
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("File not found")
    })

    it("returns 400 when symlink escapes cwd", async () => {
      const res = await app.request(
        "http://localhost/v1/files/content?path=escape",
      )
      expect(res.status).toBe(400)
    })
  })
})
