/**
 * Dashboard 组件统一导出（Phase 6+）
 */
export { GreetingCard } from './GreetingCard'
export { TodaySummary } from './TodaySummary'
export type { TodayStats } from './TodaySummary'
export { StatsCards } from './StatsCards'
export type { StickyStatusBreakdown } from './StatsCards'
export { QuickActions } from './QuickActions'
export { HeatmapWidget } from './HeatmapWidget'
export { RecentNotes } from './RecentNotes'
export { UpcomingStickies, UpcomingTasks } from './UpcomingStickies'
export { DashboardEditorModal } from './DashboardEditorModal'
export type {
  DashboardLayout,
  DashboardWidgetKey,
} from './DashboardEditorModal'
export {
  DEFAULT_LAYOUT,
  WIDGET_LABELS,
} from './DashboardEditorModal'
export { useDashboardLayout } from './useDashboardLayout'