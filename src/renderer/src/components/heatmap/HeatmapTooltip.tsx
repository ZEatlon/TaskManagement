/**
 * 热力图悬浮提示
 *
 * 鼠标悬浮单元格时，显示：
 * - 日期（中文，含星期）
 * - 相对时间（今天 / 昨天 / X 天前 / 未来）
 * - 任务完成数（可选）
 * - 笔记事件数（可选）
 *
 * 位置由父组件根据鼠标/单元格位置计算后传入。
 */
import { useEffect, useState } from 'react'
import { fromISODate } from './heatmapData'

export interface HeatmapTooltipPayload {
  date: string // YYYY-MM-DD
  taskCount?: number
  noteCount?: number
  /** 是否为今天（用于决定日期后缀） */
  isToday?: boolean
}

interface HeatmapTooltipProps {
  payload: HeatmapTooltipPayload | null
  /** 锚点 DOM 元素，tooltip 会在其上方显示 */
  anchor: HTMLElement | null
}

const TOOLTIP_OFFSET = 10

/** 一天的毫秒数（用 86_400_000） */
const ONE_DAY_MS = 86_400_000

/** 把日期格式化为"今天 / 昨天 / X 天前 / 未来"等 */
function relativeLabel(date: Date): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diff = Math.round((target.getTime() - today.getTime()) / ONE_DAY_MS)
  if (diff === 0) return '今天'
  if (diff === -1) return '昨天'
  if (diff === 1) return '明天'
  if (diff > 1 && diff <= 14) return `${diff} 天后`
  if (diff < -1 && diff >= -14) return `${Math.abs(diff)} 天前`
  return ''
}

export function HeatmapTooltip({ payload, anchor }: HeatmapTooltipProps) {
  // 位置：基于锚点元素 bounding rect
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null)

  useEffect(() => {
    if (!anchor || !payload) {
      setPos(null)
      return
    }
    let rafId = 0
    const schedule = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        const rect = anchor.getBoundingClientRect()
        const top = rect.top - TOOLTIP_OFFSET
        const flipTop = top < 8
        setPos({
          left: rect.left + rect.width / 2,
          top: flipTop ? rect.bottom + TOOLTIP_OFFSET : top,
          below: flipTop,
        })
      })
    }
    // R13 修复 (medium)：scroll/resize 高频事件，原本每像素都 setState
    // 触发重渲染。改用 requestAnimationFrame 合并——一个动画帧内只触发
    // 一次状态更新，最多 ~60Hz，CPU 占用降到原来的 1/N。
    schedule()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [anchor, payload])

  if (!payload || !pos) return null

  const date = fromISODate(payload.date)
  const formatted = date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
  const rel = relativeLabel(date)
  const total = (payload.taskCount ?? 0) + (payload.noteCount ?? 0)

  return (
    // R32-A11yPerf-7 修复 (MEDIUM dangling-aria-describedby)：原版 role="tooltip"
    // 但没有 id，HeatmapCell 也没有 aria-describedby 引用任何 tooltip id。
    // a11y 工具（如 axe / Lighthouse）扫描到「role=tooltip 但无任何引用」
    // 会标记 dangling reference 警告。修复：给 tooltip 一个稳定 id
    // （`heatmap-tooltip`），同时当 payload 存在时挂上 id、不存在时不挂
    // id（避免 DOM 中存在一个空 role=tooltip 的悬浮元素）。当前 cell
    // 仍是 aria-hidden 不直接用 aria-describedby，但 id 已稳定，未来
    // 摘要行加 aria-describedby="heatmap-tooltip" 即可对接，无需再改
    // tooltip。
    <div
      id={payload ? 'heatmap-tooltip' : undefined}
      className={`heatmap-tooltip ${pos.below ? 'is-below' : 'is-above'}`}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        transform: pos.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }}
      role="tooltip"
    >
      <div className="heatmap-tooltip-date">
        {formatted}
        {rel && <span className="heatmap-tooltip-rel"> · {rel}</span>}
      </div>
      {typeof payload.taskCount === 'number' && (
        <div className="heatmap-tooltip-row">
          <span className="heatmap-tooltip-dot heat-dot-task" />
          <span>
            <strong>{payload.taskCount}</strong> 个任务完成
          </span>
        </div>
      )}
      {typeof payload.noteCount === 'number' && payload.noteCount > 0 && (
        <div className="heatmap-tooltip-row">
          <span className="heatmap-tooltip-dot heat-dot-note" />
          <span>
            <strong>{payload.noteCount}</strong> 个笔记事件
          </span>
        </div>
      )}
      {total === 0 && (
        <div className="heatmap-tooltip-row muted">无活动</div>
      )}
    </div>
  )
}