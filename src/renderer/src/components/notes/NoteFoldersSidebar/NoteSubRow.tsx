/**
 * W2-A③ NoteFoldersSidebar 拆分 —— 二级笔记行（叶子节点）
 *
 * 显示标题 + 修改时间 + 删除按钮，点击切到当前笔记。
 *
 * React.memo 自定义 comparator：
 *   - note 引用不变 + handler 引用不变 → 跳过重渲染
 *   - 选中态（isSelected）已下沉到本组件内 `useNotesStore((s) => s.currentPath === note.path)` 订阅：
 *     只有「自己变成/脱离选中」那一行 re-render，不再把 currentPath 沿 FolderWithNotes 整树透传。
 *   - onOpen/onDelete 由父级 useCallback 稳定（NotesTree 已包）。
 */
import { memo } from 'react'
import { useNotesStore } from '../../../stores/notes'
import type { NoteMeta } from '@shared/types'

function fmtMtime(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  } catch {
    return ''
  }
}

export const NoteSubRow = memo(
  function NoteSubRow({
    note,
    onOpen,
    onDelete,
  }: {
    note: NoteMeta
    onOpen?: (n: NoteMeta) => void
    onDelete?: (n: NoteMeta) => void
  }) {
    const isSelected = useNotesStore((s) => s.currentPath === note.path)
    return (
      <li className={`folder-child-row ${isSelected ? 'active' : ''}`}>
        <button
          type="button"
          className="folder-child-btn"
          onClick={() => onOpen?.(note)}
          aria-current={isSelected ? 'page' : undefined}
          title={note.path}
        >
          <span className="folder-child-title">{note.title}</span>
          <span className="folder-child-time muted">{fmtMtime(note.mtime)}</span>
        </button>
        {onDelete && (
          <button
            type="button"
            className="folder-child-del-btn"
            title="删除"
            aria-label={`删除笔记 ${note.title}`}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(note)
            }}
          >
            ×
          </button>
        )}
      </li>
    )
  },
  // 浅比较 comparator：note 引用 + handler 引用必须相同才跳过重渲染。
  (prev, next) =>
    prev.note === next.note &&
    prev.onOpen === next.onOpen &&
    prev.onDelete === next.onDelete,
)
