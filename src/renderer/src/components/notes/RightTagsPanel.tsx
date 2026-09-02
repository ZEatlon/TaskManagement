/**
 * 右侧标签管理面板
 *
 * Round 5：从原 NotesTree 左侧的 TagsSidebar 迁到右侧 aside。
 *
 * 功能：
 *   - 列出所有自定义 tag（来自 useTagsStore）
 *   - inline add / rename / delete
 *   - 点击 tag → 通过 setActiveTag 把笔记列表过滤到该 tag
 *   - 「全部标签」按钮清除筛选
 *
 * 与左侧 TagsSidebar 的差异：
 *   - 复用同样的 hook + store API
 *   - 视觉上更紧凑（右侧 aside 宽度通常 280px，与原 sidebar 接近）
 *   - 顶部有更明显的「标签管理」标题 + 总数 badge
 *   - 与右侧 NoteMetaPanel 上下堆叠
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, X, Pencil, Check, Tag as TagIcon } from 'lucide-react'
import { useTagsStore } from '../../stores/tags'
import { useNotesStore } from '../../stores/notes'

export function RightTagsPanel(): JSX.Element {
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
    if (tags.some((t) => t.name === name)) {
      setNewName('')
      return
    }
    try {
      await createTag({ name })
      setNewName('')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[right-tags-panel] create failed', err)
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
      console.warn('[right-tags-panel] rename failed', err)
    }
    setRenamingId(null)
    setRenameText('')
  }

  async function handleDelete(id: string) {
    try {
      await removeTag(id)
      const removed = tags.find((t) => t.id === id)
      if (removed && activeTag === removed.name) setActiveTag(null)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[right-tags-panel] delete failed', err)
    }
  }

  return (
    <div className="right-tags-panel" aria-label="标签管理">
      <div className="right-tags-panel-header">
        <TagIcon size={12} aria-hidden />
        <span className="right-tags-panel-title">标签</span>
        <span className="right-tags-panel-count">{tags.length}</span>
      </div>

      <button
        type="button"
        className={`right-tags-panel-item ${activeTag === null ? 'active' : ''}`}
        onClick={() => setActiveTag(null)}
        aria-pressed={activeTag === null}
      >
        全部标签
      </button>

      <ul className="right-tags-panel-list" role="list">
        {tags.length === 0 && (
          <li className="right-tags-panel-empty muted small">还没有自定义标签</li>
        )}
        {tags.map((t) => {
          const isRenaming = renamingId === t.id
          const isActive = activeTag === t.name
          return (
            <li key={t.id} className="right-tags-panel-row">
              {isRenaming ? (
                <input
                  ref={inputRef}
                  className="right-tags-panel-rename-input"
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
                    className={`right-tags-panel-item ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveTag(isActive ? null : t.name)}
                    aria-pressed={isActive}
                    title={`筛选 #${t.name}`}
                  >
                    #{t.name}
                  </button>
                  <button
                    type="button"
                    className="right-tags-panel-icon-btn"
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
                    className="right-tags-panel-icon-btn danger"
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

      <div className="right-tags-panel-add">
        <input
          className="right-tags-panel-add-input"
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
          className="right-tags-panel-add-btn"
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

export default RightTagsPanel
