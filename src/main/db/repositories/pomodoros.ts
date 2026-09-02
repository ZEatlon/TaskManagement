/**
 * 番茄钟聚合仓储（用于热力图）
 *
 * pomodoros 表主键 id + started_at (ISO) + duration_min + completed
 * 热力图关注"每日完成的专注分钟数"——聚合粒度 = date(started_at)。
 *
 * 与 completionsRepo / noteEventsRepo 同模式：仅暴露 dailyCounts(start, end)。
 */
import { dbClient } from '../client'

/** R28-Perf-3：per-repo stmtCache + invalidate 钩子 */
const pomodorosStmtCache = new Map<string, number>()
let pomodorosInvalidatorRegistered = false

/**
 * R10 修复：计算"UTC ISO → 本地日期"需要的分钟偏移。
 * SQLite 的 date(started_at) 默认按 UTC 取年月日，东半球用户跨过本地 00:00 时
 * 会把番茄记录归到「昨天」/「明天」。在 SQL 里把 started_at 平移本地偏移后再
 * date()，保证聚合粒度 = 用户视角的本地日。
 *
 * 例如 UTC+8：offset = +480 分钟；UTC-5：offset = -300 分钟。
 * SQLite 的 datetime 修饰符接受 `'+NNN minutes'` / `'-NNN minutes'` 形式。
 */
function localOffsetMinutes(): number {
  // JS Date.getTimezoneOffset() 返回「UTC - 本地」的分钟数：
  //   - UTC+8（亚洲）：返回 -480
  //   - UTC-5（美洲）：返回 +300
  // 反号后是「本地 - UTC」，即 SQLite 修饰符要加的偏移。
  return -new Date().getTimezoneOffset()
}

function localOffsetModifier(): string {
  const m = localOffsetMinutes()
  const sign = m >= 0 ? '+' : '-'
  const abs = Math.abs(m)
  return `${sign}${abs} minutes`
}

export class PomodorosRepository {
  /**
   * 返回 [startDate, endDate] 区间内每天完成的专注分钟数（YYYY-MM-DD → 分钟数）。
   * 仅聚合 completed=1 的记录。
   *
   * startDate / endDate 视为本地日（与渲染端 dayKeyOf 一致）；
   * SQL 用本地偏移修饰符把 started_at 从 UTC 平移到本地后再 date()。
   */
  async dailyMinutes(startDate: string, endDate: string): Promise<Record<string, number>> {
    const mod = localOffsetModifier()
    // R28-Perf-3 修复 (high perf)：dailyMinutes 是热力图 / 完成事件后刷
    // 新的 hot path；原 R25 走 try/finally finalize 仍每次付一次 IPC。
    // SQL 是常量（除 ? 绑定参数外），引入 per-repo stmtCache 命中后直
    // 接拿 stmtId，不再 finalize。worker respawn 时 cache 被 invalidate
    // 自动清空。
    if (!pomodorosInvalidatorRegistered) {
      dbClient.registerStmtCacheInvalidator(() => {
        pomodorosStmtCache.clear()
      })
      pomodorosInvalidatorRegistered = true
    }
    const sql = `SELECT date(started_at, ?) as d, SUM(duration_min) as minutes
                 FROM pomodoros
                 WHERE date(started_at, ?) BETWEEN ? AND ?
                   AND completed = 1
                 GROUP BY d ORDER BY d ASC`
    let stmtId = pomodorosStmtCache.get(sql)
    if (stmtId === undefined) {
      stmtId = (
        await dbClient.call<{ stmtId: number }>('prepare', { sql })
      ).stmtId
      pomodorosStmtCache.set(sql, stmtId)
    }
    const rows = (await dbClient.call('all', {
      stmtId,
      params: [mod, mod, startDate, endDate],
    })) as Array<{ d: string; minutes: number | null }>
    const out: Record<string, number> = {}
    for (const r of rows) {
      out[r.d] = r.minutes ?? 0
    }
    return out
  }
}

export const pomodorosRepo = new PomodorosRepository()