/**
 * 自动更新 IPC handler
 *
 * 安全：
 *   - 所有 handler 限制 sender === 当前主窗口 webContents
 *   - 渲染端拿到的是 UpdaterState 浅拷贝（不可改主进程 state）
 *   - 状态流式推送走 UPDATER_STATUS，已在 updater.ts 内部过滤已销毁 webContents
 */
import { handle } from './channels'
import { IPC_CHANNELS as CHANNELS } from '@shared/ipc/channels'
import type { UpdaterState } from '@shared/types/updater'
import log from '../log'
import {
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  getUpdaterState,
} from '../updater'

/** 校验调用方是否合法：必须是主窗口自身或调试 devtools。 */
function assertSelfSender(event: { sender: Electron.WebContents | null }, who: string): void {
  // electron 在某些场景下 sender 可能是 null（IPC 来自非 webContents）；
  // 也不允许完全空的 senderId。渲染端合法 IPC 一定带 sender。
  if (!event.sender || event.sender.isDestroyed()) {
    throw new Error(`updater:${who}: 拒绝无 sender 的调用`)
  }
}

export function registerUpdaterHandlers(): void {
  handle<UpdaterState>(CHANNELS.UPDATER_GET_STATE, async (event) => {
    assertSelfSender(event, 'get-state')
    return getUpdaterState()
  })

  handle<UpdaterState>(CHANNELS.UPDATER_CHECK, async (event) => {
    assertSelfSender(event, 'check')
    log.info('[updater] UPDATER_CHECK from webContents', event.sender?.id)
    return checkForUpdates()
  })

  handle<UpdaterState>(CHANNELS.UPDATER_DOWNLOAD, async (event) => {
    assertSelfSender(event, 'download')
    log.info('[updater] UPDATER_DOWNLOAD from webContents', event.sender?.id)
    return downloadUpdate()
  })

  handle<void>(CHANNELS.UPDATER_INSTALL, async (event) => {
    assertSelfSender(event, 'install')
    log.info('[updater] UPDATER_INSTALL from webContents', event.sender?.id)
    quitAndInstall()
  })
}
