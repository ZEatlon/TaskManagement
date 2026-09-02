/**
 * 番茄钟日历面板（Dashboard 嵌入版）
 *
 * 拆分自原 PomodoroPanel 的上半部分：日期标题 + 今日目标环 + 月历视图。
 * 单独作为 Dashboard 的一个 widget，可独立摆放。
 *
 * - viewDate 状态在 panel 内自管，不与 TimerPanel 共享。
 * - v3 起日历不再展示番茄钟数据，只展示截止便签；订阅最小化：
 *   仅取 loaded 用于初次挂载 loading 兜底，run 状态由 store 自然驱动。
 */
import { memo, useCallback, useState } from 'react'
import { usePomodoroStore } from '../../stores/pomodoro'
import { FocusDateHeader } from './FocusDateHeader'
import { FocusCalendar } from './FocusCalendar'
import { DailyGoalRing } from './DailyGoalRing'

interface Props {
  /** 嵌入态：true 时走卡片化样式（去除独立外框） */
  embedded?: boolean
}

const MemoFocusDateHeader = memo(FocusDateHeader)
const MemoFocusCalendar = memo(FocusCalendar)
const MemoDailyGoalRing = memo(DailyGoalRing)

export function PomodoroCalendarPanel({ embedded = true }: Props) {
  const loaded = usePomodoroStore((s) => s.loaded)

  const [viewDate, setViewDate] = useState(() => new Date())

  const handlePrevMonth = useCallback(() => {
    const d = new Date(viewDate)
    d.setMonth(d.getMonth() - 1)
    setViewDate(d)
  }, [viewDate])

  const handleNextMonth = useCallback(() => {
    const d = new Date(viewDate)
    d.setMonth(d.getMonth() + 1)
    setViewDate(d)
  }, [viewDate])

  if (!loaded) {
    return (
      <div className={`pomodoro-calendar-panel ${embedded ? 'is-embedded' : ''}`}>
        <div className="empty-tip muted">加载中…</div>
      </div>
    )
  }

  return (
    <div className={`pomodoro-calendar-panel ${embedded ? 'is-embedded' : ''}`}>
      <div className="pomodoro-calendar-top">
        <MemoFocusDateHeader
          date={viewDate}
          onChangeDate={setViewDate}
        />
        <MemoDailyGoalRing />
      </div>
      <div className="pomodoro-calendar-grid">
        <MemoFocusCalendar
          viewMonth={viewDate}
          onPrevMonth={handlePrevMonth}
          onNextMonth={handleNextMonth}
          onSelectDate={setViewDate}
          selectedDate={viewDate}
        />
      </div>
    </div>
  )
}

export default PomodoroCalendarPanel
