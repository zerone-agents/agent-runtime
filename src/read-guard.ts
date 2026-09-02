/**
 * Read 工具防护（review PR #48 R3 P1）：SDK FileReadTool 对 `.zerone-uploads`
 * 子树的读取在执行处强制 containment——lstat 拒绝 symlink 终点，realpath
 * 必须落在真实上传目录内。上传物/快照是 runtime 托管内容，校验后被换链
 * 的路径在此被拒绝；uploads 之外的路径原样透传（不改变既有 Agent 行为）。
 *
 * 注入方式：registry 将本工具作为 customTools 传入——SDK 工具池合并时
 * custom 晚于内置工具且 later-wins 去重（resolve-agent 契约），同名
 * "Read" 即完成接管。
 */
import { lstat, realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { FileReadTool } from "@zerone-agent/agent-sdk"
import { UPLOADS_DIR } from "./uploads.js"

/**
 * allowedTools 语义保持：SDK 的 allow-list 只约束内置工具、custom 工具
 * 绕过，因此接管内置 Read 的防护工具需自行判定内置 Read 是否被放行；
 * disallowedTools 作用于合并后的池，同名会被一并拒绝，无需处理。
 */
export function readGuardApplies(allowedTools?: string[]): boolean {
  if (!allowedTools || allowedTools.length === 0) return true
  return allowedTools.some(
    (entry) =>
      entry === "Read" ||
      (entry.endsWith("*") && entry.length > 1 && "Read".startsWith(entry.slice(0, -1))),
  )
}

/** 构建接管内置 Read 的防护工具：uploads 子树执行处 containment，其余透传。 */
export function buildReadGuardTool(cwd: string): typeof FileReadTool {
  const uploadsRoot = resolve(cwd, UPLOADS_DIR)
  return {
    ...FileReadTool,
    async call(input, context) {
      const target = resolve(context.cwd, input.file_path)
      const toolUseId = context.toolUseId ?? ""
      if (target === uploadsRoot || target.startsWith(uploadsRoot + sep)) {
        const [st, realDir, real] = await Promise.all([
          lstat(target).catch(() => null),
          realpath(uploadsRoot).catch(() => null),
          realpath(target).catch(() => null),
        ])
        if (st === null || st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
          return {
            type: "tool_result" as const,
            tool_use_id: toolUseId,
            content: `Error reading file: attachment path is missing or not a regular file: ${input.file_path}`,
            is_error: true,
          }
        }
        if (realDir === null || real === null || (real !== realDir && !real.startsWith(realDir + sep))) {
          return {
            type: "tool_result" as const,
            tool_use_id: toolUseId,
            content: `Error reading file: attachment path resolves outside ${UPLOADS_DIR}: ${input.file_path}`,
            is_error: true,
          }
        }
      }
      return FileReadTool.call(input, context)
    },
  }
}
