/**
 * File-based custom tools: authoring helper + materialization.
 *
 * Responsibilities:
 * - `defineTool()` is a pure authoring helper (type inference, editor hints).
 *   It never scans, registers, or executes anything.
 * - `materializeTool()` turns an authored definition into an SDK
 *   `ToolDefinition`; the definition's required `name` is the tool name.
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
  /** Tool name, consistent with the SDK's ToolDefinition/tool() contract. */
  name: string
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
 * The tool name comes from the definition's required `name` field
 * (consistent with the SDK's ToolDefinition contract); `fileName` is only
 * used for error messages.
 */
export function materializeTool(
  fileName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: FileToolDefinition<any>,
): ToolDefinition {
  if (!definition || typeof definition !== "object") {
    fail(fileName, "expected a tool definition object (default export)")
  }
  if (typeof definition.name !== "string" || !definition.name) {
    fail(fileName, `"name" must be a non-empty string`)
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
    name: definition.name,
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
