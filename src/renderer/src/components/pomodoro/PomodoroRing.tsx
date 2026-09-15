/**
 * 番茄钟进度环 —— 共用 SVG 几何层。
 *
 * 原本 TimerDisplay（大字号圆形）+ MiniPomodoro（顶栏小圆）各自手抄
 * radius / circumference / dashOffset / rotate(-90 ...) / 0.4s linear
 * 过渡。两边任何一处调整动效都会让另一个组件脱节，集中到此组件后
 * 改一处即可。
 *
 * 视觉：
 *   - 背景环：var(--border) 实心描边
 *   - 进度环：color 描边，strokeLinecap=round，从 12 点钟方向开始顺时针
 *   - 进度过渡：stroke-dashoffset 0.4s linear（与旧实现一致 —— 这是
 *     功能性反馈，不是装饰，UI 清理 no-motion 不动它）
 *
 * `aria-hidden` 由调用方按需覆盖（MiniPomodoro 不希望读屏读两次，TimerDisplay
 * 周围已有 role=timer 的语义节点）。
 */
export interface PomodoroRingProps {
  /** 圆形直径 */
  size: number
  /** 描边宽度 */
  stroke: number
  /** 0~1 进度（>1 截到 1，<0 截到 0） */
  progress: number
  /** 进度环颜色（CSS 变量或颜色值） */
  color: string
  /** 背景环颜色，默认 var(--border) */
  trackColor?: string
  /** 额外 CSS 类 —— TimerDisplay 传 `timer-ring` 保留历史样式钩子 */
  className?: string
  /** ARIA 标签，默认 undefined（不输出 aria 属性，调用方决定） */
  'aria-label'?: string
  /** ARIA 隐藏 —— MiniPomodoro 那种装饰性 SVG 设 true */
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function PomodoroRing({
  size,
  stroke,
  progress,
  color,
  trackColor = 'var(--border)',
  className,
  'aria-label': ariaLabel,
  'aria-hidden': ariaHidden,
}: PomodoroRingProps) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, progress))
  const dashOffset = circumference * (1 - clamped)
  const transform = `rotate(-90 ${size / 2} ${size / 2})`

  // 仅在调用方显式提供 aria-label 时输出，避免默认空 label 让 a11y lint 报警
  const ariaProps: { 'aria-label'?: string; 'aria-hidden'?: boolean | 'true' | 'false' } = {}
  if (ariaLabel !== undefined) ariaProps['aria-label'] = ariaLabel
  if (ariaHidden !== undefined) ariaProps['aria-hidden'] = ariaHidden

  return (
    <svg width={size} height={size} className={className ?? 'pomodoro-ring'} {...ariaProps}>
      {/* 背景环 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={trackColor}
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
        transform={transform}
        style={{ transition: 'stroke-dashoffset 0.4s linear' }}
      />
    </svg>
  )
}
