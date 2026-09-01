/**
 * Run 侧附件处理（issue #43）：不信任上游附件描述，逐项重新校验
 * （路径安全、真实文件、真实 size），聚合复核限额；图片管线与
 * AgentInput 构造见 Task 6 追加。
 */
import { lstat } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { safeResolve } from "./files.js"
import { MAX_FILE_BYTES, MAX_FILE_COUNT, MAX_TOTAL_BYTES, UPLOADS_DIR } from "./uploads.js"

export type AttachmentErrorCode = "invalid_attachment" | "attachment_missing" | "upload_limit_exceeded"

export class AttachmentError extends Error {
  constructor(
    public code: AttachmentErrorCode,
    message: string,
    public path?: string,
  ) {
    super(message)
    this.name = "AttachmentError"
  }
}

export interface AttachmentDescriptor {
  id: string
  name: string
  mime: string
  size: number
  path: string
}

export interface ValidatedAttachment {
  descriptor: AttachmentDescriptor
  absPath: string
  realSize: number
}

const UPLOADS_PREFIX = `${UPLOADS_DIR}/`

/** 解析并校验 attachments 数组的 shape；非法抛 AttachmentError(invalid_attachment)。 */
export function parseAttachmentDescriptors(input: unknown): AttachmentDescriptor[] {
  if (!Array.isArray(input)) {
    throw new AttachmentError("invalid_attachment", "attachments must be an array")
  }
  return input.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new AttachmentError("invalid_attachment", "each attachment must be an object")
    }
    const att = raw as Record<string, unknown>
    for (const field of ["id", "name", "mime", "path"] as const) {
      if (typeof att[field] !== "string") {
        throw new AttachmentError(
          "invalid_attachment",
          `attachment field "${field}" must be a string`,
        )
      }
    }
    if (typeof att.size !== "number" || !Number.isInteger(att.size) || att.size < 0) {
      throw new AttachmentError(
        "invalid_attachment",
        'attachment field "size" must be a non-negative integer',
      )
    }
    return {
      id: att.id,
      name: att.name,
      mime: att.mime,
      size: att.size,
      path: att.path,
    } as AttachmentDescriptor
  })
}

/**
 * 先复核数量限额（纯描述级），再逐项校验（路径前缀/traversal/null byte/
 * lstat 真实性/size 一致性），最后聚合复核单文件/总量限额。
 * 任何失败抛 AttachmentError。
 */
export async function validateAttachments(
  cwd: string,
  descriptors: AttachmentDescriptor[],
): Promise<ValidatedAttachment[]> {
  // 数量限额先于逐项 lstat 复核：纯描述级检查，无需触碰文件系统。
  if (descriptors.length > MAX_FILE_COUNT) {
    throw new AttachmentError(
      "upload_limit_exceeded",
      `Too many attachments: limit is ${MAX_FILE_COUNT}`,
    )
  }
  const validated: ValidatedAttachment[] = []
  for (const att of descriptors) {
    if (att.path.includes("\0") || isAbsolute(att.path) || !att.path.startsWith(UPLOADS_PREFIX)) {
      throw new AttachmentError(
        "invalid_attachment",
        `Invalid attachment path: ${att.path}`,
        att.path,
      )
    }
    const abs = safeResolve(cwd, att.path)
    if (abs === null) {
      throw new AttachmentError(
        "invalid_attachment",
        `Invalid attachment path: ${att.path}`,
        att.path,
      )
    }
    const relFromCwd = relative(cwd, abs)
    if (!relFromCwd.startsWith(UPLOADS_PREFIX) || relFromCwd === UPLOADS_DIR) {
      throw new AttachmentError(
        "invalid_attachment",
        `Attachment path must stay inside ${UPLOADS_PREFIX}: ${att.path}`,
        att.path,
      )
    }
    const st = await lstat(abs).catch(() => null)
    if (st === null) {
      throw new AttachmentError("attachment_missing", `Attachment not found: ${att.path}`, att.path)
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new AttachmentError(
        "invalid_attachment",
        `Attachment is not a regular file: ${att.path}`,
        att.path,
      )
    }
    if (st.size !== att.size) {
      throw new AttachmentError(
        "invalid_attachment",
        `Attachment size mismatch for ${att.path}: declared ${att.size}, actual ${st.size}`,
        att.path,
      )
    }
    validated.push({ descriptor: att, absPath: abs, realSize: st.size })
  }

  for (const v of validated) {
    if (v.realSize > MAX_FILE_BYTES) {
      throw new AttachmentError(
        "upload_limit_exceeded",
        `Attachment exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB single-file limit: ${v.descriptor.path}`,
        v.descriptor.path,
      )
    }
  }
  const total = validated.reduce((sum, v) => sum + v.realSize, 0)
  if (total > MAX_TOTAL_BYTES) {
    throw new AttachmentError(
      "upload_limit_exceeded",
      `Total attachment size exceeds the ${MAX_TOTAL_BYTES / (1024 * 1024)}MB limit`,
    )
  }
  return validated
}
