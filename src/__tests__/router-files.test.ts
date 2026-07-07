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
