/**
 * 通知相关 IPC 处理器
 *
 * 注册通道：
 *   - notify:show             渲染进程主动触发通知
 *   - notify:is-supported      查询当前环境是否支持系统通知
 *   - notify:test              弹出一条测试通知
 *
 * 不注册通道：
 *   - sticky-note:due / notify:reminder / notify:toggle-window
 *     这三个是主进程 → 渲染进程的事件（用 webContents.send），无需 handler。
 *   - note：sticky-notes/notifier.runOnce()（手动触发一次到期/提醒扫描，
 *     调试用）目前未暴露为 IPC 通道 —— 需要时可再加 NOTIFY_TRIGGER_SCAN
 *     常量 + handler 收口到 startNotifier / runOnce。
 */
import { handle } from './channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import {
  notify,
  isNotificationSupported,
  showFromRenderer,
  type NotifyOptions,
  type NotificationKind,
} from '../notifications/notify'
import { getNotificationMessages } from '@shared/i18n/locales'
import { settingsRepo } from '../db/repositories/settings'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/channels'

export function registerNotifyHandlers(): void {
  /**
   * 渲染进程主动触发通知。
   * payload: { title, body?, type?, stickyNoteId?, silent? }
   */
  handle<{
    title: string
    body?: string
    type?: NotificationKind
    stickyNoteId?: string
    silent?: boolean
  }, { ok: boolean }>(IPC_CHANNELS.NOTIFY_SHOW, async (_e, payload) => {
    return showFromRenderer(payload)
  })

  /**
   * 查询 Notification API 是否可用
   */
  handle<unknown, { supported: boolean }>(IPC_CHANNELS.NOTIFY_IS_SUPPORTED, async () => {
    return { supported: isNotificationSupported() }
  })

  /**
   * 弹出一条测试通知（用于验证系统 toast 是否工作）
   */
  handle<unknown, { ok: boolean }>(IPC_CHANNELS.NOTIFY_TEST, async () => {
    // R-fix-i18n-notification-toast (high)：title 也走 locale 字典 —— 与
    // showStickyDue / showReminder / showFromRenderer 前缀保持单一来源，
    // 未来加 en-US 时这条测试 toast 同样不变成「中文测试通知」突兀。
    // body 同样走字典（testBody(time)），并用 Intl.DateTimeFormat 按 settings
    // 语言格式化时间，避免「title 英文 + body 中文」的语言分裂。
    let language: string | undefined
    try {
      const settings = (await settingsRepo.get<AppSettings>('app.settings')) ?? DEFAULT_SETTINGS
      language = settings.language
    } catch {
      // settings 读失败 → 走 getNotificationMessages 内部回退（默认 locale）
      language = undefined
    }
    const messages = getNotificationMessages(language)
    const timeFormatter = new Intl.DateTimeFormat(language ?? 'zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const formattedTime = timeFormatter.format(new Date())
    const ok = await notify({
      title: messages.testTitle,
      body: messages.testBody(formattedTime),
      type: 'reminder',
    } satisfies NotifyOptions)
    return { ok }
  })
}