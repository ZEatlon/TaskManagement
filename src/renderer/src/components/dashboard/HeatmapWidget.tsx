/**
 * Dashboard 内嵌热力图（近三月版 · v4）
 *
 * 设计：
 *   - 显示**近三个月**滚动窗口（约 90 天 / 13~14 周 × 7 天）
 *   - 顶部月份标签行（6月 / 7月 / 8月 等），按 buildHeatmap 的 monthLabels 渲染
 *   - 左侧 weekday 列完整 7 行（周一~周日）
 *   - 数据源切换：便签完成 / 笔记事件 / 番茄专注 3 选 N
 *   - 副标题展示「N 次 · 活跃 M 天 · 连续 K 天 · 日均 X 次」
 *   - 跨午夜 / 跨月自动滚到新月
 *
 * 与 Heatmap.tsx（全年版）的区别：
 *   - Heatmap.tsx 用于设置 / 数据页，整年 365 天
 *   - HeatmapWidget 嵌在 dashboard，近三个月视图，周一首
 */
import { useEffect, useMemo, useState } from 'react'
import { useHeatmapStore } from '../../stores/heatmap'
import {
  buildHeatmapLastNDays,
  weekdayLabel,
  type FirstDayOfWeek,
  type HeatmapDay,
} from '../heatmap'
import { dayKeyOf } from '../../lib/date'

const FIRST_DOW: FirstDayOfWeek = 1 // 周一首（与中文月历对齐）
const DAYS_WINDOW = 90 // 近三月

type Source = 'stickies' | 'notes' | 'pomodoros'

const SOURCE_LABELS: Record<Source, string> = {
  stickies: '便签',
  notes: '笔记',
  pomodoros: '番茄专注',
}

export function HeatmapWidget() {
  const stickiesData = useHeatmapStore((s) => s.data)
  const noteData = useHeatmapStore((s) => s.noteData)
  const pomodoroData = useHeatmapStore((s) => s.pomodoroData)
  const fetch = useHeatmapStore((s) => s.fetch)
  const fetchNoteEvents = useHeatmapStore((s) => s.fetchNoteEvents)
  const fetchPomodoros = useHeatmapStore((s) => s.fetchPomodoros)

  const [sources, setSources] = useState<Record<Source, boolean>>({
    stickies: true,
    notes: false,
    pomodoros: false,
  })

  // 当前日期引用 —— 跨午夜时推进；用于重新计算 heatmap 起始日 + 拉取 IPC
  const [today, setToday] = useState<Date>(() => new Date())
  useEffect(() => {
    function check() {
      const now = new Date()
      // 仅在跨过 00:00 时推进（不依赖 monthRef）
      if (
        now.getFullYear() !== today.getFullYear() ||
        now.getMonth() !== today.getMonth() ||
        now.getDate() !== today.getDate()
      ) {
        setToday(now)
      }
    }
    // 每分钟检查一次（精度足够，避免与系统时间漂移）
    const id = window.setInterval(check, 60_000)
    function onVisibility() {
      if (document.visibilityState === 'visible') setToday(new Date())
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [today])

  const windowStart = useMemo(() => {
    const d = new Date(today)
    d.setDate(d.getDate() - (DAYS_WINDOW - 1))
    return d
  }, [today])
  const windowEnd = today

  // 仅在数据源开启时拉取对应 IPC（避免无意义请求）
  useEffect(() => {
    const start = dayKeyOf(windowStart)
    const end = dayKeyOf(windowEnd)
    if (sources.stickies) void fetch(start, end)
    if (sources.notes) void fetchNoteEvents(start, end)
    if (sources.pomodoros) void fetchPomodoros(start, end)
  }, [sources, fetch, fetchNoteEvents, fetchPomodoros, windowStart, windowEnd])

  // 合并数据：按来源相加（stickies 已包含「完成便签」事件，无需再加）
  const merged: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {}
    if (sources.stickies) {
      for (const [d, n] of Object.entries(stickiesData)) {
        out[d] = (out[d] ?? 0) + n
      }
    }
    if (sources.notes) {
      for (const [d, n] of Object.entries(noteData)) {
        out[d] = (out[d] ?? 0) + n
      }
    }
    if (sources.pomodoros) {
      for (const [d, n] of Object.entries(pomodoroData)) {
        out[d] = (out[d] ?? 0) + n
      }
    }
    return out
  }, [sources, stickiesData, noteData, pomodoroData])

  // 近三月热力图（13~14 周 × 7 天）
  const heatmap = useMemo(
    () => buildHeatmapLastNDays(merged, DAYS_WINDOW, windowEnd, FIRST_DOW),
    [merged, windowEnd],
  )

  function toggleSource(src: Source) {
    setSources((prev) => ({ ...prev, [src]: !prev[src] }))
  }

  // 完整 7 行 weekday 标签（周一~周日）
  const weekdayLabels = useMemo(
    () =>
      Array.from({ length: 7 }).map((_, i) => weekdayLabel(i, FIRST_DOW)),
    [],
  )

  // 月份标签：windowStart / windowEnd 所在月份短标签
  const monthLabelRange = useMemo(() => {
    const start = windowStart.getMonth() + 1
    const end = windowEnd.getMonth() + 1
    return start === end ? `${start}月` : `${start}月 - ${end}月`
  }, [windowStart, windowEnd])

  const periodLabel = `近三月 · ${monthLabelRange}`
  const sub = `近三月完成 ${heatmap.totalCount} 次 · 活跃 ${heatmap.activeDays} 天 · 连续 ${heatmap.currentStreak} 天 · 日均 ${heatmap.avgPerDay.toFixed(1)} 次`

  return (
    <div className="dashboard-heatmap-widget" aria-label="近期活动热力图">
      <header className="card-header">
        <h3>近期活动</h3>
      </header>

      {/* 月份标题：单独一行 + 加大字号，作为 widget 的视觉焦点 */}
      <div className="dashboard-heatmap-period-row">
        <span className="dashboard-heatmap-period">{periodLabel}</span>
      </div>

      {/* 数据源切换 */}
      <div
        className="dashboard-heatmap-sources"
        role="group"
        aria-label="数据源"
      >
        {(Object.keys(SOURCE_LABELS) as Source[]).map((src) => (
          <button
            key={src}
            type="button"
            className={`dashboard-heatmap-source ${sources[src] ? 'is-on' : ''}`}
            onClick={() => toggleSource(src)}
            aria-pressed={sources[src]}
          >
            {SOURCE_LABELS[src]}
          </button>
        ))}
      </div>

      <div className="dashboard-heatmap-sub muted small">{sub}</div>

      {/* 周主体：左 weekday 列 + 右 cells 网格（按行：周一~周日，列：第 1~N 周） */}
      <div className="dashboard-heatmap-body">
        <div className="dashboard-heatmap-weekday-col" aria-hidden>
          {weekdayLabels.map((label, i) => (
            <div key={i} className="dashboard-heatmap-weekday-cell">
              {label}
            </div>
          ))}
        </div>
        <div className="dashboard-heatmap-main">
          {/* 月份标签行：每列 18px + gap 3px，对齐 cells 起始列 */}
          <div
            className="dashboard-heatmap-month-labels"
            style={{ ['--heatmap-weeks' as string]: String(heatmap.weeks.length) }}
            aria-hidden
          >
            {heatmap.weeks.map((_w, idx) => {
              const ml = heatmap.monthLabels.find((m) => m.weekIndex === idx)
              return (
                <span
                  key={idx}
                  className={`dashboard-heatmap-month-label ${ml ? '' : 'is-spacer'}`}
                >
                  {ml?.label ?? ''}
                </span>
              )
            })}
          </div>

          {/* cells 网格：每列代表周，每行代表周一~周日 */}
          <div className="dashboard-heatmap-grid" role="grid">
            {heatmap.weeks.map((week, colIdx) => (
              <div
                key={colIdx}
                className="dashboard-heatmap-col"
                role="row"
              >
                {week.days.map((day: HeatmapDay, dayIdx) => (
                  <div
                    key={`${colIdx}-${dayIdx}-${day.date}`}
                    className={`dashboard-heatmap-cell level-${day.level} ${day.inRange ? '' : 'out-of-range'} ${day.isToday ? 'is-today' : ''}`}
                    title={`${day.date}：${day.count} 次`}
                    role="gridcell"
                    aria-label={`${day.date}：${day.count} 次`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div className="dashboard-heatmap-legend muted small">
        <span>少</span>
        <span className="dashboard-heatmap-legend-cells" aria-hidden>
          {[0, 1, 2, 3, 4].map((lvl) => (
            <span
              key={lvl}
              className={`dashboard-heatmap-legend-cell level-${lvl}`}
              aria-label={`level ${lvl}`}
            />
          ))}
        </span>
        <span>多</span>
      </div>
    </div>
  )
}

export default HeatmapWidget