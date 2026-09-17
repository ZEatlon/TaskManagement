/**
 * Clock 路由 —— 番茄钟 / 定时提醒 / AI 虚拟助手的统一入口
 *
 * 这里是 W1-C 的脚手架版本（无 AI daemon），仅包含：
 *   - PomodoroTimerPanel（计时 + 控制）
 *   - PomodoroQuickSettings（设置）
 *   - PomodoroCalendarPanel（月历）
 *   - TodayPomodoros + MonthStats（今日 / 本月统计）
 *   - BreakSuggestion（占位的休息建议；W2-B 接入 AI daemon 后会变成
 *     「AI 主动推送的 hint + 拉起 chat 的入口」）
 *
 * 设计意图：Clock 是 Dashboard 之后的「新入口」页。Dashboard 之后会被
 * 删（W3-A），所有 Pomodoro 用户从这个 /clock 路径进来。
 */
import { ClockShell } from '../components/clock/ClockShell'

export function ClockRoute(): React.JSX.Element {
  return <ClockShell />
}
