/**
 * 热力图图例（简化版）
 *
 * 仅显示「少 → 多」+ 5 档色块，无阈值标注（参考描述里的样式）。
 * 整体靠右放置，由父容器 .heatmap-footer 的 space-between 控制。
 *
 * 视觉：
 * - 「少」↔ [▢▣▣▣▣] ↔「多」
 * - 每个色块之间 3px 间距，使用 .legend-* 类避免与 .heatmap-cell 样式冲突。
 */
import { memo } from 'react'
import type { HeatmapLevel } from './heatmapData'

interface HeatmapLegendProps {
  /** 当前区间的最大 count（保留以备未来扩展，例如 tooltip 显示当前区间范围） */
  max: number
}

const LEVELS: HeatmapLevel[] = [0, 1, 2, 3, 4]

function HeatmapLegendInner({ max: _max }: HeatmapLegendProps) {
  return (
    <div className="heatmap-legend">
      <span className="legend-label">少</span>
      <div className="legend-cells">
        {LEVELS.map((lv) => (
          <span key={lv} className={`legend-cell level-${lv}`} aria-hidden />
        ))}
      </div>
      <span className="legend-label">多</span>
    </div>
  )
}

export const HeatmapLegend = memo(HeatmapLegendInner)