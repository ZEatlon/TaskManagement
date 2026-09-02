/**
 * Dashboard 今日便签预览
 *
 * - 标题 + 进度统计
 * - Top 4 便签（按优先级 + 创建时间排序）
 * - 每行：优先级 dot + 标题 + 完成进度（如「3/5」）
 * - 「查看全部」链接 → /today
 */
import { useEffect, useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { useStickyNotesStore } from '../../stores/stickyNotes'
import { useTodayKey } from '../../lib/useDayRollover'
import { formatDayLabel } from '../../lib/formatDate'

const PRIORITY_WEIGHT: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

interface Props {
  /** 最多展示多少条（默认 4） */
  limit?: number
}

export function StickyNotesWidget({ limit = 4 }: Props) {
  const byDate = useStickyNotesStore((s) => s.byDate)
  const fetchRange = useStickyNotesStore((s) => s.fetchRange)

  // R15 修复 (low)：原版直接 `dayKeyOf(new Date())` 在每次 render 时计算，
  // 跨过午夜后视图会一直停留在昨天。改用 useTodayKey 订阅 rollover。
  const todayKey = useTodayKey()

  // 进入 widget 时拉一次今日数据（轻量：单日窗口）
  useEffect(() => {
    if (!byDate[todayKey]) {
      fetchRange(todayKey, todayKey)
    }
  }, [todayKey, byDate, fetchRange])

  const todayNotes = byDate[todayKey] ?? []

  const sorted = useMemo(() => {
    return [...todayNotes].sort((a, b) => {
      const pa = PRIORITY_WEIGHT[a.priority] ?? 99
      const pb = PRIORITY_WEIGHT[b.priority] ?? 99
      if (pa !== pb) return pa - pb
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
    })
  }, [todayNotes])

  const shown = sorted.slice(0, limit)
  const totalDone = sorted.reduce((acc, n) => acc + n.steps.filter((s) => s.done).length, 0)
  const totalSteps = sorted.reduce((acc, n) => acc + n.steps.length, 0)

  return (
    <section className="widget sticky-notes-widget">
      <header className="widget-header">
        <div>
          <h3 className="widget-title">今日便签</h3>
          <p className="widget-sub">
            {sorted.length > 0
              ? `${formatDayLabel(todayKey)} · ${totalDone}/${totalSteps} 步完成`
              : `${formatDayLabel(todayKey)} · 还没有便签`}
          </p>
        </div>
        <Link to="/today" className="widget-link" title="打开今日便签">
          查看全部 →
        </Link>
      </header>

      {shown.length === 0 ? (
        <div className="sticky-notes-widget-empty">
          <p style={{ marginBottom: '6px' }}>今日还没有便签 ✨</p>
          <Link to="/today" className="widget-link">
            去 /today 创建
          </Link>
        </div>
      ) : (
        <ul className="sticky-notes-widget-list">
          {shown.map((n) => {
            const done = n.steps.filter((s) => s.done).length
            const total = n.steps.length
            // R17 修复 (low a11y)：原 priority-dot 用 aria-hidden=true 仅靠
            // 颜色传达优先级，违反 WCAG 1.4.1「颜色不是传达信息的唯一手段」
            // —— SR 用户与色弱用户都无法得知 P0/P1/P2/P3。给 li 加 aria-label
            // 把优先级与进度冗余到 accessible name，dot 本身保留 aria-hidden
            // 但视觉色彩仍然呈现。
            const priorityLabel = `[P${n.priority.slice(1)}]`
            const progressLabel = total > 0 ? `，${done}/${total} 完成` : ''
            return (
              <li
                key={n.id}
                className="sticky-notes-widget-item"
                aria-label={`${priorityLabel} ${n.title}${progressLabel}`}
              >
                <span
                  className={`priority-dot priority-${n.priority}`}
                  aria-hidden
                />
                <span className="widget-item-title" title={n.title}>
                  {n.title}
                </span>
                <span className="widget-item-progress" aria-hidden>
                  {total > 0 ? `${done}/${total}` : '—'}
                </span>
              </li>
            )
          })}
          {sorted.length > shown.length && (
            <li className="sticky-notes-widget-item" style={{ justifyContent: 'center' }}>
              <Link to="/today" className="widget-link">
                +{sorted.length - shown.length} 张更多 →
              </Link>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}