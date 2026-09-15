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
} from '../heatmap/heatmapData'
import { dayKeyOf, fromDayKey } from '../../lib/date'
import { useTodayKey } from '../../lib/useDayRollover'
import { useSettingsStore } from '../../stores/settings'
import { getCalendarMessages, getHeatmapMessages } from '@shared/i18n/locales'

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

  // 当前日期引用 —— 跨午夜时推进；用于重新计算 heatmap 起始日 + 拉取 IPC。
  // 复用 lib/useDayRollover 提供的 useTodayKey（事件驱动，模块级共享
  // 60s 轮询 + visibilitychange），避免与 TodaySummary / StickyNotesWidget
  // 各挂一份 setInterval 重复唤醒。
  const todayKey = useTodayKey()
  const today = useMemo(() => fromDayKey(todayKey), [todayKey])

  const windowStart = useMemo(() => {
    const d = new Date(today)
    d.setDate(d.getDate() - (DAYS_WINDOW - 1))
    return d
  }, [today])
  const windowEnd = today

  // 仅在数据源开启时拉取对应 IPC（避免无意义请求）。
  // R37-fix-high (perf)：拆成三路独立 effect，每个 deps 只含对应 boolean +
  // 窗口边界。toggleSource 只生成新 sources 对象、单一 boolean 翻转 → 仅该路
  // effect 重跑，避免切换一路时把另两路 IPC + DB 查询白白重拉（每路 30-80ms）。
  useEffect(() => {
    if (!sources.stickies) return
    void fetch(dayKeyOf(windowStart), dayKeyOf(windowEnd))
  }, [sources.stickies, fetch, windowStart, windowEnd])

  useEffect(() => {
    if (!sources.notes) return
    void fetchNoteEvents(dayKeyOf(windowStart), dayKeyOf(windowEnd))
  }, [sources.notes, fetchNoteEvents, windowStart, windowEnd])

  useEffect(() => {
    if (!sources.pomodoros) return
    void fetchPomodoros(dayKeyOf(windowStart), dayKeyOf(windowEnd))
  }, [sources.pomodoros, fetchPomodoros, windowStart, windowEnd])

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

  // R-fix-i18n-weekday-label (medium)：左侧 weekday 标签跟随 settings.language 切换。
  // 只订阅 language 字段避免 settings store 其它字段变化触发整 widget 重渲染。
  const language = useSettingsStore((s) => s.language)
  const calendarMessages = useMemo(() => getCalendarMessages(language), [language])
  // R-fix-i18n-heatmap-widget-strings (medium)：图例 5 档量化描述 /
  // period 标题 / 长 summary / 图例两端「少」「多」从 HeatmapMessages 取
  // —— 之前是硬编码中文，与 HeatmapMessages 已有字段走同一套 i18n 注册表
  // 的结构不一致（Heatmap.tsx 已接 getHeatmapMessages，本 widget 未接）。
  const heatmapMessages = useMemo(() => getHeatmapMessages(language), [language])
  // 完整 7 行 weekday 标签（周一~周日）
  const weekdayLabels = useMemo(
    () =>
      Array.from({ length: 7 }).map((_, i) =>
        weekdayLabel(i, FIRST_DOW, calendarMessages.weekdayShort),
      ),
    [calendarMessages],
  )

  // 月份标签：windowStart / windowEnd 所在月份短标签由 i18n 模板自己
  // 拼装（periodLabelTemplate 内部决定 startMonth === endMonth 时是否
  // 合并显示），这里只负责传 raw 数字进去。

  // period / sub 文案走 i18n 模板，避免硬编码「近三月 · 」、「· 连续 」等分隔符。
  const periodLabel = heatmapMessages.periodLabelTemplate({
    startMonth: windowStart.getMonth() + 1,
    endMonth: windowEnd.getMonth() + 1,
  })
  const sub = heatmapMessages.subTemplate({
    total: heatmap.totalCount,
    activeDays: heatmap.activeDays,
    streak: heatmap.currentStreak,
    avgPerDay: heatmap.avgPerDay.toFixed(1),
  })

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

          {/* cells 网格：每列代表周，每行代表周一~周日
              R37 修复 (high a11y)：原版用 role=grid/row/gridcell 但 cells 不可
              focus / 不可点击 —— SR 宣告完整 grid 结构但键盘无任何 cell 可达，
              隐式承诺的交互性破坏。改为纯展示列表：父容器 role="list"，
              每个 cell role="listitem" + aria-label，单 cell 不再做 gridcell。 */}
          <div className="dashboard-heatmap-grid" role="list" aria-label="近期活动单元格">
            {heatmap.weeks.map((week, colIdx) => (
              <div
                key={colIdx}
                className="dashboard-heatmap-col"
                role="presentation"
              >
                {week.days.map((day: HeatmapDay, dayIdx) => (
                  <div
                    key={`${colIdx}-${dayIdx}-${day.date}`}
                    className={`dashboard-heatmap-cell level-${day.level} ${day.inRange ? '' : 'out-of-range'} ${day.isToday ? 'is-today' : ''}`}
                    title={`${day.date}：${day.count} 次`}
                    role="listitem"
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
        <span aria-hidden>{heatmapMessages.lessLabel}</span>
        {/*
          R36 修复 (medium a11y)：原版在外层套 `aria-hidden=true`、又在内层 5
          个 span 挂 `aria-label="level N"`。aria-label 在 aria-hidden 子树内
          时多数 SR 直接跳过，导致色块完全没声音反馈 —— 视障用户听到「少 □□□□□
          多」但中间 5 块是哑的。改为：外层不再 aria-hidden，让色块的 aria-label
          能被 SR 读出；同时把 level 翻译成量化描述（与 HeatmapCell.data-count
          同语义），给 SR 用户「活动 0 次 / 1-3 次起 / …」式的可听反馈。
          「少 / 多」两端用 aria-hidden 因为它们是无障碍标签文本（每个色块的
          aria-label 已经自含量级），避免重复念出。
        */}
        <span className="dashboard-heatmap-legend-cells" role="list" aria-label="活动量图例">
          {[0, 1, 2, 3, 4].map((lvl) => (
            <span
              key={lvl}
              className={`dashboard-heatmap-legend-cell level-${lvl}`}
              role="listitem"
              aria-label={heatmapMessages.legendLabels[lvl]}
            />
          ))}
        </span>
        <span aria-hidden>{heatmapMessages.moreLabel}</span>
      </div>
    </div>
  )
}

export default HeatmapWidget