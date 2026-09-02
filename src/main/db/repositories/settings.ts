/**
 * 设置仓储（key-value）
 */
import { dbClient } from '../client'

/** R28-Perf-4 修复 (medium perf)：withStatement 仍每次 prepare + finalize，
 * 即便 SQL 是常量。settings get/set/getAll/delete 在 settings 页 mount /
 * scheduler 通知等路径高频调用，每分钟都付一次 IPC。引入 per-repo
 * stmtCache 命中后直接拿 stmtId，不再 finalize。
 */
const settingsStmtCache = new Map<string, number>()
let settingsInvalidatorRegistered = false

async function withStatement<T>(
  sql: string,
  run: (stmtId: number) => Promise<T>,
): Promise<T> {
  if (!settingsInvalidatorRegistered) {
    dbClient.registerStmtCacheInvalidator(() => {
      settingsStmtCache.clear()
    })
    settingsInvalidatorRegistered = true
  }
  let stmtId = settingsStmtCache.get(sql)
  if (stmtId === undefined) {
    stmtId = (
      await dbClient.call<{ stmtId: number }>('prepare', { sql })
    ).stmtId
    settingsStmtCache.set(sql, stmtId)
  }
  return run(stmtId)
}

export class SettingsRepository {
  async get<T = unknown>(key: string): Promise<T | null> {
    return withStatement('SELECT value FROM settings WHERE key = ?', async (stmtId) => {
      const row = (await dbClient.call('get', {
        stmtId,
        params: [key],
      })) as { value: string } | null
      if (!row) return null
      try {
        return JSON.parse(row.value) as T
      } catch (_) {
        return row.value as unknown as T
      }
    })
  }

  async set(key: string, value: unknown): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    const now = new Date().toISOString()
    await withStatement(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      async (stmtId) => {
        await dbClient.call('run', { stmtId, params: [key, serialized, now] })
      },
    )
  }

  async getAll(): Promise<Record<string, unknown>> {
    return withStatement('SELECT key, value FROM settings', async (stmtId) => {
      const rows = (await dbClient.call('all', { stmtId })) as Array<{
        key: string
        value: string
      }>
      const out: Record<string, unknown> = {}
      for (const r of rows) {
        try {
          out[r.key] = JSON.parse(r.value)
        } catch (_) {
          out[r.key] = r.value
        }
      }
      return out
    })
  }

  async delete(key: string): Promise<void> {
    await withStatement('DELETE FROM settings WHERE key = ?', async (stmtId) => {
      await dbClient.call('run', { stmtId, params: [key] })
    })
  }
}

export const settingsRepo = new SettingsRepository()