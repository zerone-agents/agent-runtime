/**
 * File-based custom tool loader.
 *
 * Loads explicitly listed tool script files, dynamically imports each one,
 * and materializes its default export into SDK ToolDefinitions whose names
 * are derived from file names.
 *
 * Tool files are trusted code running with full Node.js privileges.
 * Loading happens once at startup; there is no watching or hot reload.
 */

import { existsSync, statSync } from "node:fs"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolDefinition } from "@zerone-agent/agent-sdk"
import { materializeTool, type FileToolDefinition } from "./define-tool.js"

const TOOL_MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"])

function extensionOf(file: string): string {
  const base = basename(file)
  const dot = base.lastIndexOf(".")
  return dot < 0 ? "" : base.slice(dot)
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  const ext = extensionOf(path)
  if (ext === ".ts" || ext === ".mts") {
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
 * Load the given tool script files into SDK ToolDefinitions.
 *
 * - Paths must already be resolved (the caller resolves them against
 *   configDir); empty list -> [].
 * - Only .ts/.mts/.js/.mjs files are accepted.
 * - File name (without extension) is the tool name; collisions across the
 *   listed files are an error.
 * - Any load/validation failure throws; the caller (registry) decides how to
 *   degrade per agent.
 */
export async function loadToolFiles(paths: string[]): Promise<ToolDefinition[]> {
  if (paths.length === 0) return []

  const tools: ToolDefinition[] = []
  const seen = new Map<string, string>()
  for (const path of paths) {
    const file = basename(path)
    const ext = extensionOf(file)
    if (!TOOL_MODULE_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported tool file "${file}": expected one of ${[...TOOL_MODULE_EXTENSIONS].join(", ")}.`,
      )
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Tool file not found: "${path}".`)
    }

    const mod = await importModule(path)
    const definition = (mod.default ?? undefined) as
      | FileToolDefinition
      | undefined
    if (definition === undefined) {
      throw new Error(
        `Tool file "${file}" must have a default export (export default defineTool({...})).`,
      )
    }

    let tool: ToolDefinition
    try {
      tool = materializeTool(file, definition)
    } catch (err) {
      throw new Error(
        `Failed to load tool file "${file}": ${(err as Error).message}`,
      )
    }

    const prev = seen.get(tool.name)
    if (prev) {
      throw new Error(
        `Tool name collision: "${prev}" and "${path}" both define tool "${tool.name}".`,
      )
    }
    seen.set(tool.name, path)
    tools.push(tool)
  }
  return tools
}
