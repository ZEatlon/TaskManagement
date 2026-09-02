/**
 * 每日专注目标进度环
 *
 * 显示今日完成的番茄钟数 / 每日目标，配圆环进度 + 完成时 🎉 庆祝动画。
 * 数据来源：usePomodoroStore.todayRecords（仅含 completed=1）。
 */
import { useMemo } from 'react'
import { usePomodoroStore } from '../../stores/pomodoro'
import { useDayRollover } from '../../lib/useDayRollover'

const RADIUS = 32
const STROKE = 6
const SIZE = RADIUS * 2 + STROKE * 2
const CENTER = SIZE / 2
const CIRC = 2 * Math.PI * RADIUS

export function DailyGoalRing() {
  const records = usePomodoroStore((s) => s.todayRecords)
  const goal = usePomodoroStore((s) => s.config.dailyGoal)
  // R25-Corr-6 修复 (medium correctness-stale-data)：todayRecords 是
  // pomodoro store 按"今天日期"缓存的列表，跨午夜后不会自动清零。订阅
  // useDayRollover 让 store 重新拉今天的记录，环形进度才不会卡在昨天的
  // 完成度上。
  const loadToday = usePomodoroStore((s) => s.loadToday)
  useDayRollover(() => {
    void loadToday()
  })

  const completed = records.length
  const ratio = goal > 0 ? Math.min(1, completed / goal) : 0
  const done = completed >= goal

  // 庆祝动画：完成时给容器一个一次性 pop keyframe
  const dashOffset = useMemo(() => CIRC * (1 - ratio), [ratio])

  return (
    <div className={`daily-goal-ring ${done ? 'is-done' : ''}`}>
      <svg
        className="daily-goal-svg"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-label="今日目标进度"
      >
        <circle
          className="daily-goal-track"
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
        />
        <circle
          className="daily-goal-progress"
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          strokeDasharray={CIRC}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
        />
      </svg>
      <div className="daily-goal-meta">
        <div className="daily-goal-count">
          <strong>{completed}</strong>
          <span className="daily-goal-sep">/</span>
          <span className="daily-goal-target">{goal}</span>
          <span className="daily-goal-emoji" aria-hidden>
            {done ? '🎉' : '🍅'}
          </span>
        </div>
        <div className="daily-goal-text">
          {done ? '今日目标达成！' : '今日番茄'}
        </div>
      </div>
    </div>
  )
}

export default DailyGoalRing