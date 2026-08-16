import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadToolFiles } from "../tools/loader.js"
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

function writeTool(rel: string, content: string): string {
  const p = join(tmpRoot, rel)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, content)
  return p
}

const HELLO_TOOL = (name: string) => `
import { z } from ${JSON.stringify(zodUrl)}
export default {
  name: ${JSON.stringify(name)},
  description: "Say hello",
  inputSchema: z.object({ who: z.string().optional() }),
  async execute(input) { return "hello " + (input.who ?? "world") },
}
`

describe("loadToolFiles", () => {
  it("returns [] for an empty list", async () => {
    expect(await loadToolFiles([])).toEqual([])
  })

  it("loads a .ts tool file and takes the name from the definition", async () => {
    const p = writeTool("tools/say_hello.ts", HELLO_TOOL("SayHello"))
    const tools = await loadToolFiles([p])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("SayHello")
    expect(tools[0].description).toBe("Say hello")
  })

  it("loads .js and .mjs files from different directories", async () => {
    const a = writeTool("x/a.js", HELLO_TOOL("A"))
    const b = writeTool("y/b.mjs", HELLO_TOOL("B"))
    const tools = await loadToolFiles([a, b])
    expect(tools.map((t) => t.name).sort()).toEqual(["A", "B"])
  })

  it("rejects unsupported file extensions", async () => {
    const p = writeTool("tools/notes.md", "# not a tool")
    await expect(loadToolFiles([p])).rejects.toThrow(/notes\.md/)
  })

  it("rejects name collisions across listed files (same defined name)", async () => {
    const a = writeTool("x/dup.ts", HELLO_TOOL("Same"))
    const b = writeTool("y/other.mjs", HELLO_TOOL("Same"))
    await expect(loadToolFiles([a, b])).rejects.toThrow(/Same/)
  })

  it("throws when a file does not exist", async () => {
    await expect(
      loadToolFiles([join(tmpRoot, "missing.ts")]),
    ).rejects.toThrow(/missing\.ts/)
  })

  it("throws when a file has no default export", async () => {
    const p = writeTool("tools/no_default.ts", `export const x = 1\n`)
    await expect(loadToolFiles([p])).rejects.toThrow(/no_default/)
  })

  it("throws with file context when the definition is invalid", async () => {
    const p = writeTool(
      "tools/bad.ts",
      `export default { description: "missing execute" }\n`,
    )
    await expect(loadToolFiles([p])).rejects.toThrow(/bad/)
  })

  it("produces callable tools whose execute runs with input", async () => {
    const p = writeTool("tools/say_hello.ts", HELLO_TOOL("SayHello"))
    const [tool] = await loadToolFiles([p])
    const result = await tool.call({ who: "zerone" }, {} as any)
    expect(result.is_error).toBe(false)
    expect(String(result.content)).toContain("hello zerone")
  })
})
