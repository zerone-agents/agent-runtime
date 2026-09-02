/**
 * Deep inspection of logged console arguments (#54 review r2): String(args)
 * collapses structured objects to "[object Object]" and JSON.stringify
 * hides non-enumerable Error fields (message/stack) — both are leak blind
 * spots. This walker renders nested objects, arrays, and Errors
 * (name + message + stack) so a secret anywhere in a logged argument is
 * detectable.
 */
export function deepInspect(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") return String(value)
  if (value instanceof Error) {
    return `${value.name}: ${value.message} ${value.stack ?? ""}`
  }
  if (depth > 6) return "[Depth]"
  if (Array.isArray(value)) {
    return `[${value.map((v) => deepInspect(v, depth + 1)).join(", ")}]`
  }
  try {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([k, v]) => `${k}=${deepInspect(v, depth + 1)}`).join(", ")}}`
  } catch {
    return "[Uninspectable]"
  }
}

/** Render everything captured by console spies through deepInspect. */
export function capturedOutput(callSets: unknown[][][]): string {
  return callSets
    .flat()
    .map((call) => call.map((arg) => deepInspect(arg)).join(" "))
    .join("\n")
}