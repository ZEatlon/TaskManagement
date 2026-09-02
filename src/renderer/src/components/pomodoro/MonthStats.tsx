/**
 * 本月番茄钟统计 —— 单行不换行
 *
 * 用户反馈：日历面板里的番茄钟统计信息搬回番茄钟面板，
 * 而且要写成一行，不要换行。
 *
 * 布局：
 *   [本月 N 个番茄 · M 分钟 · 进度 X%] [▓▓▓▓░░░░░░] 80%
 *
 * 数据源：
 *   - pomodorosDailyApi.daily(monthStart, monthEnd) 拉当月每日专注分钟数
 *   - usePomodoroStore 拿 dailyGoal 算进度
 *
 * 进度语义：
 *   progress = count / (dailyGoal * dayOfMonth)，即"今天为止应该完成的番茄数"
 *   - dayOfMonth 用今天在本月的 day（1~31），跨午夜自动推进
 *   - 进度 100% 表示按计划完成；超过 100% 也只显示 100%（cap）
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { usePomodoroStore } from '../../stores/pomodoro'
import { pomodorosDailyApi } from '../../lib/ipc'
import { dayKeyOf } from '../../lib/date'
import { useDayRollover } from '../../lib/useDayRollover'

/** 当月最后一天（Date 形式，本地 23:59:59 不到，UTC 切日不关心） */
function lastDayOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

interface MonthStatsProps {
  /** 选填：要展示的月份；不传则用当前月 */
  viewMonth?: Date
}

export function MonthStats({ viewMonth }: MonthStatsProps): JSX.Element {
  const dailyGoal = usePomodoroStore((s) => s.config.dailyGoal)
  const loaded = usePomodoroStore((s) => s.loaded)
  const loadConfig = usePomodoroStore((s) => s.loadConfig)

  // today 唯一权威源 —— 跨午夜时刷新（useDayRollover）。
  // monthRef 从 today 直接派生，跨月时自动推进 → monthKey 变化 → useEffect 重拉。
  // 初始若 viewMonth prop 提供则用之，否则用今天。
  const [today, setToday] = useState<Date>(() => viewMonth ?? new Date())
  useDayRollover(() => {
    setToday(new Date())
  })

  const monthRef = useMemo(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
    [today],
  )

  const [dailyMinutes, setDailyMinutes] = useState<Record<string, number>>({})
  const monthKey = `${monthRef.getFullYear()}-${monthRef.getMonth()}`

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  // 拉当月每日分钟数（monthKey 变 → 重新拉，覆盖跨月场景）
  useEffect(() => {
    let cancelled = false
    async function fetchMonth() {
      const year = monthRef.getFullYear()
      const month = monthRef.getMonth()
      const start = new Date(year, month, 1)
      const end = lastDayOfMonth(start)
      try {
        const res = await pomodorosDailyApi.daily(dayKeyOf(start), dayKeyOf(end))
        if (!cancelled) setDailyMinutes(res ?? {})
      } catch (err) {
        if (!cancelled) setDailyMinutes({})
        // eslint-disable-next-line no-console
        console.warn('[MonthStats] pomodorosDailyApi.daily failed:', err)
      }
    }
    void fetchMonth()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey])

  const stats = useMemo(() => {
    let count = 0
    let minutes = 0
    for (const m of Object.values(dailyMinutes)) {
      minutes += m
      // 25 分钟一个番茄（与 FocusCalendar 旧版 / FocusControls 默认对齐）
      count += Math.round(m / 25)
    }
    const isCurrentMonth =
      today.getFullYear() === monthRef.getFullYear() &&
      today.getMonth() === monthRef.getMonth()
    // 目标 = 每日目标 * 已过的天数
    const dayOfMonth = isCurrentMonth ? today.getDate() : lastDayOfMonth(monthRef).getDate()
    const target = Math.max(1, dailyGoal * dayOfMonth)
    const rawPct = (count / target) * 100
    const pct = Math.max(0, Math.min(100, Math.round(rawPct)))
    const monthLabel = `${monthRef.getMonth() + 1} 月`
    return { count, minutes, dayOfMonth, target, pct, monthLabel, isCurrentMonth }
  }, [dailyMinutes, dailyGoal, today, monthRef])

  if (!loaded) {
    return (
      <div className="pomodoro-month-stats muted" aria-busy>
        <span className="pomodoro-month-stats-label">本月统计加载中…</span>
      </div>
    )
  }

  const ariaLabel = `本月 ${stats.count} 个番茄，共 ${stats.minutes} 分钟，进度 ${stats.pct}%`

  return (
    <div
      className="pomodoro-month-stats"
      role="group"
      aria-label="本月番茄钟统计"
      title={ariaLabel}
    >
      <span className="pomodoro-month-stats-label">{stats.monthLabel}</span>
      <span className="pomodoro-month-stats-sep">·</span>
      <span className="pomodoro-month-stats-num">
        <strong>{stats.count}</strong> 个番茄
      </span>
      <span className="pomodoro-month-stats-sep">·</span>
      <span className="pomodoro-month-stats-num">
        <strong>{stats.minutes}</strong> 分钟
      </span>
      <span className="pomodoro-month-stats-sep">·</span>
      <span className="pomodoro-month-stats-progress-label">
        进度 <strong>{stats.pct}</strong>%
      </span>
      <span
        className="pomodoro-month-stats-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={stats.pct}
        aria-valuetext={`${stats.pct}%`}
      >
        <span
          className="pomodoro-month-stats-bar-fill"
          style={{ width: `${stats.pct}%` }}
        />
      </span>
    </div>
  )
}

const MemoMonthStats = memo(MonthStats)

export default MemoMonthStats
