/**
 * 通知相关 IPC 处理器
 *
 * 注册通道：
 *   - notify:show             渲染进程主动触发通知
 *   - notify:is-supported      查询当前环境是否支持系统通知
 *   - notify:trigger-scan      手动触发一次到期/提醒扫描（调试用）
 *   - notify:test              弹出一条测试通知
 *
 * 不注册通道：
 *   - sticky-note:due / notify:reminder / notify:toggle-window
 *     这三个是主进程 → 渲染进程的事件（用 webContents.send），无需 handler。
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
    const ok = await notify({
      title: 'TaskPilot 测试通知',
      body: `当前时间 ${new Date().toLocaleTimeString()}`,
      type: 'reminder',
    } satisfies NotifyOptions)
    return { ok }
  })
}