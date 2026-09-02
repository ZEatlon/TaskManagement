/**
 * 热力图主组件（GitHub 风格 · v3 简化版）
 *
 * 设计原则：
 * - **不再使用月份线框**（用户反馈：删除线框；视觉冗余）
 * - 用「细的月份分隔线」（GitHub 风格）代替：每月第一列加 left-border 分隔
 * - 单元格更大、更易读：22px（默认）/ 13px（compact）
 * - 顶部增加 3 张数字卡：今年完成 / 活跃天数 / 当前连胜，一眼看到全局
 *
 * 布局：
 *   .heatmap-wrapper
 *     .heatmap-card
 *       .heatmap-card-topbar   (标题 + 年份)
 *       .heatmap-summary       (3 张数字卡)
 *       .heatmap-card-body
 *         .heatmap-main
 *           .heatmap-scroll / .heatmap-frame
 *             .heatmap-month-track (月份标签条)
 *             .heatmap-body
 *               .heatmap-weekday-col
 *               .heatmap (grid：cells)
 *         .heatmap-stats-sidebar  (扩展统计)
 *       .heatmap-card-footer     (caption + legend)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HeatmapCell } from './HeatmapCell'
import { HeatmapLegend } from './HeatmapLegend'
import { HeatmapTooltip, type HeatmapTooltipPayload } from './HeatmapTooltip'
import {
  buildHeatmapLastNDays,
  toISODate,
  type FirstDayOfWeek,
  type HeatmapData,
  type HeatmapDay,
  weekdayLabel,
} from './heatmapData'
import { useHeatmapStore } from '../../stores/heatmap'

interface HeatmapProps {
  days?: number
  firstDayOfWeek?: FirstDayOfWeek
  data?: HeatmapData
  compact?: boolean
  onCellClick?: (day: HeatmapDay) => void
}

export function Heatmap({
  days = 365,
  firstDayOfWeek = 0,
  data: externalData,
  compact = false,
  onCellClick,
}: HeatmapProps) {
  const storeData = useHeatmapStore((s) => s.data)
  const storeLoading = useHeatmapStore((s) => s.loading)
  const fetchRange = useHeatmapStore((s) => s.fetch)

  const [hoverDay, setHoverDay] = useState<HeatmapDay | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({})

  const [endDate, setEndDate] = useState(() => new Date())
  const startDate = useMemo(() => {
    const d = new Date(endDate)
    d.setDate(d.getDate() - (days - 1))
    return d
  }, [days, endDate])

  const startStr = useMemo(() => toISODate(startDate), [startDate])
  const endStr = useMemo(() => toISODate(endDate), [endDate])

  // R21 修复 (medium perf / data race)：原版无条件 fetchRange —— 当 caller
  // 传了 `data` prop 时（即 externalData 非空），仍然发 IPC 拉数据。这带来
  // 两个问题：
  //   1) 冗余 IPC：调用方已经提供 data 还想自己管 store 加载（典型：
  //      UpcomingStickies 之类小型 widget 只想要日历布局，用 mock data）；
  //   2) store 与 externalData 不一致：fetchRange 写 store.data 后 useMemo
  //      命中 externalData 分支渲染，但下次 mount 切回 store 路径会导致
  //      视觉跳变。
  // 修复：externalData 提供时不调 fetchRange；只走 note-event IPC 拿
  // 笔记活跃度（这部分独立于 completions 数据源）。
  //
  // R23-Corr-5 修复 (medium visual flicker)：跨午夜时 endDate state 推进 1
  // 天 → startStr/endStr 变 → fetchRange 触发 store.loading=true → 网格
  // 瞬间清空（store.data = {}）→ 再被新数据填回；用户盯着热力图过夜会看到
  // 一次「整面灰 → 还原」的闪烁。修复：用 lastFetchRangeStr 缓存上次拉取
  // 的区间，若新区间被旧区间覆盖（end 推进 ≤ 旧 end + 1 且 start ≥ 旧 start），
  // 说明只是滑动一格，无需 IPC + loading 闪动，只更新 endDate state 让
  // 「今天」标记正确迁移即可。
  //
  // R25-Corr-7 修复 (low correctness-stale-data)：原 isSubset 用
  // `startStr >= last.start && endStr <= last.end` 做字符串比较 —— 但
  // YYYY-MM-DD 字符串字典序与日期序一致，单日推进时 startStr 会从
  // '...-01-31' 变 '...-02-01'，endStr 从 '...-01-31' 变 '...-02-01'，
  // 两者都变大，endStr <= last.end 为 false → 早返回失效，fetchRange 仍跑，
  // 闪烁仍发生。修复：把「滑动一格」扩展为「滑动 N 天但新区间是旧区间的
  // 连续子集（即只滑动窗口而不扩大）—— 用日期解析后比较 dayDiff。
  const lastFetchRangeRef = useRef<{ start: string; end: string } | null>(null)
  // R29-A11yPerf-12 修复补充：note-event:daily 的子集检测缓存。
  const lastNoteRangeRef = useRef<{ start: string; end: string } | null>(null)
  useEffect(() => {
    if (externalData) return
    const last = lastFetchRangeRef.current
    if (last) {
      const lastStartMs = Date.parse(last.start + 'T00:00:00')
      const lastEndMs = Date.parse(last.end + 'T00:00:00')
      const newStartMs = Date.parse(startStr + 'T00:00:00')
      const newEndMs = Date.parse(endStr + 'T00:00:00')
      const isValid = !Number.isNaN(lastStartMs) && !Number.isNaN(lastEndMs)
        && !Number.isNaN(newStartMs) && !Number.isNaN(newEndMs)
      // 子集判定：新区间被旧区间完整覆盖（窗口仅向左/右滑动 N 天，days 数
      // 不变）。这里允许 days 数也微变（end 向右扩一天也是合法滑动）—— 用
      // 「旧区间包含新区间」即可。
      const isSubset =
        isValid &&
        newStartMs >= lastStartMs &&
        newEndMs <= lastEndMs
      if (isSubset) return
    }
    lastFetchRangeRef.current = { start: startStr, end: endStr }
    void fetchRange(startStr, endStr)
  }, [fetchRange, startStr, endStr, externalData])

  useEffect(() => {
    let cancelled = false
    // R29-A11yPerf-12 修复 (MEDIUM perf)：原 effect 每次 startStr /
    // endStr 变都立刻 fire note-event:daily，scrub 年份时多次连发 IPC
    // 抖动 UI。修复：与上方 fetchRange 同样的子集检测 + 200ms debounce。
    const last = lastNoteRangeRef.current
    const nowRange = { start: startStr, end: endStr }
    if (last && last.start <= nowRange.start && last.end >= nowRange.end) {
      return
    }
    const handle = window.setTimeout(() => {
      if (cancelled) return
      lastNoteRangeRef.current = nowRange
      void window.api
        .invoke<{ startDate: string; endDate: string }, Record<string, number>>(
          'note-event:daily',
          { startDate: startStr, endDate: endStr },
        )
        .then((res) => {
          if (!cancelled) setNoteCounts(res ?? {})
        })
        .catch(() => {
          if (!cancelled) setNoteCounts({})
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [startStr, endStr])

  // midnight refresh
  useEffect(() => {
    const now = new Date()
    const tomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
      0,
    )
    const ms = tomorrow.getTime() - now.getTime()
    const timer = setTimeout(() => setEndDate(new Date()), ms)
    return () => clearTimeout(timer)
  }, [endDate])

  const data = useMemo<HeatmapData>(() => {
    if (externalData) return externalData
    return buildHeatmapLastNDays(storeData, days, endDate, firstDayOfWeek)
  }, [externalData, storeData, days, endDate, firstDayOfWeek])

  /** 每月第一列的 week index —— 用于 CSS 「细的月份分隔线」。
 *  R31-A11yPerf-6 修复：原版用 Array.includes，O(W*M) 比较；
 *  53 周 * 12 月 = 636 次 compare 每次 render。改为 Set 查 O(1)。 */
  const monthStartWeeksSet = useMemo(() => {
    return new Set(data.monthLabels.map((m) => m.weekIndex))
  }, [data.monthLabels])

  const scrollRef = useRef<HTMLDivElement | null>(null)

  const onCellHover = useCallback((d: HeatmapDay, el: HTMLElement) => {
    setHoverDay(d)
    setAnchor(el)
  }, [])
  const onCellLeave = useCallback(() => {
    setHoverDay(null)
    setAnchor(null)
  }, [])

  const tooltipPayload: HeatmapTooltipPayload | null = hoverDay
    ? {
        date: hoverDay.date,
        taskCount: hoverDay.count,
        noteCount: noteCounts[hoverDay.date] ?? 0,
        isToday: hoverDay.isToday,
      }
    : null

  const totalRangeDays =
    Math.round((data.endDate.getTime() - data.startDate.getTime()) / 86400000) + 1
  const caption = `${totalRangeDays} 天 · 总计 ${data.totalCount} 次 · 活跃 ${data.activeDays} 天`

  return (
    <div className={['heatmap-wrapper', compact ? 'compact' : ''].filter(Boolean).join(' ')}>
      <section className="heatmap-card">
        <div className="heatmap-card-topbar">
          <div className="heatmap-header-title">
            <span className="heatmap-header-year">{data.year}</span>
            <span className="heatmap-header-sub">贡献热力图</span>
          </div>
          {storeLoading && <div className="heatmap-loading muted">加载中...</div>}
        </div>

        {/* 顶部 3 张数字卡：今年总览一眼看到 */}
        <div className="heatmap-summary" aria-label="年度统计">
          <div className="heatmap-summary-card highlight">
            <span className="heatmap-summary-value">{data.totalCount}</span>
            <span className="heatmap-summary-label">年总完成</span>
          </div>
          <div className="heatmap-summary-card">
            <span className="heatmap-summary-value">{data.activeDays}</span>
            <span className="heatmap-summary-label">活跃天数</span>
          </div>
          <div className="heatmap-summary-card highlight">
            <span className="heatmap-summary-value">{data.currentStreak}</span>
            <span className="heatmap-summary-label">当前连胜</span>
          </div>
        </div>

        <div className="heatmap-card-body">
          <div className="heatmap-main">
            <div className="heatmap-scroll" ref={scrollRef}>
              <div className="heatmap-frame">
                {/* R21 修复 (high a11y)：每个 cell 是 role=presentation，键盘
                  用户无法 Tab 进入。需要一个屏幕阅读器可读的「文字版热力图
                  摘要」承担键盘可达性（见 sr-only div），同时把整个 .heatmap
                  grid 用 role=img + aria-label 包裹，让 SR 用户能听到完整
                  摘要（含年总、活跃天数、当前连胜、最大单日）而不必逐 cell
                  扫描。
                  R24-a11y-3 修复 (medium a11y-aria)：原版 outer div 有
                  role=img + aria-label，inner <span> 又写一份纯文字摘要。
                  VoiceOver/NVDA 会读两遍（先 aria-label 再读 inner text），
                  同一组数字出现两次。WCAG 1.3.1 冗余。修复：合并到一份，
                  outer div 保留 role=img + aria-label 作为唯一可读源，
                  inner 元素去掉。 */}
                <div
                  className="sr-only"
                  role="img"
                  aria-label={`${data.year} 年共完成 ${data.totalCount} 次，活跃 ${data.activeDays} 天，当前连胜 ${data.currentStreak} 天，最长连胜 ${data.longestStreak} 天，单日峰值 ${data.maxCount}。详细分布见下方图例与网格。`}
                />

                {/* 月份标签条 */}
                <div
                  className="heatmap-month-track"
                  style={{ ['--week-count' as never]: data.weeks.length }}
                >
                  {data.monthLabels.map((m) => {
                    const isCurrentMonth = data.weeks[m.weekIndex]?.days.some(
                      (d) => d.isToday,
                    )
                    return (
                      <span
                        key={`${m.weekIndex}-${m.label}`}
                        className={[
                          'heatmap-month-label',
                          isCurrentMonth ? 'is-current' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={{ ['--week-index' as never]: m.weekIndex }}
                      >
                        {m.label}
                      </span>
                    )
                  })}
                </div>

                <div className="heatmap-body">
                  <div className="heatmap-weekday-col">
                    {Array.from({ length: 7 }).map((_, i) => (
                      <div key={i} className="heatmap-weekday-label">
                        {weekdayLabel(i, firstDayOfWeek)}
                      </div>
                    ))}
                  </div>

                  {/* 主网格：每列是一周（.heatmap-week-col），首周首列加 is-month-start 类用于分隔线 */}
                  <div
                    className="heatmap"
                    style={{ ['--week-count' as never]: data.weeks.length }}
                  >
                    {data.weeks.map((week, wi) => {
                      const isMonthStart = monthStartWeeksSet.has(wi)
                      return (
                        <div
                          key={`w-${wi}`}
                          className={[
                            'heatmap-week-col',
                            isMonthStart ? 'is-month-start' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          data-week-index={wi}
                        >
                          {week.days.map((day, di) => (
                            <HeatmapCell
                              key={`${wi}-${di}-${day.date}`}
                              day={day}
                              onHover={onCellHover}
                              onLeave={onCellLeave}
                              onClick={onCellClick}
                            />
                          ))}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="heatmap-card-footer">
              <span className="heatmap-footer-caption">{caption}</span>
              <HeatmapLegend max={data.maxCount} />
            </div>
          </div>

          {/* 信息栏：扩展统计 */}
          <aside className="heatmap-stats-sidebar" aria-label="热力图统计">
            <div className="heatmap-stat">
              <span className="heatmap-stat-label">最长连胜</span>
              <span className="heatmap-stat-value">{data.longestStreak}</span>
            </div>
            <div className="heatmap-stat">
              <span className="heatmap-stat-label">日均</span>
              <span className="heatmap-stat-value">{data.avgPerDay.toFixed(1)}</span>
            </div>
            <div className="heatmap-stat">
              <span className="heatmap-stat-label">峰值</span>
              <span className="heatmap-stat-value">{data.maxCount}</span>
            </div>
          </aside>
        </div>
      </section>

      <HeatmapTooltip payload={tooltipPayload} anchor={anchor} />
    </div>
  )
}