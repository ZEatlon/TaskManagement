/**
 * 番茄钟面板（兼容封装版）
 *
 * 原 Phase 6 单面板版本已拆分为两个独立 widget：
 *   - [PomodoroCalendarPanel](PomodoroCalendarPanel.tsx) —— 日期 / 目标 / 日历
 *   - [PomodoroTimerPanel](PomodoroTimerPanel.tsx) —— 便签 / 计时 / 控制 / 完成列表
 *
 * 该文件保留用于兼容可能仍在引用 `PomodoroPanel` 的位置（如旧路由 / 测试）。
 * 默认 Dashboard 推荐直接使用两个 widget 单独摆放，以获得更好的布局自由度。
 */
import { PomodoroCalendarPanel } from './PomodoroCalendarPanel'
import { PomodoroTimerPanel } from './PomodoroTimerPanel'

interface Props {
  embedded?: boolean
}

export function PomodoroPanel({ embedded = true }: Props) {
  return (
    <>
      <PomodoroCalendarPanel embedded={embedded} />
      <PomodoroTimerPanel embedded={embedded} />
    </>
  )
}

export default PomodoroPanel