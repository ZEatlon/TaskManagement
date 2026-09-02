/**
 * 附件相关 IPC 处理器（模块 6）
 *
 * 通道：
 *   - attachment:upload    上传图片（接收 base64 数据 + mime），返回 attachments:// 相对 URL
 *   - attachment:delete    删除附件（按相对 URL）
 *   - attachment:exists    检查附件是否存在
 */
import { Buffer } from 'node:buffer'
import { handle } from './channels'
import {
  uploadImage,
  deleteAttachment,
  resolveAttachmentPath,
} from '../attachments/imageHandler'
import { existsSync } from 'node:fs'
import log from '../log'

/**
 * 上传请求 payload
 */
export interface AttachmentUploadRequest {
  /** base64 编码的图片字节 */
  base64: string
  /** MIME 类型 */
  mime: string
  /** 可选文件名（仅用于日志） */
  filename?: string
}

/**
 * 上传响应
 */
export interface AttachmentUploadResponse {
  url: string
  size: number
  width: number
  height: number
  format: string
}

export function registerAttachmentHandlers(): void {
  handle<AttachmentUploadRequest, AttachmentUploadResponse>(
    'attachment:upload',
    async (_e, req) => {
      if (!req || typeof req.base64 !== 'string' || typeof req.mime !== 'string') {
        throw new Error('attachment:upload 无效请求')
      }
      const buffer = Buffer.from(req.base64, 'base64')
      if (buffer.length === 0) {
        throw new Error('attachment:upload 数据为空')
      }
      // 上限 20 MB（防止恶意大文件）
      if (buffer.length > 20 * 1024 * 1024) {
        throw new Error('attachment:upload 文件超过 20MB 限制')
      }
      const result = await uploadImage({
        buffer,
        mime: req.mime,
        filename: req.filename,
      })
      return {
        url: result.url,
        size: result.size,
        width: result.width,
        height: result.height,
        format: result.format,
      }
    },
  )

  handle<string, { ok: boolean }>('attachment:delete', async (_e, url) => {
    if (!url) return { ok: false }
    const ok = await deleteAttachment(url)
    return { ok }
  })

  handle<string, { exists: boolean }>('attachment:exists', async (_e, url) => {
    const abs = await resolveAttachmentPath(url)
    return { exists: !!abs && existsSync(abs) }
  })

  log.info('[ipc] attachment handlers registered')
}
