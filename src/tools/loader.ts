/**
 * File-based custom tool loader.
 *
 * Scans a `tools/` directory (flat, non-recursive), dynamically imports each
 * module file, and materializes its default export into SDK ToolDefinitions
 * whose names are derived from file names.
 *
 * Tool files are trusted code running with full Node.js privileges.
 * Loading happens once at startup; there is no watching or hot reload.
 */

import { readdirSync, existsSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolDefinition } from "@zerone-agent/agent-sdk"
import { materializeTool, type FileToolDefinition } from "./define-tool.js"

const TOOL_MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"])

function extensionOf(file: string): string {
  const base = basename(file)
  const dot = base.lastIndexOf(".")
  return dot < 0 ? "" : base.slice(dot)
}

function baseNameOf(file: string): string {
  const base = basename(file)
  const dot = base.lastIndexOf(".")
  return dot < 0 ? base : base.slice(0, dot)
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  if (extensionOf(path) === ".ts" || extensionOf(path) === ".mts") {
    try {
      // Same mechanism used for agent.config.ts (see config.ts).
      // @ts-ignore - optional runtime dependency
      await import("tsx/esm")
    } catch {
      throw new Error(
        `Cannot load TypeScript tool file "${path}": the "tsx" package is required to load .ts tool files.`,
      )
    }
  }
  // Cache-busting query keeps repeated loads (e.g. tests) independent.
  return (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as Record<
    string,
    unknown
  >
}

/**
 * Load all tool files in `dir` (first level only) into SDK ToolDefinitions.
 *
 * - Missing/empty directory -> []
 * - File name (without extension) is the tool name; collisions across
 *   extensions (foo.ts + foo.mjs) are an error.
 * - Any load/validation failure throws; the caller (registry) decides how to
 *   degrade per agent.
 */
export async function loadToolDirectory(dir: string): Promise<ToolDefinition[]> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && TOOL_MODULE_EXTENSIONS.has(extensionOf(e.name)))
    .map((e) => e.name)
    .sort()

  const tools: ToolDefinition[] = []
  const seen = new Map<string, string>()
  for (const entry of entries) {
    const name = baseNameOf(entry)
    const prev = seen.get(name)
    if (prev) {
      throw new Error(
        `Tool name collision in "${dir}": "${prev}" and "${entry}" both map to tool "${name}".`,
      )
    }
    seen.set(name, entry)

    const path = join(dir, entry)
    const mod = await importModule(path)
    const definition = (mod.default ?? undefined) as
      | FileToolDefinition
      | undefined
    if (definition === undefined) {
      throw new Error(
        `Tool file "${entry}" in "${dir}" must have a default export (export default defineTool({...})).`,
      )
    }

    try {
      tools.push(materializeTool(name, definition))
    } catch (err) {
      throw new Error(
        `Failed to load tool file "${entry}" in "${dir}": ${(err as Error).message}`,
      )
    }
  }
  return tools
}
