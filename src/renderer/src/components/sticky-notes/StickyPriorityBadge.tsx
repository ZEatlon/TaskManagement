/**
 * 便签优先级徽章 —— 可点击切换优先级
 *
 * 复用与 PriorityBadge 相同的颜色 token，但形态是 pill + 内嵌 select，
 * 让用户可以直接在便签卡上调整优先级，无需打开编辑器。
 */
import { useCallback } from 'react'
import type { Priority } from '@shared/types'

const META: Record<Priority, { label: string; emoji: string }> = {
  p0: { label: 'P0 紧急', emoji: '🔥' },
  p1: { label: 'P1 高', emoji: '★' },
  p2: { label: 'P2 中', emoji: '●' },
  p3: { label: 'P3 低', emoji: '○' },
}

interface Props {
  priority: Priority
  onChange?: (next: Priority) => void
}

export function StickyPriorityBadge({ priority, onChange }: Props) {
  const m = META[priority]

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!onChange) return
      onChange(e.target.value as Priority)
    },
    [onChange],
  )

  return (
    <span
      className={`sticky-priority-badge priority-${priority}`}
      title="点击切换优先级"
    >
      {onChange ? (
        <select
          value={priority}
          onChange={handleChange}
          aria-label="切换优先级"
        >
          {(Object.keys(META) as Priority[]).map((p) => (
            <option key={p} value={p}>
              {META[p].label}
            </option>
          ))}
        </select>
      ) : (
        <>
          <span aria-hidden>{m.emoji}</span>
          <span>{m.label}</span>
        </>
      )}
    </span>
  )
}