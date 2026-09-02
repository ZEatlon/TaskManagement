/**
 * 今日完成的番茄钟列表
 *
 * 历史：曾显示「关联便签标题 + 完成时间 + 专注时长」；用户反馈去掉关联便签后，
 * 这里也同步简化成「完成时间 + 专注时长」两列，不再去查便签 store。
 *
 * - 每条：完成时间、专注时长
 * - v4 删除底部 summary：「共 N 个番茄钟 · 总专注 N 分钟」一行 —— 用户反馈
 *   「修正成一行 / 删除」，直接移除该块。
 */
import { useEffect } from 'react'
import { usePomodoroStore } from '../../stores/pomodoro'
import { useDayRollover } from '../../lib/useDayRollover'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function TodayPomodoros() {
  const records = usePomodoroStore((s) => s.todayRecords)
  const loadToday = usePomodoroStore((s) => s.loadToday)

  useEffect(() => {
    void loadToday()
  }, [loadToday])

  // R25-Corr-6 修复 (medium correctness-stale-data)：原版只在 mount 时
  // loadToday() 一次。跨午夜后 store.todayRecords 仍是昨天的记录，组件
  // 渲染「今日还没有完成的番茄钟」/ 显示昨天的列表 直到 remount。
  // 订阅 useDayRollover：午夜切换 / visibilitychange 切回前台 → 重新拉。
  useDayRollover(() => {
    void loadToday()
  })

  return (
    <section className="today-pomodoros">
      <h3>今日番茄钟</h3>
      {records.length === 0 ? (
        <div className="empty-tip muted">今日还没有完成的番茄钟</div>
      ) : (
        <ul className="today-list">
          {records.map((r) => (
            <TodayItem
              key={r.id}
              endedAt={r.endedAt}
              durationMin={r.durationMin ?? 0}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function TodayItem({
  endedAt,
  durationMin,
}: {
  endedAt: string | null
  durationMin: number
}) {
  return (
    <li className="today-item">
      <span className="today-time">{endedAt ? fmtTime(endedAt) : '--:--'}</span>
      <span className="today-pomodoro-title">番茄</span>
      <span className="today-duration">{durationMin} 分钟</span>
    </li>
  )
}

export default TodayPomodoros