/**
 * 数据库管理 IPC（状态、迁移、备份）
 */
import { handle } from './channels'
import { getStatus } from '../db/connection'
import { dbClient } from '../db/client'

export function registerDbHandlers(): void {
  handle('db:status', async () => getStatus())

  handle('db:vacuum', async () => {
    await dbClient.call('vacuum', {})
    return { ok: true }
  })
}