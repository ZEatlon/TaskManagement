/**
 * 热力图单格组件
 *
 * 渲染一个小方块，颜色档位 0~4 对应 5 档背景色。
 * "今天" 单元格额外加 is-today 类（强调描边 + 脉冲动画）。
 * 鼠标悬浮时高亮 + 显示 tooltip（由父组件控制定位）。
 */
import { memo } from 'react'
import type { HeatmapDay } from './heatmapData'

interface HeatmapCellProps {
  day: HeatmapDay
  /** 悬浮时回调（用于父组件定位 tooltip） */
  onHover?: (day: HeatmapDay, target: HTMLElement) => void
  /** 离开回调 */
  onLeave?: () => void
  /** 点击回调 */
  onClick?: (day: HeatmapDay) => void
  /**
   * R30-a11y-2：是否启用键盘可达性。默认 true —— 每个 in-range cell 是
   * role=button + tabIndex=0 + aria-label，键盘用户可 Tab 进入并 Enter/Space
   * 触发 onClick（钻取该天的笔记）。这会形成约 365 个 tab stop，是 a11y 与
   * 「避免 tab 陷阱」之间的折中。调用方若坚持 R21 的「presentation + 摘要行」
   * 方案，可显式传 `keyboardAccessible={false}` 退回旧行为。
   */
  keyboardAccessible?: boolean
}

function HeatmapCellInner({
  day,
  onHover,
  onLeave,
  onClick,
  keyboardAccessible = true,
}: HeatmapCellProps) {
  const className = [
    'heatmap-cell',
    `level-${day.level}`,
    day.inRange ? 'in-range' : 'out-of-range',
    day.isToday ? 'is-today' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // R30-a11y-2 修复 (high a11y)：原版 cell 是 role=presentation + aria-hidden=true，
  // 但 onClick 仍然绑了鼠标点击 —— 键盘 / SR 用户既看不到、也无法激活
  // 这个钻取交互。Heatmap.tsx 之前承诺的「摘要行」实际上没有 per-day 键盘
  // affordance（只有 sr-only role=img 的整体摘要），drill-down 对非鼠标
  // 用户完全不可达。
  //
  // 修复：当 keyboardAccessible=true（默认）且 day.inRange 时，cell 升级为
  // role=button + tabIndex=0 + aria-label，键盘 Enter/Space 触发 onClick。
  // 调用方若要继续走 R21 的「presentation + 摘要行」路径，传
  // keyboardAccessible={false} 即可。
  //
  // out-of-range cell 保持 aria-hidden（语义上不在范围内），无键盘交互。
  const isInteractive = keyboardAccessible && day.inRange && !!onClick
  const handleActivate = () => {
    if (day.inRange) onClick?.(day)
  }
  return (
    <div
      className={className}
      role={isInteractive ? 'button' : 'presentation'}
      aria-hidden={isInteractive ? undefined : 'true'}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={
        isInteractive
          ? `${day.date}${day.count > 0 ? `，${day.count} 项` : '，无记录'}`
          : undefined
      }
      data-date={day.date}
      data-count={day.count}
      onMouseEnter={(e) => onHover?.(day, e.currentTarget)}
      onMouseLeave={() => onLeave?.()}
      onClick={handleActivate}
      onKeyDown={(e) => {
        if (!isInteractive) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleActivate()
        }
      }}
    />
  )
}

export const HeatmapCell = memo(HeatmapCellInner)