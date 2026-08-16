import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadToolDirectory } from "../tools/loader.js"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

// Fixture tool files live in os.tmpdir(), which cannot resolve bare "zod"
// imports — import the installed package by absolute file URL instead.
const zodUrl = pathToFileURL(createRequire(import.meta.url).resolve("zod")).href

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "file-tools-"))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function writeTool(rel: string, content: string): void {
  const p = join(tmpRoot, rel)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, content)
}

const HELLO_TOOL = `
import { z } from ${JSON.stringify(zodUrl)}
export default {
  description: "Say hello",
  inputSchema: z.object({ who: z.string().optional() }),
  async execute(input) { return "hello " + (input.who ?? "world") },
}
`

describe("loadToolDirectory", () => {
  it("returns [] when the directory does not exist", async () => {
    const tools = await loadToolDirectory(join(tmpRoot, "nope"))
    expect(tools).toEqual([])
  })

  it("returns [] for an empty directory", async () => {
    mkdirSync(join(tmpRoot, "tools"), { recursive: true })
    const tools = await loadToolDirectory(join(tmpRoot, "tools"))
    expect(tools).toEqual([])
  })

  it("loads a .ts tool file and derives the name from the file name", async () => {
    writeTool("tools/say_hello.ts", HELLO_TOOL)
    const tools = await loadToolDirectory(join(tmpRoot, "tools"))
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("say_hello")
    expect(tools[0].description).toBe("Say hello")
  })

  it("loads .js and .mjs files", async () => {
    writeTool("tools/a.js", HELLO_TOOL)
    writeTool("tools/b.mjs", HELLO_TOOL)
    const tools = await loadToolDirectory(join(tmpRoot, "tools"))
    expect(tools.map((t) => t.name).sort()).toEqual(["a", "b"])
  })

  it("ignores non-module files and subdirectories", async () => {
    writeTool("tools/real.ts", HELLO_TOOL)
    writeTool("tools/notes.md", "# not a tool")
    writeTool("tools/nested/inner.ts", HELLO_TOOL)
    const tools = await loadToolDirectory(join(tmpRoot, "tools"))
    expect(tools.map((t) => t.name)).toEqual(["real"])
  })

  it("rejects name collisions across extensions (foo.ts + foo.mjs)", async () => {
    writeTool("tools/dup.ts", HELLO_TOOL)
    writeTool("tools/dup.mjs", HELLO_TOOL)
    await expect(loadToolDirectory(join(tmpRoot, "tools"))).rejects.toThrow(/dup/)
  })

  it("throws when a file has no default export", async () => {
    writeTool("tools/no_default.ts", `export const x = 1\n`)
    await expect(loadToolDirectory(join(tmpRoot, "tools"))).rejects.toThrow(
      /no_default/,
    )
  })

  it("throws with file context when the definition is invalid", async () => {
    writeTool(
      "tools/bad.ts",
      `export default { description: "missing execute" }\n`,
    )
    await expect(loadToolDirectory(join(tmpRoot, "tools"))).rejects.toThrow(
      /bad/,
    )
  })

  it("produces callable tools whose execute runs with input", async () => {
    writeTool("tools/say_hello.ts", HELLO_TOOL)
    const [tool] = await loadToolDirectory(join(tmpRoot, "tools"))
    const result = await tool.call({ who: "zerone" }, {} as any)
    expect(result.is_error).toBe(false)
    expect(String(result.content)).toContain("hello zerone")
  })
})
