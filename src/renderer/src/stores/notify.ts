/**
 * 通知诊断 store（minimal）
 *
 * 订阅主进程推送的两条失败通道：
 *   - NOTIFY_PERSIST_FAILED：notifications 表 INSERT 失败（SQLITE_FULL /
 *     SQLITE_BUSY / schema 漂移）。原版只在 main log，渲染端 UI bug 上
 *     报里没有这条信号 → 用户漏看提醒但排查无从下手。
 *   - NOTIFY_TOAST_FAILED：OS toast 弹失败（Windows Focus Assist / 通知被
 *     组策略关闭 / macOS 通知权限被拒 / Linux libnotify 缺失）。不影响
 *     in-app banner（NOTIFY_DISPATCH 仍走），但支持 bundle 应记一笔。
 *
 * 不直接弹 toast：UI 上以一次性「最近一次通知失败」形式暴露，用户上
 * 报 bug 时可让支持人员一键导出 payload。
 */
import { create } from 'zustand'
import { IPC_CHANNELS } from '@shared/ipc/channels'

export interface NotifyPersistFailed {
  title: string
  stickyNoteId?: string
  reason: string
  at: number
}
export interface NotifyToastFailed {
  title: string
  reason: string
  at: number
}

interface NotifyDiagnosticsState {
  persistFailed: NotifyPersistFailed | null
  toastFailed: NotifyToastFailed | null
  setPersistFailed: (e: NotifyPersistFailed | null) => void
  setToastFailed: (e: NotifyToastFailed | null) => void
  /** 清空两条最近失败（用户点「忽略」时调用） */
  clear: () => void
}

export const useNotifyDiagnosticsStore = create<NotifyDiagnosticsState>((set, getState) => ({
  persistFailed: null,
  toastFailed: null,
  setPersistFailed(e) {
    if (e === null && getState().persistFailed === null) return
    set({ persistFailed: e })
  },
  setToastFailed(e) {
    if (e === null && getState().toastFailed === null) return
    set({ toastFailed: e })
  },
  clear() {
    if (getState().persistFailed === null && getState().toastFailed === null) return
    set({ persistFailed: null, toastFailed: null })
  },
}))

/**
 * 安装通知失败事件监听。返回卸载函数，main.tsx 与其它 installXxxListeners
 * 一起在 HMR dispose 时调用。注意：NOTIFY_DISPATCH 由 preload 的 window.api.on
 * 独立监听（走 in-app banner），本函数只补齐两条原本无订阅者的失败通道。
 */
export function installNotifyDiagnosticsListeners(): () => void {
  const offPersist = window.api.on(
    IPC_CHANNELS.NOTIFY_PERSIST_FAILED,
    (
      _e,
      payload: { title?: string; stickyNoteId?: string; reason?: string },
    ) => {
      if (!payload || typeof payload.reason !== 'string') return
      useNotifyDiagnosticsStore.getState().setPersistFailed({
        title: String(payload.title ?? ''),
        ...(typeof payload.stickyNoteId === 'string' ? { stickyNoteId: payload.stickyNoteId } : {}),
        reason: payload.reason,
        at: Date.now(),
      })
    },
  )
  const offToast = window.api.on(
    IPC_CHANNELS.NOTIFY_TOAST_FAILED,
    (_e, payload: { title?: string; reason?: string }) => {
      if (!payload || typeof payload.reason !== 'string') return
      useNotifyDiagnosticsStore.getState().setToastFailed({
        title: String(payload.title ?? ''),
        reason: payload.reason,
        at: Date.now(),
      })
    },
  )
  return () => {
    offPersist?.()
    offToast?.()
  }
}