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
}

function HeatmapCellInner({ day, onHover, onLeave, onClick }: HeatmapCellProps) {
  const className = [
    'heatmap-cell',
    `level-${day.level}`,
    day.inRange ? 'in-range' : 'out-of-range',
    day.isToday ? 'is-today' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // R21 修复 (high a11y + perf)：原版每个 cell role=button + tabIndex=0，
  // 一年 ≈ 365 个 cell 全在 DOM tab 序列里。键盘用户按 Tab 要按 365 次
  // 才能穿过整个热力图 —— 这不是「可达」，是「无效陷阱」。
  // 修复：
  //   - role=presentation + aria-hidden，把单个 cell 从 a11y tree 移除；
  //   - 用一个「摘要行」（在 Heatmap.tsx 里实现）承担键盘交互；
  //   - 单 cell 保留鼠标 onClick 行为（视觉反馈 + 数据钻取不破坏）；
  //   - 保留 tooltip（onHover / onFocus 仍触发），但 onFocus 已无意义
  //     （非 focusable），移掉避免无效 handler。
  //
  // R21 修复 (high a11y)：原 onClick 只接鼠标点击，role=button 期望键盘
  // 用户能 Enter/Space 激活——但 cell 不再 focusable，键盘交互已迁到摘要行。
  // 这里补 onKeyDown 是「保险」：万一未来切换回 focusable 也能工作。
  return (
    <div
      className={className}
      role="presentation"
      aria-hidden="true"
      data-date={day.date}
      data-count={day.count}
      onMouseEnter={(e) => onHover?.(day, e.currentTarget)}
      onMouseLeave={() => onLeave?.()}
      onClick={() => day.inRange && onClick?.(day)}
    />
  )
}

export const HeatmapCell = memo(HeatmapCellInner)