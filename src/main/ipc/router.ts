/**
 * IPC 路由注册表
 * 集中管理所有 IPC handler，按模块拆分
 *
 * 历史：原本包含 registerTaskHandlers()；统一任务实体后已删除。
 * 「任务」概念完全由 stickyNotesApi 承载（一张便签 = 一组任务）。
 */
import { shell } from 'electron'
import { CHANNELS, handle } from './channels'
import log from '../log'
import { registerTagHandlers } from './tag-handlers'
import { registerSettingHandlers } from './setting-handlers'
import { registerDbHandlers } from './db-handlers'
import { registerSecurityHandlers } from './security-handlers'
import { registerConversationHandlers } from './conversation-handlers'
import { registerAiFolderHandlers } from './ai-folder-handlers'
import { registerCompletionHandlers } from './completion-handlers'
import { registerGitHandlers } from './git-handlers'
import { registerLibraryHandlers } from './library-handlers'
import { registerNotifyHandlers } from './notify-handlers'
import { registerAiHandlers } from './ai-handlers'
import { registerPomodoroHandlers } from './pomodoro-handlers'
import { registerNoteHandlers } from './note-handlers'
import { registerAttachmentHandlers } from './attachment-handlers'
import { registerShellHandlers } from './shell-handlers'
import { registerWindowHandlers } from './window-handlers'
import { registerStickyNoteHandlers } from './sticky-note-handlers'

export function registerIpcHandlers(): void {
  log.info('[ipc] Registering handlers...')

  // 系统级 ping
  handle(CHANNELS.SYSTEM_PING, async () => {
    return { pong: Date.now(), version: '0.1.0' }
  })

  // 系统级：在系统默认浏览器中打开外部 URL
  // 安全：只允许 http/https/mailto 三种协议；其它（file://、javascript:、自定义 scheme）一律拒绝，
  // 防止被恶意笔记通过工具注入调用到任意本地程序。
  //
  // R25-Sec-1 修复 (medium SSRF)：原版只校验协议，没做 SSRF 防御。被 XSS /
  // 恶意 markdown 链接劫持的渲染端可以发 `system:open-external('http://internal-router.lan/admin')`
  // 让 OS 默认浏览器打开内网设备管理面（或 `http://127.0.0.1:9229/devtools` 让攻击者
  // 拿到 Chromium DevTools 远程调试端口）。同时 mailto:?subject=...&body=... 可被
  // 利用预填内容。修复：解析后用 shared isBlockedHostname 拒绝 loopback /
  // 私有 / link-local 主机名；mailto 协议无主机跳过此校验。
  handle(CHANNELS.SYSTEM_OPEN_EXTERNAL, async (_e, { url }: { url: string }) => {
    if (typeof url !== 'string' || !url) {
      throw new Error('system:open-external: url 必须是非空字符串')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`system:open-external: 非法 URL '${url.slice(0, 80)}'`)
    }
    const allowed = new Set(['http:', 'https:', 'mailto:'])
    if (!allowed.has(parsed.protocol)) {
      throw new Error(`system:open-external: 不允许的协议 '${parsed.protocol}'`)
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      // 借用 git-handlers.ts:116 / setting-handlers.ts 已用的 isBlockedHostname
      // 词法黑名单；DNS 解析后的运行时 rebinding 校验不适用于「用户点链接就开」
      // 场景（用户期望一次点击立刻打开，再异步校验会破坏体验），仅用词法黑名单
      // 拦最常见的 loopback / 私有 / 常见 local-suffix 域名。
      const { isBlockedHostname } = await import('../lib/networkSafety')
      if (isBlockedHostname(parsed.hostname)) {
        throw new Error(
          `system:open-external: 目标主机 '${parsed.hostname}' 是 loopback / 私有 / link-local，不允许通过本应用打开`,
        )
      }
    }
    await shell.openExternal(url)
    return { ok: true }
  })

  // 各业务模块
  registerTagHandlers()
  registerSettingHandlers()
  registerDbHandlers()
  registerSecurityHandlers()
  registerConversationHandlers()
  registerAiFolderHandlers()
  registerCompletionHandlers()
  registerLibraryHandlers()
  registerNotifyHandlers()
  registerGitHandlers()
  registerAiHandlers()
  registerPomodoroHandlers()
  registerNoteHandlers()
  registerAttachmentHandlers()
  registerShellHandlers()
  registerWindowHandlers()
  registerStickyNoteHandlers()

  // Mock 数据清理：一次性把历史版本自动写入的 mock 笔记 / sticky /
  // pomodoros 从用户 library 移除。不受 MOCK_SEED 控制（清理是破坏性
  // 操作，不是创建新数据）。
  handle(CHANNELS.MOCK_CLEANUP, async () => {
    const { cleanupMockSeededData } = await import('../db/mockData')
    return cleanupMockSeededData()
  })

  /**
   * 渲染端报告运行时错误。R7S-2 设计：让主进程 boot-trace 能拿到渲染端
   * crash 信息（ErrorBoundary / window.onerror / unhandledrejection）。
   * 旧版只 invoke 不注册 → preload 白名单静默 reject，错误报告全丢。
   * 这里只 log 落盘，不做任何 user-facing 弹窗（避免和渲染端 ErrorBoundary
   * 自身的 UI 重复）。
   */
  handle(CHANNELS.APP_ERROR, async (_e, payload: {
    message: string
    stack?: string
    componentStack?: string
    source?: string
  }) => {
    log.error(
      `[renderer-error] ${payload?.source ?? 'unknown'}: ${payload?.message ?? '(no message)'}`,
    )
    if (payload?.stack) log.error(`[renderer-error] stack: ${payload.stack}`)
    if (payload?.componentStack) log.error(`[renderer-error] componentStack: ${payload.componentStack}`)
    return { ok: true }
  })

  log.info('[ipc] all handlers registered.')
}