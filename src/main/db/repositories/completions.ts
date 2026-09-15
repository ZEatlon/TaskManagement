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
import { withCached } from '../cachedStmt'
import { DAY_KEY_RE, isValidDayKey } from '@shared/lib/dayKey'

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
 * 触发 3+ 次 prepare。复用 module-scope `withCached` 共享 cache：相同 SQL
 * 文本命中 cache 直接拿到 stmtId，不需要 finalize。worker respawn 时由
 * cachedStmt 的 module-scope invalidator 自动清空缓存。
 *
 * 老的 try/finally finalize 仍作为 fallback 保留（但被 stmtCache 路径绕
 * 开）；记录热力图 / backfill 等高频路径不再每条都付一次 IPC。
 *
 * 命名沿用本仓库历史的 `withPrepared`，但底层不再 finalize —— 语义与
 * db/withPrepared.ts 那个「用一次就丢」helper 不同，需要一次性语义请
 * 直接 import db/withPrepared。
 */
async function withPrepared<T>(
  sql: string,
  run: (stmtId: number) => Promise<T>,
): Promise<T> {
  return withCached(sql, run)
}

/**
 * R28-DI-1 修复 (medium data-integrity)：原 record() 接受任意 string 作为
 * date —— UNIQUE(sticky_note_id, date) 在 SQLite 里把每条「垃圾日期」
 * （"2024-13-40"、"not-a-date"、""）视为 distinct 行插入，热力图聚合被
 * 切成碎片。严格守住 YYYY-MM-DD 字面 + 真实存在的日期。
 * 返回归一化后的 date；非法值抛错（record() 是 IPC 入口，错误冒泡给
 * 渲染端是有意义的）。
 *
 * R-fix-daykey-dedup (MEDIUM)：字面 + 真实日期判定统一走
 * @shared/lib/dayKey.isValidDayKey，与 validators.parseSafeDayKey /
 * navigateBridge.parseRoute 共享同一权威源。
 */

/**
 * 单条 record() 调用允许写入的最大 count。热力图每天 1000 次完成已远超
 * 真实使用场景，超过视为异常输入（防止 XSS / 恶意依赖把单日 SUM(count)
 * 撑爆、扭曲 streak）。handler 层和 repo 层都使用同一常量，避免单点失守。
 * 防御性夹紧：repo.record 也会 clamp，handler 层先 clamp 是为了给渲染端
 * 一个清晰的错误信息。
 */
export const MAX_COMPLETION_COUNT = 1000
export function validateDayKey(date: string): string {
  if (!isValidDayKey(date)) {
    // 区分「字面格式不合法」与「字面合法但不是真实日期」两种失败，给 IPC
    // 调用方更精确的诊断信息（之前 inline 时也是同样的双分支文案）。
    const looksLikeYmd = typeof date === 'string' && DAY_KEY_RE.test(date)
    throw new Error(
      `invalid day key: ${JSON.stringify(date)} (${looksLikeYmd ? 'not a real calendar date' : 'expected YYYY-MM-DD'})`,
    )
  }
  return date
}

export class CompletionsRepository {
  async record(stickyNoteId: string | null, date: string, count = 1): Promise<CompletionRecord> {
    const safeDate = validateDayKey(date)
    // 防御性夹紧：handler 已 clamp 到 [1, MAX_COMPLETION_COUNT]，但
    // repo 仍兜底一次，避免未来调用方绕过 handler（如 backfill / 测试）
    // 重新引入无界 count 写入。
    const safeCount = Math.min(MAX_COMPLETION_COUNT, Math.max(1, Math.floor(count)))
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    // 同 (sticky_note_id, date) 多次写入时，count 累加而不是抛错。
    await withPrepared(
      `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count + ?`,
      async (stmtId) => {
        await dbClient.call('run', { stmtId, params: [id, stickyNoteId, safeDate, safeCount, now, safeCount] })
      },
    )
    return { id, stickyNoteId, date: safeDate, count: safeCount, createdAt: now }
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
