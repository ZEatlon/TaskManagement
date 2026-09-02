/**
 * 完成日志仓储（用于热力图）
 *
 * 历史：本仓储关联的 completions 表原本用 task_id 列；
 * 统一任务实体后，task_id 改名为 sticky_note_id。
 *
 * R22 修复 (high data integrity)：补 withPrepared 封装。prepare() 返回的
 * stmtId 不 finalize 就 leak 进 worker 进程 prepared-statement 缓存；FIFO
 * 满了之后会 evict 掉正在跑的 stmtId，下一次 run/get/all 拿到 changes=undefined
 * / row=undefined。CompletionsRepository 在热力图 widget 渲染、backfill、
 * complete() 路径都会被高频调用（每天 50+ record + 24+ dailyCounts +
 * 24+ totalInRange + 1+ noteEvents.record），是 leak 最严重的几个仓储之一。
 */
import { dbClient } from '../client'

export interface CompletionRecord {
  id: string
  stickyNoteId: string | null
  date: string // YYYY-MM-DD
  count: number
  createdAt: string
}

/**
 * R28-Perf-2 修复 (high perf)：原 R22 withPrepared 每条 record/dailyCounts/
 * totalInRange 都跑一遍 prepare + finalize IPC，热力图 widget 每渲染一次
 * 触发 3+ 次 prepare。引入 per-repo stmtCache：相同 SQL 文本命中 cache 直
 * 接拿到 stmtId，不需要 finalize。worker respawn 时通过
 * dbClient.registerStmtCacheInvalidator 清空缓存。
 *
 * 老的 try/finally finalize 仍作为 fallback 保留（但被 stmtCache 路径绕
 * 开）；记录热力图 / backfill 等高频路径不再每条都付一次 IPC。
 */
const completionsStmtCache = new Map<string, number>()
let completionsInvalidatorRegistered = false

async function withPrepared<T>(
  sql: string,
  run: (stmtId: number) => Promise<T>,
): Promise<T> {
  if (!completionsInvalidatorRegistered) {
    dbClient.registerStmtCacheInvalidator(() => {
      completionsStmtCache.clear()
    })
    completionsInvalidatorRegistered = true
  }
  let stmtId = completionsStmtCache.get(sql)
  if (stmtId === undefined) {
    stmtId = (
      await dbClient.call<{ stmtId: number }>('prepare', { sql })
    ).stmtId
    completionsStmtCache.set(sql, stmtId)
  }
  return run(stmtId)
}

/**
 * R28-DI-1 修复 (medium data-integrity)：原 record() 接受任意 string 作为
 * date —— UNIQUE(sticky_note_id, date) 在 SQLite 里把每条「垃圾日期」
 * （"2024-13-40"、"not-a-date"、""）视为 distinct 行插入，热力图聚合被
 * 切成碎片。严格守住 YYYY-MM-DD 字面 + 真实存在的日期。
 * 返回归一化后的 date；非法值抛错（record() 是 IPC 入口，错误冒泡给
 * 渲染端是有意义的）。
 */
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
export function validateDayKey(date: string): string {
  if (typeof date !== 'string' || !YMD_RE.test(date)) {
    throw new Error(`invalid day key: ${JSON.stringify(date)} (expected YYYY-MM-DD)`)
  }
  const [y, m, d] = date.split('-').map((n) => Number(n))
  const dt = new Date(`${date}T00:00:00.000Z`)
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() + 1 !== m ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`invalid day key: ${JSON.stringify(date)} (not a real calendar date)`)
  }
  return date
}

export class CompletionsRepository {
  async record(stickyNoteId: string | null, date: string, count = 1): Promise<CompletionRecord> {
    const safeDate = validateDayKey(date)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    // 同 (sticky_note_id, date) 多次写入时，count 累加而不是抛错。
    await withPrepared(
      `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count + ?`,
      async (stmtId) => {
        await dbClient.call('run', { stmtId, params: [id, stickyNoteId, safeDate, count, now, count] })
      },
    )
    return { id, stickyNoteId, date: safeDate, count, createdAt: now }
  }

  /**
   * 返回 [startDate, endDate] 区间内每天的完成数
   */
  async dailyCounts(startDate: string, endDate: string): Promise<Record<string, number>> {
    const safeStart = validateDayKey(startDate)
    const safeEnd = validateDayKey(endDate)
    const rows = await withPrepared(
      `SELECT date, SUM(count) as c FROM completions
       WHERE date BETWEEN ? AND ?
       GROUP BY date ORDER BY date ASC`,
      async (stmtId) =>
        (await dbClient.call('all', { stmtId, params: [safeStart, safeEnd] })) as Array<{
          date: string
          c: number
        }>,
    )
    const out: Record<string, number> = {}
    for (const r of rows) {
      out[r.date] = r.c
    }
    return out
  }

  async totalInRange(startDate: string, endDate: string): Promise<number> {
    const safeStart = validateDayKey(startDate)
    const safeEnd = validateDayKey(endDate)
    const row = await withPrepared(
      `SELECT COALESCE(SUM(count), 0) as t FROM completions WHERE date BETWEEN ? AND ?`,
      async (stmtId) =>
        (await dbClient.call('get', { stmtId, params: [safeStart, safeEnd] })) as
          | { t: number }
          | null,
    )
    return row?.t ?? 0
  }
}

export const completionsRepo = new CompletionsRepository()

/** 笔记事件仓储（同模式） */
export class NoteEventsRepository {
  async record(noteId: string | null, date: string, type: 'create' | 'edit' | 'delete' = 'edit'): Promise<void> {
    const safeDate = validateDayKey(date)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await withPrepared(
      `INSERT INTO note_events (id, note_id, date, type, count, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
      async (stmtId) => {
        await dbClient.call('run', { stmtId, params: [id, noteId, safeDate, type, now] })
      },
    )
  }

  async dailyCounts(startDate: string, endDate: string): Promise<Record<string, number>> {
    const safeStart = validateDayKey(startDate)
    const safeEnd = validateDayKey(endDate)
    const rows = await withPrepared(
      `SELECT date, SUM(count) as c FROM note_events
       WHERE date BETWEEN ? AND ?
       GROUP BY date ORDER BY date ASC`,
      async (stmtId) =>
        (await dbClient.call('all', { stmtId, params: [safeStart, safeEnd] })) as Array<{
          date: string
          c: number
        }>,
    )
    const out: Record<string, number> = {}
    for (const r of rows) out[r.date] = r.c
    return out
  }
}

export const noteEventsRepo = new NoteEventsRepository()
