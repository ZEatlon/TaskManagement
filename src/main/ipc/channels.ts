/**
 * IPC 通道常量定义（主进程侧）
 * 与 src/shared/ipc/channels.ts 保持同步
 */
import { IPC_CHANNELS } from '@shared/ipc/channels'

export const CHANNELS = IPC_CHANNELS

/**
 * 注册 IPC handler 的辅助函数
 * 提供统一的错误捕获与日志
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron'
import log from '../log'

export function handle<TReq = unknown, TRes = unknown>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, req: TReq) => Promise<TRes> | TRes,
): void {
  ipcMain.handle(channel, async (event, req: TReq) => {
    try {
      return await handler(event, req)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`[ipc:${channel}] ${msg}`, err)
      throw err
    }
  })
}

export function removeHandler(channel: string): void {
  ipcMain.removeHandler(channel)
}

export function removeAllHandlers(): void {
  ipcMain.removeAllListeners()
}