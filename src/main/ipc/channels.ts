/**
 * 注册 IPC handler 的辅助函数
 * 提供统一的错误捕获与日志
 *
 * 注意：本文件不再 export `CHANNELS` 别名 —— 全仓库统一走
 * `import { IPC_CHANNELS } from '@shared/ipc/channels'`，避免两个名字
 * 指向同一份数据引发命名漂移。
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