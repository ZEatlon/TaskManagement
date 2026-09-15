/**
 * 便签优先级徽章 —— 可点击切换优先级
 *
 * 复用与 PriorityBadge 相同的颜色 token，但形态是 pill + 内嵌 select，
 * 让用户可以直接在便签卡上调整优先级，无需打开编辑器。
 */
import { useCallback } from 'react'
import type { Priority } from '@shared/types'
import { PRIORITY_LABEL } from '@shared/lib/priorities'

/**
 * R36 修复 (medium a11y)：emoji 仍按调用方偏好（badge 用 pill+emoji），
 * 但语义 label 与 QuickCaptureOverlay 共享 @shared/lib/priorities 的
 * PRIORITY_LABEL 单一来源，避免 SR 念出"P zero"。
 */
const EMOJI: Record<Priority, string> = {
  p0: '🔥',
  p1: '★',
  p2: '●',
  p3: '○',
}

interface Props {
  priority: Priority
  onChange?: (next: Priority) => void
}

export function StickyPriorityBadge({ priority, onChange }: Props) {
  const label = PRIORITY_LABEL[priority]

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
          {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      ) : (
        <>
          <span aria-hidden>{EMOJI[priority]}</span>
          <span>{label}</span>
        </>
      )}
    </span>
  )
}