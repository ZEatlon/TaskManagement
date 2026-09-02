/**
 * 附件图片处理器（模块 6）
 *
 * 职责：
 *   - 接收来自渲染端的图片二进制（Buffer）
 *   - 使用 sharp 做格式归一化（webp）、压缩（quality）、尺寸限制（max 2048 长边）
 *   - 写入磁盘：<libraryPath>/.taskpilot/attachments/<yyyy>/<mm>/<short-uuid>.<ext>
 *   - 返回相对 URL：attachments://<yyyy>/<mm>/<short-uuid>.webp
 *   - 提供按相对 URL 读取字节（用于编辑器渲染）
 *   - 提供删除
 *
 * 设计要点：
 *   - 不暴露绝对路径给渲染端，避免目录遍历
 *   - URL 用自定义协议 attachments://，由主进程解析
 *   - 文件名短 UUID + 时间分桶，便于 git 同步的稳定排序
 */
import { Buffer } from 'node:buffer'
import { join, normalize, sep } from 'node:path'
import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import log from '../log'
import { getCurrentLibrary } from '../lib/libraryManager'

/**
 * sharp is loaded lazily — its native binding (libvips DLLs) is heavy and must
 * be dlopen'd from real disk via app.asar.unpacked. A top-level static import
 * forces sharp to load at app boot, before any error handler attaches, so a
 * packaging mistake crashes the whole main process silently. Deferring the
 * load to the first uploadImage call keeps app startup independent of sharp's
 * health — if sharp fails, only image uploads break.
 */
import type Sharp from 'sharp'
type SharpFn = typeof Sharp
let sharpPromise: Promise<SharpFn> | null = null
function loadSharp(): Promise<SharpFn> {
  return (
    sharpPromise ??= import('sharp').then((m) => (m as unknown as { default: SharpFn }).default)
  )
}

/** 自定义协议前缀 */
export const ATTACHMENT_SCHEME = 'attachments://'

/** 输出格式与质量 */
const OUTPUT_FORMAT: 'webp' | 'jpeg' | 'png' = 'webp'
const OUTPUT_QUALITY = 82
/** 长边最大像素 */
const MAX_DIMENSION = 2048

/** 允许的输入 MIME 类型 */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
])

/** 附件存储根目录（相对于库目录） */
const ATTACHMENT_ROOT = join('.taskpilot', 'attachments')

/**
 * 图片保存结果
 */
export interface ImageUploadResult {
  /** 相对 URL（attachments://...） */
  url: string
  /** 绝对路径（主进程内部使用） */
  path: string
  /** 字节大小（处理后） */
  size: number
  /** 处理后图片宽高 */
  width: number
  height: number
  /** 输出格式 */
  format: string
}

/**
 * 获取附件根目录绝对路径（库目录未配置则返回 null）
 */
export async function getAttachmentsRoot(): Promise<string | null> {
  const lib = await getCurrentLibrary()
  if (!lib) return null
  return join(lib, ATTACHMENT_ROOT)
}

/**
 * 将相对 URL（attachments://yyyy/mm/abc.webp）转为磁盘绝对路径
 * - 防止 ../ 路径遍历
 */
export async function resolveAttachmentPath(relativeUrl: string): Promise<string | null> {
  if (!relativeUrl.startsWith(ATTACHMENT_SCHEME)) return null
  const root = await getAttachmentsRoot()
  if (!root) return null

  const rel = relativeUrl.slice(ATTACHMENT_SCHEME.length)
  const safeRel = normalize(rel).replace(/^([\\/])+/, '')
  // 防止路径穿越
  if (safeRel.includes('..') || safeRel.startsWith('/') || safeRel.startsWith(sep)) {
    log.warn(`[attachments] reject unsafe path: ${relativeUrl}`)
    return null
  }
  return join(root, safeRel)
}

/**
 * 检查输入 MIME 是否合法
 */
export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME.has(mime.toLowerCase())
}

/**
 * 上传图片二进制，返回相对 URL
 *
 * @param input 包含 buffer 与 mime
 */
export async function uploadImage(input: {
  buffer: Buffer
  mime: string
  filename?: string
}): Promise<ImageUploadResult> {
  const root = await getAttachmentsRoot()
  if (!root) {
    throw new Error('附件上传失败：尚未配置库目录')
  }
  if (!isAllowedMime(input.mime)) {
    throw new Error(`不支持的图片格式：${input.mime}`)
  }

  // sharp 处理：旋转（EXIF）+ 长边限制 + 格式归一化 + 压缩
  // 懒加载 sharp：避免应用启动时拉起原生绑定（libvips DLL），
  // 否则在打包模式下若 asar 解析失败，整个主进程会在 app.whenReady 之前
  // 静默崩溃，且无法被任何 errorHandler 捕获。
  const sharp = await loadSharp()
  const pipeline = sharp(input.buffer, { failOn: 'none' })
    .rotate() // 根据 EXIF 自动旋转
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })

  let outBuffer: Buffer
  let format = OUTPUT_FORMAT
  switch (OUTPUT_FORMAT) {
    case 'webp':
      outBuffer = await pipeline.webp({ quality: OUTPUT_QUALITY }).toBuffer()
      break
    case 'jpeg':
      outBuffer = await pipeline.jpeg({ quality: OUTPUT_QUALITY, mozjpeg: true }).toBuffer()
      break
    case 'png':
      outBuffer = await pipeline.png({ compressionLevel: 9 }).toBuffer()
      break
  }

  const meta = await sharp(outBuffer).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  // 时间分桶 yyyy/mm
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const subdir = join(yyyy, mm)
  await mkdir(join(root, subdir), { recursive: true })

  // 短 UUID + 扩展名（处理后固定）
  const shortId = randomUUID().slice(0, 12)
  const filename = `${shortId}.${format}`
  const absPath = join(root, subdir, filename)

  await writeFile(absPath, outBuffer)
  const stats = await stat(absPath)

  const url = `${ATTACHMENT_SCHEME}${subdir.replace(/\\/g, '/')}/${filename}`

  log.info(
    `[attachments] upload ok: ${url} (${input.buffer.length} -> ${outBuffer.length} bytes, ${width}x${height})`,
  )

  return {
    url,
    path: absPath,
    size: stats.size,
    width,
    height,
    format,
  }
}

/**
 * 读取附件字节（用于编辑器渲染 attachments:// URL）
 */
export async function readAttachment(relativeUrl: string): Promise<{
  buffer: Buffer
  mime: string
  size: number
} | null> {
  const abs = await resolveAttachmentPath(relativeUrl)
  if (!abs) return null
  if (!existsSync(abs)) {
    log.warn(`[attachments] read miss: ${abs}`)
    return null
  }
  try {
    const buffer = await readFile(abs)
    // 通过扩展名推断 mime（处理后我们只输出 webp/jpeg/png）
    const ext = abs.toLowerCase().split('.').pop() ?? ''
    const mime =
      ext === 'webp'
        ? 'image/webp'
        : ext === 'png'
          ? 'image/png'
          : ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : 'application/octet-stream'
    return { buffer, mime, size: buffer.length }
  } catch (err) {
    log.warn(`[attachments] read failed: ${abs}`, err)
    return null
  }
}

/**
 * 删除附件
 */
export async function deleteAttachment(relativeUrl: string): Promise<boolean> {
  const abs = await resolveAttachmentPath(relativeUrl)
  if (!abs) return false
  if (!existsSync(abs)) return false
  try {
    await unlink(abs)
    log.info(`[attachments] deleted: ${abs}`)
    return true
  } catch (err) {
    log.warn(`[attachments] delete failed: ${abs}`, err)
    return false
  }
}

/**
 * 注册自定义协议，让 attachments:// 走主进程渲染
 * - 在 windowManager 创建 BrowserWindow 时通过 webRequest 拦截
 */
export const ATTACHMENT_PROTOCOL = {
  scheme: 'attachments',
  privileges: { secure: true, supportFetchAPI: true, standard: true, bypassCSP: false },
}
