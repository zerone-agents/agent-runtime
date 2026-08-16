import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool, materializeTool } from "../tools/define-tool.js"

const echoDef = {
  name: "Echo",
  description: "Echo the input text",
  inputSchema: z.object({ text: z.string() }),
  async execute(input: { text: string }) {
    return `echo: ${input.text}`
  },
}

describe("defineTool", () => {
  it("returns the definition unchanged (authoring helper only)", () => {
    const def = defineTool(echoDef)
    expect(def).toBe(echoDef)
  })
})

describe("materializeTool", () => {
  it("takes the tool name from the definition (SDK convention)", () => {
    const tool = materializeTool("get_weather", defineTool(echoDef))
    expect(tool.name).toBe("Echo")
    expect(tool.description).toBe("Echo the input text")
  })

  it("rejects definitions missing a name", () => {
    const { name: _name, ...def } = echoDef
    expect(() => materializeTool("get_weather", def as any)).toThrow(/name/)
  })

  it("rejects definitions missing description", () => {
    const def = { name: "Echo", inputSchema: echoDef.inputSchema, execute: echoDef.execute } as any
    expect(() => materializeTool("get_weather", def)).toThrow(/description/)
  })

  it("rejects definitions whose execute is not a function", () => {
    const def = defineTool({ ...echoDef, execute: "nope" } as any)
    expect(() => materializeTool("get_weather", def)).toThrow(/execute/)
  })

  it("rejects definitions missing inputSchema", () => {
    const def = { name: "Echo", description: "x", execute: echoDef.execute } as any
    expect(() => materializeTool("get_weather", def)).toThrow(/inputSchema/)
  })

  it("produces a JSON object schema consumable by the SDK", () => {
    const tool = materializeTool("get_weather", defineTool(echoDef))
    expect(tool.inputSchema.type).toBe("object")
    expect(tool.inputSchema.properties.text).toMatchObject({ type: "string" })
    expect(tool.inputSchema.required).toEqual(["text"])
  })

  it("runs execute with validated input and returns text content", async () => {
    const tool = materializeTool("get_weather", defineTool(echoDef))
    const result = await tool.call({ text: "hi" }, {} as any)
    expect(result.is_error).toBe(false)
    expect(String(result.content)).toContain("echo: hi")
  })

  it("returns is_error when input fails schema validation", async () => {
    const tool = materializeTool("get_weather", defineTool(echoDef))
    const result = await tool.call({ text: 42 }, {} as any)
    expect(result.is_error).toBe(true)
  })

  it("returns is_error when execute throws", async () => {
    const tool = materializeTool(
      "get_weather",
      defineTool({
        ...echoDef,
        async execute() {
          throw new Error("boom")
        },
      }),
    )
    const result = await tool.call({ text: "hi" }, {} as any)
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain("boom")
  })

  it("maps readOnlyHint annotation to isReadOnly/isConcurrencySafe", () => {
    const tool = materializeTool(
      "get_weather",
      defineTool({ ...echoDef, annotations: { readOnlyHint: true } }),
    )
    expect(tool.isReadOnly?.()).toBe(true)
    expect(tool.isConcurrencySafe?.()).toBe(true)
  })
})
