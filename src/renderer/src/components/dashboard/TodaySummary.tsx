/**
 * 今日摘要
 *
 * 显示三个关键指标（基于便签）：
 *   - 今日便签数（date = today 的便签）
 *   - 今日已完成 step 数（status='done' 的步骤数）
 *   - 逾期数（dueAt < today）
 *
 * 数据：父组件 useMemo 派生一次后传入；单独使用时也可仅传 stickies，
 * 由组件自行计算。
 */
import { useMemo } from 'react'
import type { StickyNote } from '@shared/types'
import { useTodayKey } from '../../lib/useDayRollover'

export interface TodayStats {
  todayStickies: number
  todayDoneSteps: number
  overdue: number
}

interface Props {
  /** 当前便签列表 */
  stickies: StickyNote[]
  /** 由父组件派生一次的今日统计；不传则由本组件基于 stickies 计算 */
  todayStats?: TodayStats
}

function computeTodayStats(stickies: StickyNote[], todayKey: string): TodayStats {
  // 今日 0~24h 区间（毫秒时间戳）
  const todayStart = new Date(`${todayKey}T00:00:00.000`).getTime()

  let todayStickies = 0
  let todayDoneSteps = 0
  let overdue = 0

  for (const n of stickies) {
    if (n.date === todayKey) todayStickies++
    // 已完成步骤：数的是 step 本身（不是 sticky），分母是 sticky 数 ——
    // 见 stepCompletion 处的封顶处理。
    if (n.date === todayKey) {
      todayDoneSteps += n.steps.filter((s) => s.done).length
    }
    if (n.status !== 'done' && n.dueAt) {
      const due = new Date(n.dueAt).getTime()
      if (due < todayStart) overdue++
    }
  }

  return { todayStickies, todayDoneSteps, overdue }
}

export function TodaySummary({ stickies, todayStats: providedStats }: Props) {
  // R5R-4：跨午夜后必须重新计算 todayKey，否则 stats 会停留在昨天。
  const todayKey = useTodayKey()
  const stats = useMemo<TodayStats>(
    () => providedStats ?? computeTodayStats(stickies, todayKey),
    [stickies, providedStats, todayKey],
  )

  // R5-28：今日已完成步骤是按 step 计数，但分母是 sticky 数 —— 一条 sticky 含 5 个
  // step 全勾选时 todayDoneSteps=5 / todayStickies=1 = 500%。封顶到 100%。
  const stepCompletion = stats.todayStickies === 0
    ? 0
    : Math.min(100, Math.round((stats.todayDoneSteps / Math.max(stats.todayStickies, 1)) * 100))

  return (
    <div className="today-summary">
      <header className="card-header">
        <h3>今日摘要</h3>
      </header>
      <div className="today-summary-grid">
        <div className="summary-item">
          <span className="summary-num">{stats.todayStickies}</span>
          <span className="summary-label">今日便签</span>
        </div>
        <div className="summary-item">
          <span className="summary-num success">{stats.todayDoneSteps}</span>
          <span className="summary-label">今日已完成步骤</span>
        </div>
        <div className={`summary-item ${stats.overdue > 0 ? 'has-warning' : ''}`}>
          <span className={`summary-num ${stats.overdue > 0 ? 'danger' : ''}`}>{stats.overdue}</span>
          <span className="summary-label">逾期未完成</span>
        </div>
      </div>
      <div className="today-progress">
        <div className="progress-track">
          <div
            className="progress-bar"
            style={{ width: `${stepCompletion}%` }}
            role="progressbar"
            aria-valuenow={stepCompletion}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`完成率 ${stepCompletion}%`}
          />
        </div>
        <span className="progress-text muted">完成率 {stepCompletion}%</span>
      </div>
    </div>
  )
}

export default TodaySummary