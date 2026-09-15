/**
 * 主进程 → 渲染进程 事件推送统一入口
 *
 * 背景：项目里多份「遍历 BrowserWindow.getAllWindows() → isDestroyed 检查 →
 * webContents.send」的本地 emit 函数（pomodoro/notifications.ts
 * `const emit = emitToRenderers`、git/autoSync.ts `broadcastState`/`emit`），
 * 实现逐字一致。每加一个本地 emit，新增过滤条件（例如「只推主窗口」「多
 * webContents 派发分流」）时容易漏改一处，行为漂移。
 *
 * 注：pomodoro/audio.ts、sticky-notes/notifier.ts、notifications/notify.ts
 * 现在**直接 import emitToRenderers**，没有本地 wrapper，不再列入清单。
 *
 * 收敛到本文件：
 *   - emitToRenderers(channel, payload)  —— 推给所有未销毁窗口的所有 webContents
 *   - emitToWebContents(wcId, channel, payload) —— 推给指定 webContents
 *     （caller 场景：navigateBridge.go 这种按发起方 webContents 单发的，
 *     不希望其它窗口收到）
 *
 * 异常策略：webContents.send 在 webContents 已 destroy 但还没完全从
 * BrowserWindow 列表移除时可能抛错。这里用 try/catch swallow + log.warn，
 * 与原各 local emit 的实现保持一致；后续若要改成抛错再统一升级。
 */
import { BrowserWindow, type WebContents } from 'electron'
import log from '../log'

/** 推给所有未销毁 BrowserWindow 的 webContents */
export function emitToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const wc = win.webContents
    try {
      wc.send(channel, payload)
    } catch (err) {
      log.warn(
        `[ipc/emit] send failed (channel=${channel}, wc=${wc.id}):`,
        (err as Error).message,
      )
    }
  }
}

/**
 * 推给指定 webContents（按 wcId 匹配）。
 * wcId 可能因为窗口销毁而找不到匹配 —— 此时静默跳过（不抛错）。
 * 用于 navigateBridge.go 之类的「按发起方 webContents 单独回送」场景。
 */
export function emitToWebContents(
  wcId: number,
  channel: string,
  payload: unknown,
): void {
  const wc = findWebContents(wcId)
  if (!wc) return
  try {
    wc.send(channel, payload)
  } catch (err) {
    log.warn(
      `[ipc/emit] send failed (channel=${channel}, wc=${wcId}):`,
      (err as Error).message,
    )
  }
}

function findWebContents(wcId: number): WebContents | null {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (win.webContents.id === wcId) return win.webContents
  }
  return null
}