/**
 * File-based custom tools: authoring helper + materialization.
 *
 * Responsibilities:
 * - `defineTool()` is a pure authoring helper (type inference, editor hints).
 *   It never scans, registers, or executes anything.
 * - `materializeTool()` turns an authored definition into an SDK
 *   `ToolDefinition`, deriving the tool name from the file name.
 *
 * The executable tool protocol (`ToolDefinition`, `customTools`) belongs to
 * the SDK; the filesystem convention belongs to this runtime.
 */

import { sdkToolToToolDefinition } from "@zerone-agent/agent-sdk"
import type {
  ToolDefinition,
  ToolAnnotations,
} from "@zerone-agent/agent-sdk"
import type { z, ZodObject, ZodRawShape } from "zod"

export interface FileToolDefinition<T extends ZodRawShape = ZodRawShape> {
  description: string
  inputSchema: ZodObject<T>
  execute: (
    input: z.infer<ZodObject<T>>,
    context: unknown,
  ) => Promise<unknown> | unknown
  annotations?: ToolAnnotations
}

/**
 * Authoring helper for `tools/*.ts` files. Returns the definition unchanged;
 * the runtime (loadToolDirectory) gives the file its runtime meaning.
 */
export function defineTool<T extends ZodRawShape>(
  definition: FileToolDefinition<T>,
): FileToolDefinition<T> {
  return definition
}

function fail(fileName: string, message: string): never {
  throw new Error(`Invalid tool definition for "${fileName}": ${message}`)
}

/**
 * Turn an authored definition into an SDK ToolDefinition.
 *
 * `fileName` is the tool name (file base name without extension), derived by
 * the caller. Authored `name` fields are rejected to prevent drift between
 * the file name and the declared name.
 */
export function materializeTool(
  fileName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: FileToolDefinition<any>,
): ToolDefinition {
  if (!definition || typeof definition !== "object") {
    fail(fileName, "expected a tool definition object (default export)")
  }
  if ("name" in definition) {
    fail(
      fileName,
      `must not declare "name"; the tool name is derived from the file name ("${fileName}")`,
    )
  }
  if (typeof definition.description !== "string" || !definition.description) {
    fail(fileName, `"description" must be a non-empty string`)
  }
  if (!definition.inputSchema || typeof definition.inputSchema !== "object") {
    fail(fileName, `"inputSchema" must be a zod object schema`)
  }
  if (typeof definition.execute !== "function") {
    fail(fileName, `"execute" must be a function`)
  }

  return sdkToolToToolDefinition({
    name: fileName,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    handler: async (args, extra) => {
      const output = await definition.execute(args, extra)
      return {
        content: [
          {
            type: "text" as const,
            text: typeof output === "string" ? output : JSON.stringify(output),
          },
        ],
      }
    },
  })
}
