/**
 * 番茄钟大字号倒计时显示
 * - 圆形进度环（SVG circle stroke-dasharray）
 * - 巨字 mm:ss
 * - 模式标签 + 当前周期
 */
import { useMemo } from 'react'
import type { PomodoroConfig, PomodoroMode, PomodoroState } from '@shared/ipc/channels'
// UI 清理 (no-motion)：删除所有瞬时脉冲（is-done / mode-changed 的 700ms setTimeout），
// 模式切换 / 倒计时归零时不再触发任何 class 动画。计时器 / 进度环的数值过渡
// （stroke-dashoffset 0.4s linear）保留 —— 这是功能性反馈，不是装饰。

interface Props {
  state: PomodoroState
  /** 配置 —— 用于「第 N / cycleCount 个专注」分母；缺省时退回 4。 */
  config?: PomodoroConfig
  /** 圆形直径 */
  size?: number
  /** 描边宽度 */
  stroke?: number
}

const MODE_LABEL: Record<PomodoroMode, string> = {
  focus: '专注',
  shortBreak: '短休',
  longBreak: '长休',
}

/** 把秒数格式化为 mm:ss */
function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

const MODE_COLOR: Record<PomodoroMode, string> = {
  focus: 'var(--danger)',
  shortBreak: 'var(--success)',
  longBreak: 'var(--accent)',
}

export function TimerDisplay({ state, config, size = 320, stroke = 10 }: Props) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  // 已完成进度 = elapsedSec / totalSec
  const progress = state.totalSec > 0 ? state.elapsedSec / state.totalSec : 0
  const dashOffset = useMemo(
    () => circumference * (1 - Math.min(1, Math.max(0, progress))),
    [circumference, progress],
  )

  const color = MODE_COLOR[state.mode]
  const modeLabel = MODE_LABEL[state.mode]

  const displayClasses = ['timer-display', state.running ? 'is-running' : '']
    .filter(Boolean)
    .join(' ')

  const timeClass = 'timer-time'

  return (
    <div className={displayClasses} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="timer-ring">
        {/* 背景环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
        />
        {/* 进度环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.4s linear' }}
        />
      </svg>
      <div className="timer-content">
        <div className="timer-mode" style={{ color }}>
          {modeLabel}
          {state.running && <span className="timer-dot">●</span>}
        </div>
        <div className={timeClass} role="timer" aria-live="off" aria-atomic="true">
          {fmt(state.remainingSec)}
        </div>
        <div className="timer-cycle muted">
          第 {state.cycleIndex + 1} / {Math.max(1, config?.cycleCount ?? 4)} 个专注
        </div>
      </div>
    </div>
  )
}
