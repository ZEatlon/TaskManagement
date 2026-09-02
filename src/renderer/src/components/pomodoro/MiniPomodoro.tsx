/**
 * 顶栏迷你番茄钟
 * - 右侧小圆形进度环 + 剩余时间
 * - 单击跳转到 /pomodoro
 *
 * 订阅：分两片选 — `timer`（每秒变化）/ `control`（低频），
 * 避免单一 `s.state` 引用导致每秒整组组件树重渲染。
 */
import { useNavigate } from '@tanstack/react-router'
import { usePomodoroStore } from '../../stores/pomodoro'

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function MiniPomodoro() {
  const navigate = useNavigate()
  // 分片订阅
  const remainingSec = usePomodoroStore((s) => s.timer.remainingSec)
  const elapsedSec = usePomodoroStore((s) => s.timer.elapsedSec)
  const totalSec = usePomodoroStore((s) => s.control.totalSec)
  const mode = usePomodoroStore((s) => s.control.mode)
  const running = usePomodoroStore((s) => s.control.running)

  const size = 36
  const stroke = 3
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const progress = totalSec > 0 ? elapsedSec / totalSec : 0
  const dashOffset = circumference * (1 - Math.min(1, Math.max(0, progress)))

  const color =
    mode === 'focus'
      ? 'var(--danger)'
      : mode === 'longBreak'
      ? 'var(--accent)'
      : 'var(--success)'

  const modeLabel =
    mode === 'focus' ? '专注' : mode === 'shortBreak' ? '短休' : '长休'

  return (
    <button
      className="mini-pomodoro"
      onClick={() => navigate({ to: '/' })}
      title={`${modeLabel} ${fmt(remainingSec)}`}
      // R14 修复 (medium)：title 仅鼠标可见；SR 用户需要 aria-label。
      // 加 running/paused 状态让 SR 用户能区分当前阶段。
      aria-label={`番茄计时器：${modeLabel}，剩余 ${fmt(remainingSec)}${running ? '，运行中' : '，已暂停'}`}
    >
      <svg width={size} height={size} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
        />
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
      <span className="mini-pomodoro-time">{fmt(remainingSec)}</span>
      {running && <span className="mini-pomodoro-dot" aria-hidden="true" />}
    </button>
  )
}