/**
 * 标签侧边栏
 *
 * - 列出所有自定义 tag（来自 useTagsStore）
 * - inline add / rename / delete
 * - 点击 tag → 通过 setActiveTag 把笔记列表过滤到该 tag（与 NotesTree 现有机制一致）
 * - 「全部标签」按钮清除筛选
 *
 * 跟 useTagsStore 配合：
 *   - tags 创建/重命名/删除走 useTagsStore → tagsApi（IPC 落盘）
 *   - 当前笔记的 tag 仍由 useNotesStore 维护（写在 frontmatter），不在此处同步
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, X, Pencil, Check } from 'lucide-react'
import { useTagsStore } from '../../stores/tags'
import { useNotesStore } from '../../stores/notes'

export function TagsSidebar(): JSX.Element {
  const tags = useTagsStore((s) => s.tags)
  const fetchTags = useTagsStore((s) => s.fetch)
  const createTag = useTagsStore((s) => s.create)
  const updateTag = useTagsStore((s) => s.update)
  const removeTag = useTagsStore((s) => s.remove)

  const activeTag = useNotesStore((s) => s.activeTag)
  const setActiveTag = useNotesStore((s) => s.setActiveTag)

  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void fetchTags()
  }, [fetchTags])

  // 进入重命名态时聚焦
  useEffect(() => {
    if (renamingId !== null) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [renamingId])

  async function handleCreate() {
    const name = newName.trim().replace(/^#/, '')
    if (!name) return
    // 同名保护：store 层不重，由 IPC 抛错；这里静默忽略同名
    if (tags.some((t) => t.name === name)) {
      setNewName('')
      return
    }
    try {
      await createTag({ name })
      setNewName('')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[tags-sidebar] create failed', err)
    }
  }

  async function handleRename(id: string) {
    const next = renameText.trim().replace(/^#/, '')
    if (!next || next === tags.find((t) => t.id === id)?.name) {
      setRenamingId(null)
      return
    }
    try {
      await updateTag(id, { name: next })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[tags-sidebar] rename failed', err)
    }
    setRenamingId(null)
    setRenameText('')
  }

  async function handleDelete(id: string) {
    try {
      await removeTag(id)
      // 如果删除的是当前筛选项，清空筛选
      const removed = tags.find((t) => t.id === id)
      if (removed && activeTag === removed.name) setActiveTag(null)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[tags-sidebar] delete failed', err)
    }
  }

  return (
    <div className="tags-sidebar" aria-label="标签管理">
      <div className="tags-sidebar-header">
        <span className="tags-sidebar-title">标签</span>
        <span className="tags-sidebar-count">{tags.length}</span>
      </div>

      <button
        type="button"
        className={`tags-sidebar-item ${activeTag === null ? 'active' : ''}`}
        onClick={() => setActiveTag(null)}
        aria-pressed={activeTag === null}
      >
        全部标签
      </button>

      <ul className="tags-sidebar-list" role="list">
        {tags.length === 0 && (
          <li className="tags-sidebar-empty muted small">还没有自定义标签</li>
        )}
        {tags.map((t) => {
          const isRenaming = renamingId === t.id
          const isActive = activeTag === t.name
          return (
            <li key={t.id} className="tags-sidebar-row">
              {isRenaming ? (
                <input
                  ref={inputRef}
                  className="tags-sidebar-rename-input"
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleRename(t.id)
                    } else if (e.key === 'Escape') {
                      setRenamingId(null)
                      setRenameText('')
                    }
                  }}
                  onBlur={() => void handleRename(t.id)}
                  aria-label={`重命名标签 ${t.name}`}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className={`tags-sidebar-item ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveTag(isActive ? null : t.name)}
                    aria-pressed={isActive}
                    title={`筛选 #${t.name}`}
                  >
                    #{t.name}
                  </button>
                  <button
                    type="button"
                    className="tags-sidebar-icon-btn"
                    aria-label={`重命名标签 ${t.name}`}
                    title="重命名"
                    onClick={() => {
                      setRenamingId(t.id)
                      setRenameText(t.name)
                    }}
                  >
                    <Pencil size={12} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="tags-sidebar-icon-btn danger"
                    aria-label={`删除标签 ${t.name}`}
                    title="删除"
                    onClick={() => void handleDelete(t.id)}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>

      <div className="tags-sidebar-add">
        <input
          className="tags-sidebar-add-input"
          type="text"
          placeholder="+ 新标签"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleCreate()
            }
          }}
          aria-label="新建标签"
        />
        <button
          type="button"
          className="tags-sidebar-add-btn"
          onClick={() => void handleCreate()}
          disabled={!newName.trim()}
          aria-label="添加标签"
          title="添加"
        >
          {newName.trim() ? <Check size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
        </button>
      </div>
    </div>
  )
}

export default TagsSidebar