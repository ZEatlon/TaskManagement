/**
 * Clock 页面 shell —— 双栏布局 + 底部日历
 *
 * 设计：
 *   - 顶栏（左）：PhaseCard —— 大型计时器 + 控制（来自原 PomodoroTimerPanel）
 *   - 顶栏（右）：侧边栏 —— QuickSettings + 占位的「休息建议」卡
 *     （W2-B 接入 AI daemon 后会变成真正的「AI 主动提醒 + chat 入口」）
 *   - 中部：TodayStrip —— 今日完成番茄 + 月度统计单行
 *   - 底部：月历面板（来自原 PomodoroCalendarPanel）
 *
 * 为什么不直接复用 PomodoroPanel：
 *   - 原 PomodoroPanel 嵌在 Dashboard 多 widget 里，header 里有 greeting 之类
 *   - Clock 页是「专注番茄」的纯形态，没有 greeting / AI insight / 近期笔记
 *     等干扰元素 —— 用户进入就只看时间和控制
 */
import type { ReactNode } from 'react'
import { PomodoroTimerPanel } from '../pomodoro/PomodoroTimerPanel'
import { PomodoroCalendarPanel } from '../pomodoro/PomodoroCalendarPanel'
import { PomodoroQuickSettings } from '../pomodoro/PomodoroQuickSettings'
import { TodayPomodoros } from '../pomodoro/TodayPomodoros'
import { MonthStats } from '../pomodoro/MonthStats'
import { BreakSuggestion } from './BreakSuggestion'

interface Props {
  /** 测试 / Storybook 注入：右侧栏自定义内容 */
  asideSlot?: ReactNode
}

export function ClockShell({ asideSlot }: Props = {}) {
  return (
    <div className="clock-shell">
      <div className="clock-shell__top">
        <section className="clock-shell__phase" aria-label="番茄计时">
          <PomodoroTimerPanel />
        </section>
        <aside className="clock-shell__aside" aria-label="设置与休息建议">
          <PomodoroQuickSettings />
          {asideSlot ?? <BreakSuggestion />}
        </aside>
      </div>

      <section className="clock-shell__strip" aria-label="今日与本月统计">
        <TodayPomodoros />
        <MonthStats />
      </section>

      <section className="clock-shell__calendar" aria-label="月历">
        <PomodoroCalendarPanel />
      </section>
    </div>
  )
}
