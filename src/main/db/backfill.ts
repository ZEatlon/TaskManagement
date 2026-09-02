/**
 * 历史回填工具
 *
 * 用于把 `sticky_notes.completed_at` 中已有但未记录到 `completions` 表的
 * 历史完成事件，按日期聚合后写入 `completions` 表。
 *
 * 场景：
 * - 旧数据迁移（已存在的便签尚未记录完成日志）
 * - 修复漏记录（complete() 调用失败但便签已标记为 done）
 * - 笔记历史（note_events）回填
 *
 * 设计：
 * - 幂等：同一 (date, sticky_note_id) 不会重复插入
 * - 增量：基于 settings 标记 'heatmap.backfill.completions.v1' 判断是否已运行
 * - 可手动重跑（force=true 时跳过幂等检查）
 *
 * 历史：原本扫描 tasks 表；统一后改为扫描 sticky_notes。
 */
import { dbClient } from './client'
import log from '../log'
import type { BackfillResult, BackfillSummary } from '@shared/types'

export type { BackfillResult }

const SETTINGS_KEY_COMPLETIONS = 'heatmap.backfill.completions.v1'
const SETTINGS_KEY_NOTE_EVENTS = 'heatmap.backfill.note_events.v1'

/** R22 修复 (medium data integrity)：prepare → 用一次 → finally finalize，
 *  避免 settings 读 / 写的 prepared-statement 句柄泄漏到 worker 缓存。 */
async function withPrepared<T>(
  sql: string,
  run: (stmtId: number) => Promise<T>,
): Promise<T> {
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', { sql })
  ).stmtId
  try {
    return await run(stmtId)
  } finally {
    try {
      await dbClient.call('finalize', { stmtId })
    } catch {
      // finalize 失败不影响业务路径
    }
  }
}

/**
 * 把 Date 转 YYYY-MM-DD
 */
function toISODateLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 读取 settings 中的值
 */
async function getSettingBool(key: string): Promise<boolean> {
  try {
    const row = await withPrepared(`SELECT value FROM settings WHERE key = ?`, async (stmtId) =>
      (await dbClient.call('get', { stmtId, params: [key] })) as { value: string } | null,
    )
    if (!row) return false
    return row.value === '1' || row.value === 'true'
  } catch (err) {
    log.warn(`[backfill] getSetting(${key}) failed`, err)
    return false
  }
}

/**
 * 写入 settings
 */
async function setSetting(key: string, value: string): Promise<void> {
  try {
    const now = new Date().toISOString()
    await withPrepared(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      async (stmtId) => {
        await dbClient.call('run', { stmtId, params: [key, value, now] })
      },
    )
  } catch (err) {
    log.warn(`[backfill] setSetting(${key}) failed`, err)
  }
}

/**
 * 便签完成回填
 *
 * - 扫描 `sticky_notes.completed_at IS NOT NULL`
 * - 按 date 聚合（去重 sticky_note_id）
 * - 对每个 (date, sticky_note_id) 在 `completions` 中检查是否已存在；不存在则插入
 *
 * @param force  强制重跑（跳过幂等检查）
 */
export async function backfillCompletions(force = false): Promise<BackfillResult> {
  const t0 = Date.now()
  if (!force && (await getSettingBool(SETTINGS_KEY_COMPLETIONS))) {
    log.info('[backfill] completions already done, skipping')
    return { scanned: 0, inserted: 0, skipped: true, durationMs: 0 }
  }

  // 1) 扫描所有已完成便签的 (id, completed_at)
  //
  // R31-DI-3 修复 (HIGH invariant-violation)：原版无 archived=0 守卫。
  // R29-DI-1 之后的不变量：archived=1 的 sticky 不该有 completions 行
  // （complete() / becameDone / recordCompletion 全部拒绝 archived）。
  // 但回填从全局 sticky_notes 扫描，遇到「status=done + archived=1 +
  // completed_at 非空」的 legacy 数据（旧 R29 之前的 complete() 没有
  // archived 守卫，可能写过部分）或被回填脚本反复跑的现状行 → 强制插
  // 入 completions 行，污染 heatmap。修复：加 `AND archived = 0` 守卫。
  //
  // R32-DI-MED-1 修复 (MEDIUM corrupted-rows-skipped)：原版 WHERE 子句
  // 还要求 `completed_at IS NOT NULL` —— 这正好**漏掉**另一类损坏行
  // 「status='done' AND completed_at IS NULL」（来自 R21 self-heal 的目标
  // 场景：旧 R21 之前的代码可能产生这种不一致状态、用户手 SQL 改写、
  // 历史数据导入）。这些 sticky 逻辑上已经完成却没 completions 行，
  // heatmap 永久漏算。修复：去掉 completed_at IS NOT NULL 守卫，改成
  // 仅按 status='done' + archived=0 扫描；completed_at 为 null 时 fallback
  // 用「今天」写 completions，并把这类行单列出来记 warning（让用户能
  // 看到自己数据库里有多少损坏 sticky 需要手动 update() 修复）。
  const rows = await withPrepared(
    `SELECT id, completed_at FROM sticky_notes
     WHERE status = 'done' AND archived = 0`,
    async (stmtId) =>
      (await dbClient.call('all', { stmtId, params: [] })) as Array<{
        id: string
        completed_at: string | null
      }>,
  )

  // R21 修复 (medium data integrity)：原 ON CONFLICT(id) DO NOTHING 实质
  // 是 no-op —— id 是新生成的 UUID，永远不会冲突；真正的去重靠 SELECT 1
  // 检查 (sticky_note_id, date)，但并发 backfillCompletions 两次调用（罕见但
  // 可能：用户在设置页重复点击 / 自动诊断 + 手动触发）都会通过 SELECT 检
  // 查、各自 INSERT 新 UUID → completions 表里同一 (sticky_note_id, date)
  // 出现 2 行，热力图把这次完成算 2 次。修复：把 ON CONFLICT 列改成真正
  // 的业务唯一键 (sticky_note_id, date)，conflict 时 DO NOTHING；INSERT
  // 影响行数 0 时不计入 inserted（真正的 atomic dedup）。
  //
  // R22 修复 (medium data integrity)：单条 INSERT 用 withPrepared 包一层
  // finalize —— 避免 N 个 prepared INSERT 句柄泄漏。
  //
  // R25-DI-2 修复 (medium perf)：原版循环里每次循环都先 `crypto.randomUUID()`
  // 生成新 id 再 INSERT —— 即使 ON CONFLICT 把这条 INSERT no-op 掉，UUID
  // 已经白生成。对于 1000+ 完成记录的 backfill，这是上千次无谓的
  // crypto.randomUUID() 调用（虽然 UUIDv4 走的是 native CSPRNG，不贵但
  // 也不是免费的）。修复：先 SELECT 1 预检存在性 —— 已存在就跳过循环
  // 整轮（不生成 UUID、连 INSERT 都不发），ON CONFLICT DO NOTHING 仍作
  // 为并发 race 的兜底（两次并发 backfill 都过 SELECT 时由它去重）。
  let inserted = 0
  let corruptedHealed = 0
  for (const r of rows) {
    // R32-DI-MED-1 修复：completed_at 为 null 时用「今天」fallback，让
    // heatmap 不漏算（损坏 sticky 也算一次完成事件）。同时记入 corrupted
    // 计数，让日志能反映数据库健康度。
    const completionDateIso = r.completed_at ?? new Date().toISOString()
    if (r.completed_at == null) {
      corruptedHealed += 1
      log.warn(
        `[backfill] corrupted sticky id=${r.id} has status=done but completed_at=NULL; backfilling with today`,
      )
    }
    const date = toISODateLocal(new Date(completionDateIso))
    const exists = await withPrepared(
      `SELECT 1 AS x FROM completions WHERE sticky_note_id = ? AND date = ? LIMIT 1`,
      async (stmtId) =>
        (await dbClient.call('get', {
          stmtId,
          params: [r.id, date],
        })) as { x: number } | null,
    )
    if (exists) continue
    const id = crypto.randomUUID()
    const result = await withPrepared(
      `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(sticky_note_id, date) DO NOTHING`,
      async (stmtId) =>
        (await dbClient.call('run', {
          stmtId,
          params: [id, r.id, date, completionDateIso],
        })) as { changes?: number } | null,
    )
    if (result && result.changes === 1) inserted += 1
  }
  if (corruptedHealed > 0) {
    log.warn(
      `[backfill] ${corruptedHealed} corrupted sticky rows healed (status=done, completed_at=NULL); run a one-shot UPDATE to set completed_at for data cleanliness`,
    )
  }

  // 标记完成
  await setSetting(SETTINGS_KEY_COMPLETIONS, '1')

  const durationMs = Date.now() - t0
  log.info(`[backfill] completions done: scanned=${rows.length} inserted=${inserted} (${durationMs}ms)`)
  return { scanned: rows.length, inserted, skipped: false, durationMs }
}

/**
 * 笔记事件回填
 *
 * - 当前没有 notes 表的实际创建时间（仅 mtime/ctime）
 * - 简单实现：扫描 notes 的 mtime（按日期写入 note_events, type='edit'）
 * - 若 notes 表为空则直接跳过
 */
export async function backfillNoteEvents(force = false): Promise<BackfillResult> {
  const t0 = Date.now()
  if (!force && (await getSettingBool(SETTINGS_KEY_NOTE_EVENTS))) {
    log.info('[backfill] note_events already done, skipping')
    return { scanned: 0, inserted: 0, skipped: true, durationMs: 0 }
  }

  let rows: Array<{ id: string; mtime: string }> = []
  try {
    rows = await withPrepared(`SELECT id, mtime FROM notes`, async (stmtId) =>
      (await dbClient.call('all', { stmtId, params: [] })) as Array<{
        id: string
        mtime: string
      }>,
    )
  } catch (err) {
    log.warn('[backfill] notes table not ready, skipping', err)
    return { scanned: 0, inserted: 0, skipped: false, durationMs: Date.now() - t0 }
  }

  let inserted = 0
  // R23-DI-4 修复 (medium data integrity)：原版的 SELECT-then-INSERT 是 TOCTOU
  // —— 两个 backfillNoteEvents 并发跑都过 SELECT、都 INSERT，note_events 表
  // 没有 UNIQUE(note_id,date,type) 约束（001-initial.sql:155-163），重复行
  // 永久残留。另外原版不 finalize prepared statement，每跑一次泄漏 2 条。
  // 修复：单条 INSERT 配 WHERE NOT EXISTS 把存在性检查合并到 SQL 里（同一
  // prepared statement 复用），原子写不重复；用 withPrepared 自动 finalize。
  await withPrepared(
    `INSERT INTO note_events (id, note_id, date, type, count, created_at)
     SELECT ?, ?, ?, 'edit', 1, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM note_events
       WHERE note_id = ? AND date = ? AND type = 'edit'
     )`,
    async (stmtId) => {
      for (const r of rows) {
        const date = toISODateLocal(new Date(r.mtime))
        const id = crypto.randomUUID()
        const info = (await dbClient.call('run', {
          stmtId,
          params: [id, r.id, date, r.mtime, r.id, date],
        })) as { changes: number }
        if (info.changes > 0) inserted += 1
      }
    },
  )

  await setSetting(SETTINGS_KEY_NOTE_EVENTS, '1')

  const durationMs = Date.now() - t0
  log.info(`[backfill] note_events done: scanned=${rows.length} inserted=${inserted} (${durationMs}ms)`)
  return { scanned: rows.length, inserted, skipped: false, durationMs }
}

/**
 * 一站式：依次执行所有回填任务
 * 任何一项失败不影响其它项（仅记录日志）
 */
export async function runAllBackfills(force = false): Promise<BackfillSummary> {
  log.info(`[backfill] starting all backfills (force=${force})...`)
  let completions: BackfillResult = { scanned: 0, inserted: 0, skipped: false, durationMs: 0 }
  let noteEvents: BackfillResult = { scanned: 0, inserted: 0, skipped: false, durationMs: 0 }
  try {
    completions = await backfillCompletions(force)
  } catch (err) {
    log.error('[backfill] completions failed', err)
  }
  try {
    noteEvents = await backfillNoteEvents(force)
  } catch (err) {
    log.error('[backfill] note_events failed', err)
  }
  log.info('[backfill] all done.')
  return { completions, noteEvents }
}