/**
 * 便签到期 / 调度检查调度器
 *
 * 行为：
 *   - 每分钟扫描 sticky_notes 表
 *   - 找出 status='todo'/'in_progress' 且 due_at 或 scheduled_at 在过去 N 分钟内
 *   - 触发 showStickyDue；幂等通过 UNIQUE(task_id, type, date(fired_at)) 约束保证
 *     （notifications 表沿用旧 task_id 列名；语义上是"便签 id"）
 *   - 重复便签在扫描时根据 RRULE 推进下次到期时间
 *
 * 历史：原 taskScheduler 扫描 tasks 表；统一后改为扫描 sticky_notes。
 */
import { Cron } from 'croner'
import { dbClient } from '../db/client'
import log from '../log'
import { showStickyDue, resetPendingDue } from '../notifications/notify'
import { nextOccurrence, toRRuleString } from './recurrence'

interface StickyRow {
  id: string
  title: string
  status: string
  priority: string
  due_at: string | null
  scheduled_at: string | null
  recurrence: string | null
  archived: number
  completed_at: string | null
}

/** 扫描窗口：due_at / scheduled_at 落在 [now - windowMs, now] 之间即视为到期
 *
 * R11 修复 (high #7)：原值 2 分钟导致任何"过去 2 分钟之前"该响的便签都被永久
 * 错过 —— 用户关闭笔记本电脑到 17:00 重新打开，9:00 的提醒永远不会被派发，
 * 因为现在 `due_at >= windowStart` (windowStart = now - 2min) 永远为假。
 * 把窗口扩大到 24 小时让"今天到现在为止漏掉的提醒"仍会被补发，再配合
 * logNotification 的 UNIQUE 约束保证同一天不会重复发。重复便签的
 * advanceRecurrence 仅在 showStickyDue 真派发了才推进，所以放宽窗口不会导致
 * 重复规则一次性"补跑"多次。
 */
const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 小时宽容窗口

/** 每分钟一次 */
const SCAN_CRON = '* * * * *'

let cronJob: Cron | null = null

/**
 * 推进重复便签的 due_at 到下一次触发。
 * 若 RRULE 计算失败，保持原值。
 */
async function advanceRecurrence(note: StickyRow): Promise<void> {
  if (!note.recurrence) return
  let rruleString: string
  try {
    const parsed = JSON.parse(note.recurrence)
    if (typeof parsed === 'string') {
      rruleString = parsed
    } else if (parsed && typeof parsed === 'object' && 'rruleString' in parsed) {
      rruleString = String(parsed.rruleString)
    } else {
      rruleString = toRRuleString(parsed)
    }
  } catch {
    return
  }

  const baseStr = note.due_at ?? note.scheduled_at
  if (!baseStr) return
  const base = new Date(baseStr)
  const next = nextOccurrence(rruleString, new Date(), base)
  if (!next) return

  const nextIso = next.toISOString()
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `UPDATE sticky_notes
            SET due_at = ?, updated_at = ?
            WHERE id = ? AND due_at = ?`,
    })
  ).stmtId
  try {
    // R23-DI-3 修复 (high data integrity)：原版 WHERE id = ? 不带 CAS，
    // 用户在 SELECT 与 UPDATE 之间手动改 due_at（编辑器保存）会让下一周期
    // 的计算结果悄悄覆盖用户的新值。修复：WHERE 子句附 `due_at = ?` 把读
    // 到的旧 due_at 作为乐观锁；如果行已经被改，UPDATE changes=0 → 不写入，
    // 下个 cron tick 会基于**当前** due_at 重新算下一次出现时间，不丢数据。
    const info = (await dbClient.call('run', {
      stmtId,
      params: [nextIso, new Date().toISOString(), note.id, note.due_at],
    })) as { changes: number }
    if (info.changes === 0) {
      log.info(
        `[sticky-scheduler] recurrence advance skipped (due_at changed concurrently) note=${note.id}`,
      )
      return
    }
    log.info(`[sticky-scheduler] recurrence advanced note=${note.id} -> ${nextIso}`)
  } finally {
    // R11 修复 (medium #26)：原版不 finalize，cron 每分钟跑 → 每分钟新增 3 个
    // 永远不被回收的 prepared statement；better-sqlite3 句柄表里 24h 累计 4320 行。
    await dbClient.call('finalize', { stmtId }).catch(() => undefined)
  }
}

/**
 * 扫描即将到期/已开始的便签。
 * 对每条命中行：先检查幂等 → 触发通知 → 若重复则推进 due_at。
 *
 * R12 修复 (medium)：原版 due + scheduled 两个 SELECT 跑两遍 prepare/finalize，
 * cron 1/min 触发 → 每天 2880 次 prepare 往返。合并为单个 SELECT 用 OR 连接两
 * 个时间窗条件，重复的活跃便签天然去重。
 */
export async function scanDueStickies(): Promise<{ hit: number }> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - SCAN_WINDOW_MS).toISOString()

  // 1) 单次 SELECT：due_at 在窗口内 或 scheduled_at 在窗口内的活跃便签
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `SELECT id, title, status, priority, due_at, scheduled_at, recurrence, archived, completed_at
            FROM sticky_notes
            WHERE archived = 0
              AND status IN ('todo','in_progress')
              AND completed_at IS NULL
              AND (
                (due_at IS NOT NULL AND due_at >= ? AND due_at <= ?)
                OR (scheduled_at IS NOT NULL AND scheduled_at >= ? AND scheduled_at <= ?)
              )`,
    })
  ).stmtId
  let allRows: StickyRow[]
  try {
    allRows = (await dbClient.call('all', {
      stmtId,
      params: [windowStart, now.toISOString(), windowStart, now.toISOString()],
    })) as StickyRow[]
  } finally {
    await dbClient.call('finalize', { stmtId }).catch(() => undefined)
  }

  // 拆分到 due/scheduled 两组供后续语义化处理（幂等键、advanceRecurrence）
  //
  // R29-DI-7 修复 (HIGH logic-bug)：原 dueRows 只过 `r.due_at !== null`，
  // 不限窗口。如果一条 sticky 是「通过 scheduled_at 命中扫描窗口」但
  // due_at 指向未来一个月（例如 due_at='2026-12-01', scheduled_at='today'），
  // 它仍会落到 dueRows，showStickyDue 拿 dueAt=2026-12-01 派发「今天就到期」
  // 通知，advanceRecurrence 还会把这个未来 due_at 改写到"now 之后下一次
  // RRULE 出现"——永久毁掉用户的 12 月截止日。修复：dueRows 收紧到
  // due_at 在 [windowStart, nowIso] 区间，与 SQL WHERE 对齐。
  const nowIso = now.toISOString()
  const dueRows = allRows.filter((r) =>
    r.due_at !== null
    && r.due_at !== undefined
    && r.due_at >= windowStart
    && r.due_at <= nowIso,
  )
  const schedRows = allRows.filter(
    (r) => (r.scheduled_at !== null && r.scheduled_at !== undefined)
      // 避免重复处理 due 命中
      && (r.due_at === null || r.due_at === undefined
          || r.due_at < windowStart || r.due_at > nowIso),
  )

  const all = [...dueRows, ...schedRows]
  // 按 id 去重
  const seen = new Set<string>()
  const hits: StickyRow[] = []
  for (const r of all) {
    if (!seen.has(r.id)) {
      seen.add(r.id)
      hits.push(r)
    }
  }

  if (hits.length === 0) {
    return { hit: 0 }
  }
  log.info(`[sticky-scheduler] hit ${hits.length} sticky(s) in window`)

  // 3) 触发通知（幂等通过 UNIQUE 约束保证）
  for (const t of hits) {
    try {
      // R11 修复 (high #6)：仅当通知真的派发了才推进 recurrence。
      // 原版无条件 advanceRecurrence —— 当 showStickyDue 因为静默时段 / 用户关闭
      // 通知而 no-op 时，advanceRecurrence 仍把 due_at 推到"now 之后的下一次出现"，
      // 当天的 9 AM 通知永久丢失。返回 delivered=true 才推进；否则保留原 due_at，
      // 下次 cron tick（max 1 分钟）再次尝试派发。
      const delivered = await showStickyDue({
        id: t.id,
        title: t.title,
        dueAt: t.due_at ?? t.scheduled_at,
      })
      if (delivered && t.recurrence) {
        await advanceRecurrence(t)
      } else if (!delivered && t.recurrence) {
        log.info(
          `[sticky-scheduler] keep due_at for ${t.id}: notification suppressed, will retry`,
        )
      }
    } catch (err) {
      log.warn(`[sticky-scheduler] notify failed for ${t.id}:`, (err as Error).message)
    }
  }

  return { hit: hits.length }
}

/**
 * 启动 cron：每分钟扫描一次。
 */
export function startTaskScheduler(): void {
  if (cronJob) {
    log.warn('[sticky-scheduler] already running')
    return
  }
  resetPendingDue()
  cronJob = new Cron(SCAN_CRON, { name: 'sticky-due-scan' }, async () => {
    try {
      await scanDueStickies()
    } catch (err) {
      log.error('[sticky-scheduler] scan error', err)
    }
  })
  log.info('[sticky-scheduler] started (cron: every minute)')
}

/**
 * 停止 cron。
 */
export function stopTaskScheduler(): void {
  if (cronJob) {
    cronJob.stop()
    cronJob = null
    log.info('[sticky-scheduler] stopped')
  }
}

/** 测试用：手动触发一次扫描 */
export async function runOnce(): Promise<{ hit: number }> {
  return scanDueStickies()
}