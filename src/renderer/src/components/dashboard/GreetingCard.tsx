/**
 * 顶部紧凑行 —— 时钟 + 问候 + 日期
 *
 * Phase 6 (dashboard-restructure)：从原先的「全宽大卡片 + glow 渐变 + emoji + 浮动动画」
 * 收敛成 Row 1 第三栏的紧凑组件：左侧一句问候 + 日期，右侧静态大字号时钟。
 * 整体风格「静、稳、准」，与今日摘要 / 统计卡片同一高度对齐。
 */
import { useEffect, useState } from 'react'

/** 根据小时数返回问候语 */
function greetingForHour(hour: number): string {
  if (hour < 5) return '夜深了'
  if (hour < 13) return '你好'
  if (hour < 18) return '下午好'
  if (hour < 22) return '晚上好'
  return '夜深了'
}

/** 当前小时对应的图标（emoji） */
function iconForHour(hour: number): string {
  if (hour < 6) return '🌙'
  if (hour < 12) return '☀️'
  if (hour < 18) return '🌤'
  return '🌙'
}

function GreetingClock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // 对齐到整分钟 tick：避免每秒无意义的 setState
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    let intervalId: number | undefined
    const timeoutId = window.setTimeout(() => {
      setNow(new Date())
      intervalId = window.setInterval(() => setNow(new Date()), 60_000)
    }, msToNextMinute)
    return () => {
      window.clearTimeout(timeoutId)
      if (intervalId !== undefined) window.clearInterval(intervalId)
    }
  }, [])

  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')

  return (
    <div className="greeting-clock" role="timer" aria-label={`当前时间 ${hh}:${mm}`}>
      <span className="greeting-clock-time">
        {hh}
        <span className="greeting-clock-colon">:</span>
        {mm}
      </span>
    </div>
  )
}

export function GreetingCard() {
  const [snapshot, setSnapshot] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setSnapshot(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  const hour = snapshot.getHours()
  const greeting = greetingForHour(hour)
  const icon = iconForHour(hour)

  const dateText = snapshot.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })

  return (
    <div className="greeting-card greeting-card-compact">
      <div className="greeting-left">
        <span className="greeting-icon" aria-hidden>{icon}</span>
        <div className="greeting-info">
          <div className="greeting-title">{greeting}</div>
          <div className="greeting-date muted small">{dateText}</div>
        </div>
      </div>
      <GreetingClock />
    </div>
  )
}

export default GreetingCard