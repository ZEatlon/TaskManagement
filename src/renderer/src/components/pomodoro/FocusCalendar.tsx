/**
 * 月历组件（v3 · 待办便签版）
 *
 * 用途变更：
 *   - 不再展示番茄钟数据（pomodoroCount / pomodoroMinutes 已移除）。
 *   - 改为展示「截止便签」：每个 cell 根据当日 dueAt 的便签数量显示 dot / badge。
 *
 * 设计：
 * - 7×6 月历网格，显示公历日期 + 农历日期 + 节气
 * - 顶部 weekday 表头（一二三四五六日）
 * - 上月/下月日期淡化（透明度 0.35）
 * - 今天用青色圆圈高亮（与整体紫色主题形成对比）
 * - 支持 prev/next 月切换
 * - 日期可点击
 * - 鼠标悬停时显示「当日便签数 / 便签标题」tooltip
 *
 * 数据源：
 *   - stickyNotesApi.listFiltered({ dueAfter, dueBefore, archived: false })
 *     后端仓储已按本地 00:00 切端点（避免 UTC 漏日）。
 *   - solarToLunar 从 ../../lib/lunar 复用
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { solarToLunar, type LunarDate } from '../../lib/lunar'
import { stickyNotesApi } from '../../lib/ipc'
import { dayKeyOf } from '../../lib/date'
import type { StickyNote } from '@shared/types'

interface FocusCalendarProps {
  /** 当前显示的月份（任意一天都代表月份） */
  viewMonth: Date
  /** 切换月份 */
  onPrevMonth: () => void
  onNextMonth: () => void
  /** 点击日期回调（可选） */
  onSelectDate?: (date: Date) => void
  /** 当前选中的日期（高亮显示） */
  selectedDate?: Date | null
}

interface DayCellData {
  date: Date
  solarDay: number
  isCurrentMonth: boolean
  isToday: boolean
  isSelected: boolean
  lunar: LunarDate
  /** 当日截止的便签数（默认排除 archived） */
  dueCount: number
  /** 截止便签的标题列表（最多 5 条，用于 tooltip） */
  dueTitles: string[]
  /** 是否有 p0/p1 高优先级便签截止（决定 dot 颜色） */
  hasUrgent: boolean
}

/** 中文星期缩写（一二三四五六日） */
const WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 生成当前显示月份的 6×7 = 42 个日期单元格。
 * 算法：以本月 1 号为基准，找到它所在周的周一，向后填充 42 天，
 *       保证永远显示 6 周，行首始终对齐周一。
 */
function buildMonthGrid(
  viewMonth: Date,
  selectedDate: Date | null | undefined,
  dueByKey: Record<string, StickyNote[]>,
  // R25-Corr-1：today 从组件 state 传入而非内部 new Date()，让跨午夜的
  // state 更新能透传过来（useMemo deps 包含 today → 重新计算 cells）。
  today: Date = new Date(),
): DayCellData[] {
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`
  const viewYear = viewMonth.getFullYear()
  const viewMon = viewMonth.getMonth()

  const firstOfMonth = new Date(viewYear, viewMon, 1)
  const weekdayOfFirst = firstOfMonth.getDay()
  const offsetToMonday = (weekdayOfFirst + 6) % 7 // 0 = 周一

  const cells: DayCellData[] = []
  const gridStart = new Date(viewYear, viewMon, 1 - offsetToMonday)

  for (let i = 0; i < 42; i += 1) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    const isCurrentMonth = d.getMonth() === viewMon
    const isToday = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey
    const lunar = solarToLunar(d)
    const key = dayKeyOf(d)
    const notes = dueByKey[key] ?? []
    const dueCount = notes.length
    const dueTitles = notes.slice(0, 5).map((n) => n.title)
    const hasUrgent = notes.some((n) => n.priority === 'p0' || n.priority === 'p1')
    const isSelected =
      selectedDate != null &&
      d.getFullYear() === selectedDate.getFullYear() &&
      d.getMonth() === selectedDate.getMonth() &&
      d.getDate() === selectedDate.getDate()
    cells.push({
      date: d,
      solarDay: d.getDate(),
      isCurrentMonth,
      isToday,
      isSelected,
      lunar,
      dueCount,
      dueTitles,
      hasUrgent,
    })
  }

  return cells
}

interface HoverInfo {
  cell: DayCellData
  /** tooltip anchor rect (viewport-relative) */
  rect: DOMRect
  /** preferred placement: 'above' or 'below' */
  placement: 'above' | 'below'
}

export function FocusCalendar({
  viewMonth,
  onPrevMonth,
  onNextMonth,
  onSelectDate,
  selectedDate,
}: FocusCalendarProps) {
  // 按 YYYY-MM-DD 分组的便签（只含 dueAt 落在 viewMonth 月内 + buffer 的）
  const [dueByKey, setDueByKey] = useState<Record<string, StickyNote[]>>({})
  const [hover, setHover] = useState<HoverInfo | null>(null)
  // R14 修复 (medium)：ARIA grid 要求每格可被方向键导航，且每 7
  // 格为一行。buttonRefs 用 data-daykey 索引，方向键在格间移动焦点。
  const buttonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())
  const COLS = 7

  // 当 viewMonth 变化时拉取该月 + 上下半月 buffer 的数据（±1 周已够 42 格）
  useEffect(() => {
    let cancelled = false
    async function fetchDue() {
      const start = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
      start.setDate(start.getDate() - 7)
      const end = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0)
      end.setDate(end.getDate() + 7)
      try {
        const res = await stickyNotesApi.listFiltered({
          dueAfter: dayKeyOf(start),
          dueBefore: dayKeyOf(end),
          archived: false,
        })
        if (cancelled) return
        const grouped: Record<string, StickyNote[]> = {}
        for (const n of res ?? []) {
          if (!n.dueAt) continue
          // dueAt 是 ISO timestamp，转本地 dayKey
          const local = new Date(n.dueAt)
          const k = dayKeyOf(local)
          const arr = grouped[k] ?? []
          arr.push(n)
          grouped[k] = arr
        }
        setDueByKey(grouped)
      } catch (err) {
        if (!cancelled) setDueByKey({})
         
        console.warn('[FocusCalendar] stickyNotesApi.listFiltered failed:', err)
      }
    }
    void fetchDue()
    // R11 修复 (low #3)：窗口从后台切回前台时强制重拉一次，让
    // calendar 数据与 store 状态同步。
    function onVisibility() {
      if (document.visibilityState === 'visible') void fetchDue()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [viewMonth])

  const monthLabel = `${viewMonth.getFullYear()}年${viewMonth.getMonth() + 1}月`
  // R11 修复 (low #2)：跨午夜时 today 推进，cells 重算「今天」高亮与「本月便签」统计。
  const [today, setToday] = useState<Date>(() => new Date())

  // R25-Corr-1 修复 (high correctness-stale-date)：today 加进 deps。
  const cells = useMemo(
    () => buildMonthGrid(viewMonth, selectedDate, dueByKey, today),
    [viewMonth, selectedDate, dueByKey, today],
  )
  useEffect(() => {
    let timer: number | null = null
    function scheduleNextMidnightRefresh() {
      const now = new Date()
      const next = new Date(now)
      next.setHours(24, 0, 5, 0) // 凌晨 00:00:05 触发，避免边界竞争
      const ms = Math.max(1000, next.getTime() - now.getTime())
      timer = window.setTimeout(() => {
        setToday(new Date())
        scheduleNextMidnightRefresh()
      }, ms)
    }
    scheduleNextMidnightRefresh()
    function onVisibility() {
      if (document.visibilityState === 'visible') setToday(new Date())
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  const isViewingCurrentMonth =
    today.getFullYear() === viewMonth.getFullYear() && today.getMonth() === viewMonth.getMonth()

  // 当月有便签截止的总览
  const monthStats = useMemo(() => {
    let count = 0
    for (const c of cells) {
      if (!c.isCurrentMonth) continue
      count += c.dueCount
    }
    return { count }
  }, [cells])

  function handleEnter(cell: DayCellData, el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    // 顶部空间不足（< 80px）时切换为下方显示，避免被裁剪
    const placement = rect.top < 80 ? 'below' : 'above'
    setHover({ cell, rect, placement })
  }
  function handleLeave() {
    setHover(null)
  }

  return (
    <div className="focus-calendar" role="grid" aria-label="月历">
      {/* 顶部：月份标题 + 切换按钮 + 当月汇总 */}
      <div className="focus-calendar-toolbar">
        <button
          type="button"
          className="focus-calendar-nav"
          onClick={onPrevMonth}
          aria-label="上个月"
        >
          ‹
        </button>
        <div className="focus-calendar-title">
          <span className="focus-calendar-month">{monthLabel}</span>
          {monthStats.count > 0 && (
            <span className="focus-calendar-monthstat" title="本月截止的便签数">
              · 本月 <strong>{monthStats.count}</strong> 张待办便签
            </span>
          )}
        </div>
        <button
          type="button"
          className="focus-calendar-nav"
          onClick={onNextMonth}
          aria-label="下个月"
        >
          ›
        </button>
        {!isViewingCurrentMonth && (
          <button
            type="button"
            className="focus-calendar-today"
            onClick={() => onSelectDate?.(today)}
          >
            回到今天
          </button>
        )}
      </div>

      {/* weekday 表头 */}
      <div className="focus-calendar-weekdays" role="row">
        {WEEKDAY_HEADERS.map((w) => (
          <div key={w} className="focus-calendar-weekday" role="columnheader">
            {w}
          </div>
        ))}
      </div>

      {/* 日期网格：按周 7 列切行；每行 role="row"，每格 role="gridcell" */}
      <div className="focus-calendar-grid" role="rowgroup">
        {Array.from({ length: Math.ceil(cells.length / COLS) }, (_, rowIdx) => (
          <div
            key={rowIdx}
            className="focus-calendar-row"
            role="row"
          >
            {cells.slice(rowIdx * COLS, rowIdx * COLS + COLS).map((cell) => {
              const { lunar } = cell

              const showLunarDay =
                lunar.day === 1
                  ? lunar.monthName.replace('闰', '')
                  : lunar.dayName

              const isLeapFirstDay = lunar.isLeap && lunar.day === 1
              const lunarText = lunar.term
                ? lunar.term
                : isLeapFirstDay
                  ? `闰${lunar.monthName}`
                  : showLunarDay

              const cellClasses = [
                'focus-calendar-cell',
                cell.isCurrentMonth ? 'in-month' : 'out-month',
                cell.isToday ? 'is-today' : '',
                cell.isSelected ? 'is-selected' : '',
                lunar.term ? 'has-term' : '',
                isLeapFirstDay ? 'is-leap' : '',
                cell.dueCount > 0 ? 'has-due' : '',
                cell.hasUrgent ? 'has-urgent' : '',
                cell.dueCount >= 4 ? 'has-many-due' : '',
              ]
                .filter(Boolean)
                .join(' ')

              const dayKey = dayKeyOf(cell.date)
              return (
                <button
                  key={dayKey}
                  type="button"
                  role="gridcell"
                  className={cellClasses}
                  onClick={() => onSelectDate?.(cell.date)}
                  onMouseEnter={(e) => handleEnter(cell, e.currentTarget)}
                  onMouseLeave={handleLeave}
                  onFocus={(e) => handleEnter(cell, e.currentTarget)}
                  onBlur={handleLeave}
                  // R14 修复 (medium)：ARIA grid 方向键导航 + Home/End。
                  onKeyDown={(e) => {
                    if (e.altKey || e.metaKey || e.ctrlKey) return
                    const idx = cells.findIndex((c) => dayKeyOf(c.date) === dayKey)
                    if (idx < 0) return
                    let nextIdx = idx
                    if (e.key === 'ArrowLeft') nextIdx = idx - 1
                    else if (e.key === 'ArrowRight') nextIdx = idx + 1
                    else if (e.key === 'ArrowUp') nextIdx = idx - COLS
                    else if (e.key === 'ArrowDown') nextIdx = idx + COLS
                    else if (e.key === 'Home') nextIdx = rowIdx * COLS
                    else if (e.key === 'End') nextIdx = rowIdx * COLS + (COLS - 1)
                    else return
                    e.preventDefault()
                    if (nextIdx < 0 || nextIdx >= cells.length) return
                    const target = buttonRefs.current.get(dayKeyOf(cells[nextIdx].date))
                    target?.focus()
                  }}
                  ref={(el) => {
                    // R25-Corr-3 修复 (medium correctness-ref-leak)：原版只 set
                    // 不 delete —— 切换月份时旧月份的所有 cell ref 都还留在 Map
                    // 里。修复：el 变化（mount → null on unmount）时主动 delete。
                    if (el) {
                      buttonRefs.current.set(dayKey, el)
                    } else {
                      buttonRefs.current.delete(dayKey)
                    }
                  }}
                  aria-label={
                    `${cell.date.getFullYear()}年${cell.date.getMonth() + 1}月${cell.solarDay}日，农历${lunar.monthName}${lunar.dayName}${lunar.term ? '，节气' + lunar.term : ''}` +
                    (cell.dueCount > 0 ? `，${cell.dueCount} 张便签截止` : '')
                  }
                  aria-pressed={cell.isSelected}
                >
                  <span className="focus-calendar-solar">{cell.solarDay}</span>
                  <span className="focus-calendar-lunar">{lunarText}</span>
                  {cell.dueCount > 0 && cell.dueCount < 4 && (
                    <span
                      className={`focus-calendar-due-dot ${cell.hasUrgent ? 'is-urgent' : ''}`}
                      aria-hidden
                    />
                  )}
                  {cell.dueCount >= 4 && (
                    <span className="focus-calendar-due-badge" aria-hidden>
                      {cell.dueCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* 悬停 tooltip：跟随单元格的 fixed 定位 */}
      {hover && (
        <div
          className={['focus-calendar-tooltip', `is-${hover.placement}`].filter(Boolean).join(' ')}
          role="tooltip"
          style={{
            position: 'fixed',
            left: Math.max(8, Math.min(window.innerWidth - 8, hover.rect.left + hover.rect.width / 2)),
            top:
              hover.placement === 'above'
                ? hover.rect.top - 6
                : hover.rect.bottom + 6,
            transform:
              hover.placement === 'above'
                ? 'translate(-50%, -100%)'
                : 'translate(-50%, 0%)',
            pointerEvents: 'none',
            zIndex: 1000,
          }}
        >
          <div className="focus-calendar-tooltip-title">
            {hover.cell.date.getMonth() + 1}月{hover.cell.date.getDate()}日
            {' · '}
            {hover.cell.lunar.monthName}
            {hover.cell.lunar.dayName}
            {hover.cell.lunar.term ? ` · ${hover.cell.lunar.term}` : ''}
          </div>
          {hover.cell.dueCount > 0 ? (
            <div className="focus-calendar-tooltip-body">
              <div className="focus-calendar-tooltip-stat">
                📌 <strong>{hover.cell.dueCount}</strong> 张便签截止
              </div>
              <ul className="focus-calendar-tooltip-titles">
                {hover.cell.dueTitles.map((t, i) => (
                  <li key={i} className="focus-calendar-tooltip-title-item">
                    · {t}
                  </li>
                ))}
                {hover.cell.dueCount > hover.cell.dueTitles.length && (
                  <li className="focus-calendar-tooltip-more muted">
                    +{hover.cell.dueCount - hover.cell.dueTitles.length} 更多…
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <div className="focus-calendar-tooltip-empty">当日无待办便签</div>
          )}
        </div>
      )}
    </div>
  )
}
