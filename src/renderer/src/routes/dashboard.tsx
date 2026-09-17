/**
 * Dashboard 主页（v6 · 硬编码默认布局 / 无编辑入口）
 *
 * Round 6 重构（精简）：
 *   - 问候卡片（GreetingCard）+ 快捷操作（QuickActions）已从 widget 注册表里移除，
 *     作为顶部固定 chrome 始终渲染，不参与布局。
 *   - W2-C① 进一步移除 Dashboard Editor：3 栏默认布局硬编码到本文件，
 *     不再允许拖动 / 隐藏 / 切换列数。用户即将看到的就是「默认布局」。
 *   - W3-A 还会把 Dashboard 整页连同 dashboard.css 一起删除 —— Clock 页是
 *     新的入口。本文件保留作为过渡期的临时视图。
 *
 * 数据模型（仅展示用）：
 *   - `columns: DashboardWidgetKey[][]`
 *   - 不写 localStorage；不响应用户编辑。
 *
 * 编辑入口已下线：esc / 拖动 / 眼睛图标 / 预设按钮 / 添加列按钮 —— 全部移除。
 */
import { useEffect, useMemo } from 'react'
import type { StickyNote, StickyNoteUpdate, StickyNoteStepPatch } from '@shared/types'
import { GreetingCard } from '../components/dashboard/GreetingCard'
import { TodaySummary } from '../components/dashboard/TodaySummary'
import { StatsCards } from '../components/dashboard/StatsCards'
import { aggregateStickies } from '../lib/stickyAggregates'
import { QuickActions } from '../components/dashboard/QuickActions'
import { HeatmapWidget } from '../components/dashboard/HeatmapWidget'
import { RecentNotes } from '../components/dashboard/RecentNotes'
import { AIInsightCard } from '../components/dashboard/AIInsightCard'
import { UpcomingStickies } from '../components/dashboard/UpcomingStickies'
import { PomodoroCalendarPanel } from '../components/pomodoro/PomodoroCalendarPanel'
import { PomodoroTimerPanel } from '../components/pomodoro/PomodoroTimerPanel'
import { useStickyNotesStore } from '../stores/stickyNotes'
import { useNotesStore } from '../stores/notes'
import { useTodayKey } from '../lib/useDayRollover'

/** widget 注册表 key（与 DashboardEditorModal 中保持一致，仅本文件引用） */
type DashboardWidgetKey =
  | 'todaySummary'
  | 'statsCards'
  | 'pomodoroCalendar'
  | 'pomodoroTimer'
  | 'heatmap'
  | 'upcoming'
  | 'recentNotes'
  | 'aiInsight'

/** 3 栏默认布局（硬编码；原本来自 DashboardEditorModal.DEFAULT_LAYOUT）。
 *  W3-A 删 Dashboard 时本常量一并消失 —— 临时过渡用。 */
const DEFAULT_LAYOUT: { columns: DashboardWidgetKey[][] } = {
  columns: [
    ['todaySummary', 'statsCards'],
    ['pomodoroCalendar', 'pomodoroTimer', 'aiInsight'],
    ['heatmap', 'upcoming', 'recentNotes'],
  ],
}

/**
 * R-fix-dashboard-handlers-stability (perf, high)：
 * UpcomingStickies 把每个 handler 透传到内部 memo 化的 StickyNoteCard。
 * handler 提到 module 顶层（闭包里只用了 useStickyNotesStore.getState()，
 * store action 引用与状态都稳定，不需要 React 调度感知）。
 */
const NOOP = () => undefined
const handleUpdateSticky = (id: string, patch: StickyNoteUpdate): void => {
  void useStickyNotesStore.getState().update(id, patch)
}
const handleDeleteSticky = (id: string): void => {
  void useStickyNotesStore.getState().remove(id)
}
const handleAddStep = (noteId: string, content: string): void => {
  void useStickyNotesStore.getState().addStep(noteId, content)
}
const handleUpdateStep = (noteId: string, stepId: string, patch: StickyNoteStepPatch): void => {
  void useStickyNotesStore.getState().updateStep(noteId, stepId, patch)
}
const handleRemoveStep = (noteId: string, stepId: string): void => {
  void useStickyNotesStore.getState().removeStep(noteId, stepId)
}

export function DashboardRoute() {
  // 数据：便签 / 笔记
  const loadAllFiltered = useStickyNotesStore((s) => s.loadAllFiltered)
  const byDate = useStickyNotesStore((s) => s.byDate)
  const allStickies = useStickyNotesStore((s) => s.all)
  const stickiesLoading = useStickyNotesStore((s) => s.loading)

  const notesLoaded = useNotesStore((s) => s.notes.length > 0)
  const notesLoading = useNotesStore((s) => s.loading)
  const fetchNotes = useNotesStore((s) => s.fetch)

  const todayKey = useTodayKey()

  useEffect(() => {
    void loadAllFiltered({ archived: false, limit: 500 })
    if (!notesLoaded && !notesLoading) {
      void fetchNotes()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stickies: StickyNote[] = useMemo(() => {
    if (allStickies && allStickies.length > 0) return allStickies
    return Object.values(byDate).flat()
  }, [byDate, allStickies])

  const { todayStats, breakdown } = useMemo(
    () => aggregateStickies(stickies, todayKey),
    [stickies, todayKey],
  )

  // ===== widget → 组件 映射 =====
  const renderWidget = (key: DashboardWidgetKey): JSX.Element | null => {
    switch (key) {
      case 'todaySummary':
        return <TodaySummary stickies={stickies} todayStats={todayStats} />
      case 'statsCards':
        return <StatsCards stickies={stickies} breakdown={breakdown} />
      case 'pomodoroCalendar':
        return <PomodoroCalendarPanel embedded />
      case 'pomodoroTimer':
        return <PomodoroTimerPanel />
      case 'heatmap':
        return <HeatmapWidget />
      case 'upcoming':
        return (
          <UpcomingStickies
            stickies={stickies}
            onSelect={NOOP}
            onUpdate={handleUpdateSticky}
            onDelete={handleDeleteSticky}
            onAddStep={handleAddStep}
            onUpdateStep={handleUpdateStep}
            onRemoveStep={handleRemoveStep}
          />
        )
      case 'recentNotes':
        return <RecentNotes />
      case 'aiInsight':
        return <AIInsightCard todayStats={todayStats} />
      default:
        return null
    }
  }

  return (
    <div className="page dashboard-page">
      {/* 顶部固定栏：greeting · quick actions（编辑入口已删除） */}
      <header className="dashboard-topbar" role="banner">
        <div className="dashboard-topbar-greeting">
          <GreetingCard />
        </div>
        <div className="dashboard-topbar-actions">
          <QuickActions />
        </div>
      </header>

      {/* 主体：默认 3 栏布局（硬编码，不响应用户编辑） */}
      <div
        className="dashboard-cols"
        style={{ ['--col-count' as string]: String(DEFAULT_LAYOUT.columns.length) }}
      >
        {DEFAULT_LAYOUT.columns.map((column, ci) => (
          <div key={ci} className="dashboard-col dashboard-col-stack">
            {column.map((key) => (
              <div key={key} className="dashboard-cell">
                <div className="dashboard-cell-body">{renderWidget(key)}</div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 加载提示 */}
      {stickiesLoading && stickies.length === 0 && (
        <div className="dashboard-loading muted small">便签加载中…</div>
      )}
    </div>
  )
}

export default DashboardRoute