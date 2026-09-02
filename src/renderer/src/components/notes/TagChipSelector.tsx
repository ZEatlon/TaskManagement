/**
 * 笔记顶部固定 chip 选择器
 *
 * - 显示 N 个常用 tag（默认取 useTagsStore 前 6 个，未配置则显示全部）
 * - 点击 → toggle 当前笔记的 tag（与 NoteMetaPanel.persistTags 走相同的 store.save 路径）
 * - 不做 CRUD：增删改走 TagsSidebar
 *
 * 行为契约：
 *   - 当前笔记切换时（noteId prop 变化）重新读取 currentNote.tags 同步本地态
 *   - 点击 chip 调 useNotesStore.updateNote({ id, tags })（如果该方法存在）；
 *     否则调 save(path, content, { tags: next }) 走 NoteMetaPanel 的同一条 IPC。
 *     这条「双源一致性」是计划里强调的风险点 —— 任何变更必须落到同一路径。
 */
import { useEffect, useState } from 'react'
import { useTagsStore } from '../../stores/tags'
import { useNotesStore } from '../../stores/notes'

interface Props {
  noteId: string
  /** 最多显示的 chip 数，默认 6 */
  maxChips?: number
}

export function TagChipSelector({ noteId, maxChips = 6 }: Props): JSX.Element | null {
  const tags = useTagsStore((s) => s.tags)
  const currentNote = useNotesStore((s) => s.currentNote)
  const draftContent = useNotesStore((s) => s.draftContent)
  const save = useNotesStore((s) => s.save)
  const [active, setActive] = useState<Set<string>>(new Set())

  // 切换 noteId 时同步当前笔记的 tag 到本地 Set
  useEffect(() => {
    if (!currentNote || currentNote.id !== noteId) return
    setActive(new Set(currentNote.tags))
  }, [currentNote, noteId])

  if (tags.length === 0) return null

  const visible = tags.slice(0, maxChips)

  async function toggle(tagName: string) {
    if (!currentNote) return
    const next = new Set(active)
    if (next.has(tagName)) {
      next.delete(tagName)
    } else {
      next.add(tagName)
    }
    setActive(next)
    const arr = Array.from(next)
    // 走 NoteMetaPanel 同一条 persistTags 路径：
    //   用 draftContent（TipTap 实时编辑）作为权威正文，避免 autosave 窗口内丢字。
    const baseContent =
      draftContent !== null && draftContent !== undefined
        ? draftContent
        : currentNote.content
    try {
      await save(currentNote.path, baseContent, { tags: arr })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[tag-chip] toggle failed', err)
      // 失败回滚
      setActive(active)
    }
  }

  return (
    <div className="tag-chip-selector" role="group" aria-label="标签选择">
      {visible.map((t) => {
        const isActive = active.has(t.name)
        return (
          <button
            key={t.id}
            type="button"
            className={`tag-chip-btn ${isActive ? 'active' : ''}`}
            onClick={() => void toggle(t.name)}
            aria-pressed={isActive}
            aria-label={`${isActive ? '取消' : '添加'}标签 ${t.name}`}
            title={`${isActive ? '取消' : '添加'} #${t.name}`}
          >
            #{t.name}
          </button>
        )
      })}
      {tags.length > maxChips && (
        <span className="tag-chip-overflow muted small">+{tags.length - maxChips}</span>
      )}
    </div>
  )
}

export default TagChipSelector