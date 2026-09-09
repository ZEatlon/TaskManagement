/**
 * 设置仓储（key-value）
 */
import log from '../../log'
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
        // H5 修复 (medium data-integrity)：原版 JSON.parse 失败时
        // `return row.value as unknown as T` —— 直接把字符串塞回去当作
        // 「调用方期望的 T」返回。调用方若期望 object / array（T 是结构
        // 类型），实际拿到 string 会让 .field 访问变成 undefined、序列化
        // JSON.stringify 时丢字段。修复：parse 失败也明确告知调用方：
        // 返回 null（与 row 缺失语义一致）。调用方已有 null fallback 路径。
        // 若 row.value 是合法 JSON 但不是 T（schema drift / 旧版数据），
        // 仍然按 as T 透传 —— 这是 type-only 的「信任 caller」契约。
        return JSON.parse(row.value) as T
      } catch (err) {
        log.warn(
          `[settings] key '${key}' has malformed JSON; treating as missing:`,
          (err as Error).message,
        )
        return null
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