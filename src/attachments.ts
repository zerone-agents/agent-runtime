/**
 * Run 侧附件处理（issue #43）：不信任上游附件描述，逐项重新校验
 * （路径安全、真实文件、真实 size），聚合复核限额；图片管线与
 * AgentInput 构造见 Task 6 追加。
 */
import { lstat, open, rm, realpath, type FileHandle } from "node:fs/promises"
import { isAbsolute, join, dirname, relative, sep } from "node:path"
import { randomBytes } from "node:crypto"
import sharp from "sharp"
import type { AgentInput, ContentBlockParam } from "@zerone-agent/agent-sdk"
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
  /**
   * 校验时通过 fd 钉住（open + fstat 比对 dev/ino 后读出的字节）。
   * 消费方必须使用这里的 bytes，不得再按路径读盘（防 TOCTOU 换链）。
   */
  bytes: Buffer
}

const UPLOADS_PREFIX = `${UPLOADS_DIR}/`

/** C0 控制字符 + DEL：路径中出现即拒绝（防换行注入模型 prompt） */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

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
  let totalSoFar = 0 // 限额前置于读取（review PR #48 R2 P1b）：累计字节在读取前检查
  // realpath containment（review PR #48 P1a）：词法检查挡不住中间组件 symlink，
  // 上传目录自身必须是 cwd 内的真实目录（非 symlink），每个附件解析后的真实
  // 路径必须落在其内。目录不存在时跳过（逐文件 lstat 会报 attachment_missing）。
  const realCwd = await realpath(cwd)
  const realUploadsDir = await realpath(join(cwd, UPLOADS_DIR)).catch(() => null)
  if (realUploadsDir !== null && realUploadsDir !== join(realCwd, UPLOADS_DIR)) {
    throw new AttachmentError(
      "invalid_attachment",
      `${UPLOADS_DIR} must be a real directory inside the working directory`,
    )
  }
  for (const att of descriptors) {
    if (CONTROL_CHARS.test(att.path) || isAbsolute(att.path) || !att.path.startsWith(UPLOADS_PREFIX)) {
      throw new AttachmentError(
        "invalid_attachment",
        `Invalid attachment path: ${att.path}`,
        att.path,
      )
    }
    // 扁平路径（review PR #48 R2 P2）：上传 API 只产扁平文件，任何子目录
    // 或非规范段（./、//）都拒绝，不留 realpath 兜底之外的歧义路径。
    const rest = att.path.slice(UPLOADS_PREFIX.length)
    if (rest === "" || rest === "." || rest === ".." || rest.includes("/")) {
      throw new AttachmentError(
        "invalid_attachment",
        `Attachment path must be a flat file directly under ${UPLOADS_PREFIX}: ${att.path}`,
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
    // 限额前置于读取：单文件与累计检查都发生在 open/readFile 之前，
    // 拒绝路径不再为超限附件付出读取内存（review PR #48 R2 P1b）。
    if (st.size > MAX_FILE_BYTES) {
      throw new AttachmentError(
        "upload_limit_exceeded",
        `Attachment exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB single-file limit: ${att.path}`,
        att.path,
      )
    }
    if (totalSoFar + st.size > MAX_TOTAL_BYTES) {
      throw new AttachmentError(
        "upload_limit_exceeded",
        `Total attachment size exceeds the ${MAX_TOTAL_BYTES / (1024 * 1024)}MB limit`,
      )
    }
    totalSoFar += st.size
    if (realUploadsDir !== null) {
      const realAbs = await realpath(abs).catch(() => null)
      if (realAbs === null) {
        throw new AttachmentError("attachment_missing", `Attachment not found: ${att.path}`, att.path)
      }
      if (!realAbs.startsWith(realUploadsDir + sep)) {
        throw new AttachmentError(
          "invalid_attachment",
          `Attachment path must stay inside ${UPLOADS_PREFIX}: ${att.path}`,
          att.path,
        )
      }
    }
    // TOCTOU 钉住（review PR #48 P1b）：open 后 fstat 比对 dev/ino，
    // 确认拿到的 fd 与刚 lstat 的是同一 inode；字节从该 fd 读出并随
    // ValidatedAttachment 传递，消费方不再按路径读盘。
    const handle: FileHandle | null = await open(abs, "r").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    })
    if (handle === null) {
      throw new AttachmentError("attachment_missing", `Attachment not found: ${att.path}`, att.path)
    }
    try {
      const fst = await handle.stat()
      if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
        throw new AttachmentError(
          "invalid_attachment",
          `Attachment changed during validation: ${att.path}`,
          att.path,
        )
      }
      const bytes = await handle.readFile()
      validated.push({ descriptor: att, absPath: abs, realSize: st.size, bytes })
    } finally {
      await handle.close().catch(() => {})
    }
  }

  return validated
}

export const MAX_IMAGE_EDGE = 1536
export const JPEG_QUALITY = 85
export const PIXEL_CAP = 100_000_000

const IMAGE_FORMATS = new Set(["jpeg", "png", "gif", "webp"])
const MEDIA_TYPES: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
}

interface DecodedImage {
  data: string
  mediaType: string
}

/**
 * 实测解码：只信 sharp 解码结果，不信任 MIME/扩展名。
 * 返回 null = 非图片（含 SVG）或解码失败（截断/损坏）→ 按普通文件处理。
 */
async function tryDecodeImage(bytes: Buffer): Promise<DecodedImage | null> {
  let meta: sharp.Metadata
  try {
    meta = await sharp(bytes, { limitInputPixels: PIXEL_CAP }).metadata()
  } catch {
    return null
  }
  const format = meta.format ?? ""
  if (!IMAGE_FORMATS.has(format) || meta.width === undefined || meta.height === undefined) {
    return null
  }
  try {
    const longEdge = Math.max(meta.width, meta.height)
    if (longEdge > MAX_IMAGE_EDGE) {
      const out = await sharp(bytes, { limitInputPixels: PIXEL_CAP })
        .rotate() // 尊重 EXIF 方向（spec 外的有意增强，不影响限额语义）
        .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#FFFFFF" })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer()
      return { data: out.toString("base64"), mediaType: "image/jpeg" }
    }
    // 全像素解码验证：截断/损坏文件在此抛错（header 解析抓不住）
    await sharp(bytes, { limitInputPixels: PIXEL_CAP }).resize(1, 1).raw().toBuffer()
    return { data: bytes.toString("base64"), mediaType: MEDIA_TYPES[format] }
  } catch {
    return null
  }
}

/** text block 文案：只拼校验过的 path，不拼请求 name 字段。 */
export function composeAttachmentText(
  message: string,
  imagePaths: string[],
  filePaths: string[],
): string {
  const lines = [message, "", "[附件]"]
  for (const p of imagePaths) {
    lines.push(`- 图片 ${p} 已直接提供（如需再次查看可用 Read 工具读取该路径）`)
  }
  for (const p of filePaths) {
    lines.push(`- 文件 ${p}：请使用 Read 工具读取后再回答`)
  }
  return lines.join("\n")
}

/**
 * 物化快照（review PR #48 R2 P1c）：把校验时钉住的字节写入 wx 独占创建的
 * 新文件（随机名，不可预放置），Agent 的 Read 工具拿到的是这份快照路径——
 * 原路径在校验后被换成外部 symlink 也无法影响本次 run 读到的内容。
 * 快照与上传物同目录同生命周期（.zerone-uploads，随容器）。
 */
async function materializeSnapshot(att: ValidatedAttachment): Promise<string> {
  const dir = dirname(att.absPath)
  const base = att.descriptor.path.slice(UPLOADS_PREFIX.length)
  const unique = `snap-${randomBytes(4).toString("hex")}-${base}`
  const dest = join(dir, unique)
  const realDir = await realpath(dir)
  const handle = await open(dest, "wx")
  try {
    const realFile = await realpath(dest)
    if (realFile !== join(realDir, unique)) {
      throw new Error("snapshot escaped uploads directory — possible symlink swap")
    }
    await handle.write(att.bytes)
    return `${UPLOADS_DIR}/${unique}`
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {})
    throw err
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 构造模型输入：无附件原样 string；有附件 → [text, ...images]。 */
export async function buildAgentInput(
  message: string,
  attachments: ValidatedAttachment[],
): Promise<AgentInput> {
  if (attachments.length === 0) return message
  const imageBlocks: ContentBlockParam[] = []
  const imagePaths: string[] = []
  const filePaths: string[] = []
  for (const att of attachments) {
    // 使用校验时钉住的字节（fd + inode 比对），绝不按路径重读（防 TOCTOU）
    const decoded = await tryDecodeImage(att.bytes)
    // Agent 侧 Read 走快照路径（wx 独占创建 + 随机名）：
    // 原路径在校验后换链也不影响本次 run 实际读到的内容
    const snapshotPath = await materializeSnapshot(att)
    if (decoded) {
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: decoded.mediaType, data: decoded.data },
      })
      imagePaths.push(snapshotPath)
    } else {
      filePaths.push(snapshotPath)
    }
  }
  return [
    { type: "text", text: composeAttachmentText(message, imagePaths, filePaths) },
    ...imageBlocks,
  ]
}
