/**
 * 自定义窗口栏控制 IPC（frameless window traffic lights）
 *
 * 暴露：minimize / maximize / close / is-maximized / toggle-maximize
 * 主进程主动推送：maximize / unmaximize 状态变化（用于窗口按钮图标切换）
 */
import { ipcMain, BrowserWindow } from 'electron'
import { CHANNELS, handle } from './channels'
import log from '../log'

/** 当前主窗口的引用（由 windowManager 注册） */
let mainWindowRef: BrowserWindow | null = null

export function registerWindowHandlers(): void {
  log.info('[ipc] register window handlers')

  // R10 修复：所有 handler 在调用 BrowserWindow 方法前先检查 isDestroyed()，
  // 避免窗口销毁后引用仍指向已 destroyed 的对象 → minimize()/close() 抛
  // "Object has been destroyed" 被 handle() 吞掉后 IPC 永远 hang。

  handle(CHANNELS.WINDOW_MINIMIZE, async () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return { ok: false }
    mainWindowRef.minimize()
    return { ok: true }
  })

  handle(CHANNELS.WINDOW_MAXIMIZE, async () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return { ok: false }
    if (mainWindowRef.isMaximized()) {
      mainWindowRef.unmaximize()
    } else {
      mainWindowRef.maximize()
    }
    return { ok: true }
  })

  handle(CHANNELS.WINDOW_TOGGLE_MAXIMIZE, async () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return { ok: false }
    if (mainWindowRef.isMaximized()) {
      mainWindowRef.unmaximize()
    } else {
      mainWindowRef.maximize()
    }
    return { ok: true }
  })

  handle(CHANNELS.WINDOW_CLOSE, async () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return { ok: false }
    mainWindowRef.close()
    return { ok: true }
  })

  handle(CHANNELS.WINDOW_IS_MAXIMIZED, async () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return false
    return mainWindowRef.isMaximized()
  })
}

/**
 * 由 windowManager 在创建主窗口后调用一次：
 *   1. 缓存引用
 *   2. 监听 maximize / unmaximize 事件 → 通过 WINDOW_ON_MAXIMIZE_CHANGED 推送给渲染端
 *   3. R10 修复：监听 'closed' 事件清空 mainWindowRef，避免窗口销毁后 IPC handler
 *      仍持有已 destroyed 的 BrowserWindow 引用，下一次调用 minimize/close 会抛
 *      "Object has been destroyed"，被 handle() 静默吞掉后 IPC 永远不返回错误。
 */
export function attachWindowEventForwarding(win: BrowserWindow): void {
  mainWindowRef = win
  win.on('maximize', () => {
    if (win.webContents.isDestroyed()) return
    win.webContents.send(CHANNELS.WINDOW_ON_MAXIMIZE_CHANGED, true)
  })
  win.on('unmaximize', () => {
    if (win.webContents.isDestroyed()) return
    win.webContents.send(CHANNELS.WINDOW_ON_MAXIMIZE_CHANGED, false)
  })
  win.on('closed', () => {
    if (mainWindowRef === win) {
      mainWindowRef = null
    }
  })
}

/** 仅用于测试或清理 */
export function _resetWindowHandlersForTest(): void {
  mainWindowRef = null
  // 不真正移除 ipcMain 监听，由 Electron 在 app 重启时整体清理
  void ipcMain
}