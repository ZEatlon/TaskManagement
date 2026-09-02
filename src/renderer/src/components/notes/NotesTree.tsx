/**
 * 笔记列表（侧栏）
 *
 * Round 5 调整：
 *   - 标签管理面板（TagsSidebar）已迁移到右侧 aside；本组件不再渲染 tag list。
 *   - 文件夹与文件列表合并：NoteFoldersSidebar 内部已实现「文件夹 + 二级笔记预览」2 级 tree，
 *     这里不再额外渲染一整份平铺的 note-list，避免重复。
 *
 * 保留的功能：
 *   - 顶部：搜索框 + 新建按钮（搜索走 useNotesStore.search，自带 seq 守卫 + IPC debounce）
 *   - 过滤 tab：全部 / 收藏 / 归档
 *   - 文件夹展开预览里的笔记行支持点击打开 / 删除按钮（透传给 NoteFoldersSidebar）
 *
 * 标签筛选仍然通过 useNotesStore.activeTag —— 用户在右侧 TagsPanel 点选后，store
 * 内置逻辑会同步刷新 notes 数组。
 */
import { useEffect, useRef, useState } from 'react'
import { useNotesStore, type FolderSelection, type NotesFilter } from '../../stores/notes'
import type { NoteMeta } from '@shared/types'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { NoteFoldersSidebar } from './NoteFoldersSidebar'

interface Props {
  onSelect?: (note: NoteMeta) => void
}

interface PendingDelete {
  path: string
  title: string
}

export function NotesTree({ onSelect }: Props) {
  const filter = useNotesStore((s) => s.filter)
  const activeFolderId = useNotesStore((s) => s.activeFolderId)
  const searchQuery = useNotesStore((s) => s.searchQuery)
  const setFilter = useNotesStore((s) => s.setFilter)
  const setActiveFolder = useNotesStore((s) => s.setActiveFolder)
  const moveNoteToFolder = useNotesStore((s) => s.moveNoteToFolder)
  const open = useNotesStore((s) => s.open)
  const create = useNotesStore((s) => s.create)
  const fetch = useNotesStore((s) => s.fetch)
  const remove = useNotesStore((s) => s.remove)
  const search = useNotesStore((s) => s.search)

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  // R7F-2：搜索 debounce —— 用户每按一个字母都直接 search() → note:search IPC，
  // 5 个字符就是 5 次 roundtrip。改为 250ms 静默期后再触发，Enter 立即触发。
  const searchDebounceRef = useRef<number | null>(null)

  useEffect(() => {
    void fetch()
  }, [fetch])

  // 卸载时清理 search timer
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
    }
  }, [])

  async function handleCreate() {
    await create()
    const cur = useNotesStore.getState().currentNote
    if (cur && onSelect) {
      onSelect({
        id: cur.id,
        path: cur.path,
        filename: cur.filename,
        title: cur.title,
        size: 0,
        mtime: cur.mtime,
        ctime: cur.ctime,
        tags: cur.tags,
        isPinned: false,
        isFavorite: false,
        folderId: cur.folderId ?? null,
      })
    }
  }

  async function handleSearch(value: string) {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
    }
    if (value.trim().length === 0) {
      searchDebounceRef.current = null
      await search(value)
      return
    }
    searchDebounceRef.current = window.setTimeout(() => {
      searchDebounceRef.current = null
      void search(value)
    }, 250)
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
      void search((e.target as HTMLInputElement).value)
    }
  }

  function handleDropToFolder(noteId: string, folderId: FolderSelection) {
    if (folderId === undefined) return
    void moveNoteToFolder(noteId, folderId ?? null)
  }

  function handleConfirmDelete() {
    if (!pendingDelete) return
    void remove(pendingDelete.path)
    setPendingDelete(null)
  }

  return (
    <div className="notes-tree">
      <div className="tree-header">
        <input
          className="search-input"
          type="search"
          placeholder="搜索标题或文件名…"
          aria-label="搜索笔记"
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
        <button
          className="btn primary create-btn"
          onClick={handleCreate}
          title="新建笔记"
        >
          + 新建
        </button>
      </div>

      <div className="filter-tabs" role="tablist" aria-label="笔记过滤">
        <button
          role="tab"
          aria-selected={filter === 'all'}
          tabIndex={filter === 'all' ? 0 : -1}
          className={`tab ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault()
              const order: NotesFilter[] = ['all', 'starred', 'archived']
              const idx = order.indexOf(filter)
              const next = e.key === 'ArrowRight'
                ? order[(idx + 1) % order.length]
                : order[(idx - 1 + order.length) % order.length]
              setFilter(next)
            }
          }}
        >
          全部
        </button>
        <button
          role="tab"
          aria-selected={filter === 'starred'}
          tabIndex={filter === 'starred' ? 0 : -1}
          className={`tab ${filter === 'starred' ? 'active' : ''}`}
          onClick={() => setFilter('starred')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault()
              const order: NotesFilter[] = ['all', 'starred', 'archived']
              const idx = order.indexOf(filter)
              const next = e.key === 'ArrowRight'
                ? order[(idx + 1) % order.length]
                : order[(idx - 1 + order.length) % order.length]
              setFilter(next)
            }
          }}
        >
          收藏
        </button>
        <button
          role="tab"
          aria-selected={filter === 'archived'}
          tabIndex={filter === 'archived' ? 0 : -1}
          className={`tab ${filter === 'archived' ? 'active' : ''}`}
          onClick={() => setFilter('archived')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault()
              const order: NotesFilter[] = ['all', 'starred', 'archived']
              const idx = order.indexOf(filter)
              const next = e.key === 'ArrowRight'
                ? order[(idx + 1) % order.length]
                : order[(idx - 1 + order.length) % order.length]
              setFilter(next)
            }
          }}
        >
          归档
        </button>
      </div>

      {/* 文件夹 + 文件列表合并（NoteFoldersSidebar 已实现 2 级 tree） */}
      <NoteFoldersSidebar
        activeFolderId={activeFolderId}
        onSelectFolder={setActiveFolder}
        onDropToFolder={handleDropToFolder}
        onOpenNote={(n) => {
          void open(n.path)
          onSelect?.(n)
        }}
        onDeleteNote={(n) =>
          setPendingDelete({ path: n.path, title: n.title })
        }
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除笔记"
        body={pendingDelete ? `确认删除 "${pendingDelete.title}"？此操作不可撤销。` : ''}
        confirmLabel="删除"
        tone="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}

export default NotesTree
