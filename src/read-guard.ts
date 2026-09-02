/**
 * Read 工具防护（review PR #48 R3/R4）：SDK FileReadTool 对 `.zerone-uploads`
 * 子树的读取在执行处强制 containment，并以 **fd 钉住委托**消除"校验后、
 * SDK 真正打开前"的换链窗口——校验通过后立即 open 并比对 inode，Linux
 * 下把 `/proc/self/fd/<fd>`（内核 fd 表引用，换链不可改变其解析）作为
 * file_path 委托给原工具，SDK 读到的即钉住的 inode。扩展名信息会丢失
 * （图片/PDF 重读按文本渲染；内容本身已内联进 image block，影响可忽略）。
 * uploads 之外的路径原样透传（不改变既有 Agent 行为）。
 *
 * 注入方式：registry 将本工具作为 customTools 传入——SDK 工具池合并时
 * custom 晚于内置工具且 later-wins 去重（resolve-agent 契约），同名
 * "Read" 即完成接管。
 */
import { lstat, open, realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { FileReadTool } from "@zerone-agent/agent-sdk"
import { UPLOADS_DIR, fdRelativeSupportedOrWarn } from "./uploads.js"

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
      const err = (msg: string) => ({
        type: "tool_result" as const,
        tool_use_id: toolUseId,
        content: msg,
        is_error: true,
      })
      if (target === uploadsRoot || target.startsWith(uploadsRoot + sep)) {
        const [st, realDir, real] = await Promise.all([
          lstat(target).catch(() => null),
          realpath(uploadsRoot).catch(() => null),
          realpath(target).catch(() => null),
        ])
        if (st === null || st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
          return err(`Error reading file: attachment path is missing or not a regular file: ${input.file_path}`)
        }
        if (realDir === null || real === null || (real !== realDir && !real.startsWith(realDir + sep))) {
          return err(`Error reading file: attachment path resolves outside ${UPLOADS_DIR}: ${input.file_path}`)
        }
        // fd 钉住委托（review R4/R6 P1）：文件与目录统一——open 后比对 inode
        // （校验→open 间隙的换链在此拒绝），此后 fd 即钉住目标；经
        // /proc/self/fd/<fd> 委托，FileReadTool 的 stat/readdir 都解析到内核
        // fd 表引用，委托期间任何换链都无法改变列出的目录或读到的内容
        const handle = await open(target, "r").catch(() => null)
        if (handle === null) {
          return err(`Error reading file: attachment path is missing or not a regular file: ${input.file_path}`)
        }
        try {
          const fst = await handle.stat()
          if (fst.dev !== st.dev || fst.ino !== st.ino || (!fst.isFile() && !fst.isDirectory())) {
            return err(`Error reading file: attachment changed during validation: ${input.file_path}`)
          }
          if (!fdRelativeSupportedOrWarn()) {
            // fail-closed（review R5/R6 P1）：无内核 fd 引用的平台不接受词法
            // 委托（文件与目录皆然），该校验→打开窗口在该平台上无法消除
            return err(`Error reading file: attachments require a /proc/self/fd-capable platform (Linux) on this runtime: ${input.file_path}`)
          }
          return await FileReadTool.call(
            { ...input, file_path: `/proc/self/fd/${handle.fd}` },
            context,
          )
        } finally {
          await handle.close().catch(() => {})
        }
      }
      return FileReadTool.call(input, context)
    },
  }
}
