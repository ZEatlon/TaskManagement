/**
 * 注册 attachments:// 自定义协议
 * 让渲染端可以直接使用 <img src="attachments://..."> 加载附件
 *
 * 调用时机：app.whenReady 之后、window loadURL 之前
 */
import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { ATTACHMENT_SCHEME } from './imageHandler'
import { resolveAttachmentPath } from './imageHandler'
import log from '../log'

/**
 * 注册 attachments:// 协议
 * - 已被协议占用则跳过
 * - 注册失败不抛错（降级为 file:// 直读）
 */
export function registerAttachmentProtocol(): void {
  if (protocol.isProtocolHandled(ATTACHMENT_SCHEME)) {
    return
  }
  try {
    protocol.handle(ATTACHMENT_SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        // 还原 attachments://yyyy/mm/xxx.webp
        const relativeUrl = `${ATTACHMENT_SCHEME}${url.pathname.replace(/^\/+/, '')}${
          url.search ?? ''
        }`
        const abs = await resolveAttachmentPath(relativeUrl)
        if (!abs) {
          return new Response('Not Found', { status: 404 })
        }
        // 直接用 file:// 走 net 模块
        const fileUrl = pathToFileURL(abs).toString()
        return await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true })
      } catch (err) {
        log.warn('[attachments] protocol handler failed', err)
        return new Response('Internal Error', { status: 500 })
      }
    })
    log.info('[attachments] custom protocol registered')
  } catch (err) {
    log.warn('[attachments] register protocol failed', err)
  }
}

/**
 * 授予 web 权限（让 attachments:// 在 img 中加载）
 */
export function grantAttachmentPrivileges(): void {
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'attachments',
        privileges: { secure: true, supportFetchAPI: true, standard: true, bypassCSP: false },
      },
    ])
  } catch {
    // 已被注册时再调用会抛错，忽略
  }
}
