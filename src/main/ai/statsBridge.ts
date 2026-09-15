/**
 * AI → 番茄钟统计桥接层
 *
 * 直接查 pomodoros 表做聚合，回答「我今天/本周做了几个番茄」「上周为什么
 * 减少了」这类问题。
 *
 * 时区：pomodoros.started_at 是 UTC ISO 字符串，但用户问的「今天 / 本周」
 * 永远是**本地日历**。所有分桶都先把 started_at 转成本地 Date，再用
 * localDayKeyOf() 取本地日 key —— 绝不用 toISOString().slice(0,10)
 * （那是 UTC 日，UTC+8 用户晚上 8 点后的番茄会被算到"明天"）。
 *
 * 查询窗口同理：range 的起点是**本地**午夜转成的 ISO，SQL 侧与 UTC 列
 * 比较仍然正确（Date→ISO 自动做了时区换算）。
 */
import { dbClient } from '../db/client'
import { prepareCached } from '../db/cachedStmt'
import { localDayKeyOf, startOfDayLocal } from '@shared/lib/dayKey'
import log from '../log'

/**
 * Perf-fix：AI 工具多次调用 `getPomodoroStats` 时，每次 queryRangeRows /
 * queryCount / queryAllDates 都走 withPrepared → prepare + finalize 两次
 * 额外 IPC。三条 SQL 都是常量+可参数化，属于 stmt 缓存的典型场景。
 *
 * 复用模块级 `prepareCached`（与 pomodorosRepo.dailyMinutes / completions
 * / settings / conversations / notes 共享同一 cache + invalidate 钩子）。
 * worker respawn 时由 prepareCached 内部的 module-scope invalidator 自动
 * 清空缓存。
 */

export type StatsRange = 'today' | 'week' | 'month' | 'all'

export interface DayBucket {
  /** 本地日 YYYY-MM-DD */
  date: string
  count: number
  totalMinutes: number
}

export interface PomodoroStats {
  ok: true
  range: StatsRange
  /** 今日完成数（永远返回，与 range 无关，便于 LLM 直接引用） */
  todayCount: number
  /** 本周（最近 7 个本地日，含今日）完成数 */
  weekCount: number
  /** 所选 range 内完成数 */
  rangeCount: number
  /** 所选 range 内总专注分钟 */
  rangeTotalMinutes: number
  /** 平均单次时长（分钟，一位小数）；无数据为 0 */
  averageMinutes: number
  /** 连续完成天数（从今日或昨日往前数，允许今日尚未开始） */
  streakDays: number
  /** 最佳时段（完成数最多的本地小时，格式 "09:00-10:00"）；无数据为 null */
  bestHour: string | null
  bestHourCount: number
  /** 按本地日聚合的桶（按日期升序），range='all' 时最多返回最近 90 天 */
  byDay: DayBucket[]
  /** 绑定便签的番茄数 / 未绑定（stickyNoteId 为 null 的也保留统计） */
  withStickyCount: number
  withoutStickyCount: number
}

export interface PomodoroStatsError {
  ok: false
  error: string
}

/** range='all' 时 byDay 最多返回的天数（防止把几年的数据灌进上下文） */
const MAX_DAY_BUCKETS = 90

/** 本地午夜（今天 00:00:00.000），offsetDays=0 即今天起点，负数回溯 */
function localMidnight(offsetDays = 0): Date {
  const d = startOfDayLocal(new Date())
  d.setDate(d.getDate() + offsetDays)
  return d
}

function rangeStart(range: StatsRange): Date | null {
  switch (range) {
    case 'today':
      return localMidnight(0)
    case 'week':
      return localMidnight(-6) // 含今日共 7 个本地日
    case 'month':
      return localMidnight(-29)
    case 'all':
    default:
      return null
  }
}

/** Perf-fix: range 聚合用的列（不取 id/ended_at），减少 IPC payload */
interface RangeRow {
  started_at: string
  duration_min: number | null
  sticky_note_id: string | null
}

/** Streak 派生只需要 started_at 一列（轻量拉取） */
interface DateOnlyRow {
  started_at: string
}

/**
 * 拉取 range 窗口内 completed=1 的行（按 started_at 升序）。
 * range='all' 时 from=null → 拉全量，但只 SELECT 聚合需要的列。
 *
 * Perf-fix：复用模块级 stmt 缓存（见 prepareCached）—— 同一 SQL 在多次
 * `getPomodoroStats` 调用间共享 stmtId，省掉重复 prepare + finalize 的
 * 两次 IPC roundtrip。
 */
async function queryRangeRows(from: Date | null): Promise<RangeRow[]> {
  const sql = from
    ? `SELECT started_at, duration_min, sticky_note_id
       FROM pomodoros
       WHERE completed = 1 AND started_at >= ?
       ORDER BY started_at ASC`
    : `SELECT started_at, duration_min, sticky_note_id
       FROM pomodoros
       WHERE completed = 1
       ORDER BY started_at ASC`
  const stmtId = await prepareCached(sql)
  return (await dbClient.call('all', {
    stmtId,
    params: from ? [from.toISOString()] : [],
  })) as RangeRow[]
}

/** 拉取所有 completed=1 行的 started_at（仅 streak 派生用）。 */
async function queryAllDates(): Promise<DateOnlyRow[]> {
  const sql = `SELECT started_at FROM pomodoros WHERE completed = 1 ORDER BY started_at ASC`
  const stmtId = await prepareCached(sql)
  return (await dbClient.call('all', { stmtId, params: [] })) as DateOnlyRow[]
}

/** 走 prepared statement 单独取 COUNT(*)。 */
async function queryCount(from: Date): Promise<number> {
  const sql = `SELECT COUNT(*) AS c FROM pomodoros WHERE completed = 1 AND started_at >= ?`
  const stmtId = await prepareCached(sql)
  const row = (await dbClient.call('get', {
    stmtId,
    params: [from.toISOString()],
  })) as { c: number } | undefined
  return row?.c ?? 0
}

/**
 * 计算连续天数：从今日往前数；今日没有记录时允许从昨日起算
 * （用户早上问"我连续多少天了"，今天还没开始不该把 streak 清零）。
 */
function computeStreak(dayKeys: Set<string>): number {
  let streak = 0
  let cursor = 0
  if (!dayKeys.has(localDayKeyOf(localMidnight(0)))) {
    // 今日无记录 → 从昨日开始数
    cursor = -1
    if (!dayKeys.has(localDayKeyOf(localMidnight(-1)))) return 0
  }
  // 上界：不可能超过有记录的天数
  const maxIterations = dayKeys.size + 1
  for (let i = 0; i < maxIterations; i++) {
    const key = localDayKeyOf(localMidnight(cursor))
    if (!dayKeys.has(key)) break
    streak += 1
    cursor -= 1
  }
  return streak
}

/**
 * 返回番茄钟统计。全部字段 camelCase；stickyNoteId 为 null 的记录不被
 * 丢弃，而是计入 withoutStickyCount。
 */
export async function getPomodoroStats(
  range: StatsRange = 'week',
): Promise<PomodoroStats | PomodoroStatsError> {
  try {
    // Perf-fix：range=today/week/month 时只拉窗口内行；todayCount/weekCount 走
    // 单独的 SELECT COUNT(*) prepared statement；streak 派生只 SELECT
    // started_at 一列。range='all' 时仍拉全量，但同样不取冗余字段。
    const todayStart = localMidnight(0)
    const weekStart = localMidnight(-6)
    const from = rangeStart(range)

    // Perf-fix: range='all' 时 queryRangeRows 已经拉了全量 completed=1 行，
    // 再并行 queryAllDates 就是把同样的 started_at 拉第二遍 —— 一次 SQL +
    // 一次 IPC + 一次 deserialize 全白做。改成：range='all' 跳过 queryAllDates，
    // 在 rangeRows 同一遍循环里把 localDayKey 同步塞进 dayKeys Set。
    // 非 'all' 时 rangeRows 窗口外的"过去 streak 天"必须靠 queryAllDates
    // 补齐，否则会把已经在数据里但早于 range 起点的"老 streak 天"误剪掉。
    const isAllRange = range === 'all'
    const [rangeRows, todayCount, weekCount, allDates] = await Promise.all([
      queryRangeRows(from),
      queryCount(todayStart),
      queryCount(weekStart),
      isAllRange ? Promise.resolve([] as DateOnlyRow[]) : queryAllDates(),
    ])

    const byDayMap = new Map<string, DayBucket>()
    const hourCounts = new Array<number>(24).fill(0)
    const dayKeys = new Set<string>()

    let rangeCount = 0
    let rangeTotalMinutes = 0
    let withStickyCount = 0
    let withoutStickyCount = 0

    for (const r of rangeRows) {
      const started = new Date(r.started_at)
      if (Number.isNaN(started.getTime())) {
        // 损坏行不该让整次统计失败
        log.warn(`[ai/statsBridge] skipping pomodoro with invalid started_at`)
        continue
      }
      const key = localDayKeyOf(started)
      rangeCount += 1
      const minutes =
        typeof r.duration_min === 'number' && Number.isFinite(r.duration_min)
          ? Math.max(0, r.duration_min)
          : 0
      rangeTotalMinutes += minutes
      if (r.sticky_note_id) withStickyCount += 1
      else withoutStickyCount += 1

      hourCounts[started.getHours()] += 1
      // range='all' 时 streak 派生复用本轮循环（节省一次全表扫描）
      if (isAllRange) dayKeys.add(key)
      const bucket = byDayMap.get(key)
      if (bucket) {
        bucket.count += 1
        bucket.totalMinutes += minutes
      } else {
        byDayMap.set(key, { date: key, count: 1, totalMinutes: minutes })
      }
    }

    // 非 'all'：streak 用全量 started_at 派生本地日 key（与 range 无关，
    // 必须把 range 窗口外的"过去 streak 天"补齐）。
    if (!isAllRange) {
      for (const r of allDates) {
        const started = new Date(r.started_at)
        if (Number.isNaN(started.getTime())) continue
        dayKeys.add(localDayKeyOf(started))
      }
    }

    let bestHourIdx = -1
    let bestHourCount = 0
    for (let h = 0; h < 24; h++) {
      if (hourCounts[h] > bestHourCount) {
        bestHourCount = hourCounts[h]
        bestHourIdx = h
      }
    }

    const byDay = [...byDayMap.values()]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .slice(-MAX_DAY_BUCKETS)

    return {
      ok: true,
      range,
      todayCount,
      weekCount,
      rangeCount,
      rangeTotalMinutes,
      averageMinutes:
        rangeCount > 0 ? Math.round((rangeTotalMinutes / rangeCount) * 10) / 10 : 0,
      streakDays: computeStreak(dayKeys),
      bestHour:
        bestHourIdx >= 0
          ? `${String(bestHourIdx).padStart(2, '0')}:00-${String((bestHourIdx + 1) % 24).padStart(2, '0')}:00`
          : null,
      bestHourCount,
      byDay,
      withStickyCount,
      withoutStickyCount,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn('[ai/statsBridge] getPomodoroStats failed', err)
    return { ok: false, error: msg }
  }
}
