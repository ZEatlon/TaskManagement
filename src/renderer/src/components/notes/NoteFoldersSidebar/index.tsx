/**
 * W2-A③ NoteFoldersSidebar 拆分 —— 顶层入口
 *
 * 历史：原本是一个 891 行的 NoteFoldersSidebar.tsx 单文件，含：
 *   - 顶层状态机（创建 / 重命名 / 删除 / drop / 拖拽 hover）
 *   - 简易 FolderRow（不带子节点展开）
 *   - FolderWithNotes（带 chevron + 二级笔记行）
 *   - UserFolderRow（per-folder hook 隔离 wrapper）
 *   - NoteSubRow（二级笔记叶子节点）
 *   - 工具函数（kindToFolderId / iconForKind / iconClassName）
 *   - 类型 / 调色板常量
 *
 * 现在拆到 NoteFoldersSidebar/ 目录：
 *   types.ts          —— 类型 + FOLDER_PALETTE + EMPTY_NOTES
 *   utils.ts          —— 工具函数
 *   hooks.ts          —— useNotesByFolder + useWindowDragEndClear
 *   FolderRow.tsx     —— 简易 row
 *   FolderWithNotes.tsx —— folder row + 子笔记列表（memo + comparator）
 *   UserFolderRow.tsx —— per-folder hook 隔离 wrapper（memo + comparator）
 *   NoteSubRow.tsx    —— 叶子笔记行（memo + 选中态下沉到本组件）
 *   index.tsx         —— 本文件：顶层状态 + 渲染编排
 *
 * NotesTree 仍按旧路径 `from './NoteFoldersSidebar'` 导入，行为不变。
 */
import { useEffect, useState } from 'react'
import { useNotesStore } from '../../../stores/notes'
import { noteFoldersApi } from '../../../lib/ipc'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { useTreeExpansionStore, useTreeExpanded } from '../../../stores/treeExpansion'
import { FolderRow } from './FolderRow'
import { FolderWithNotes } from './FolderWithNotes'
import { UserFolderRow } from './UserFolderRow'
import { TrashNode } from './TrashNode'
import { useNotesByFolder, useWindowDragEndClear } from './hooks'
import { EMPTY_NOTES, FOLDER_PALETTE } from './types'
import type {
  NoteFoldersSidebarProps,
  PendingDelete,
} from './types'

export function NoteFoldersSidebar({
  activeFolderId,
  onSelectFolder,
  onDropToFolder,
  onOpenNote,
  onDeleteNote,
  trashActive,
  onOpenTrash,
  onPurgeAllTrash,
  trashRefreshKey,
}: NoteFoldersSidebarProps) {
  const folders = useNotesStore((s) => s.folders)
  const fetchFolders = useNotesStore((s) => s.fetchFolders)
  const createFolder = useNotesStore((s) => s.createFolder)
  const renameFolder = useNotesStore((s) => s.renameFolder)
  const deleteFolder = useNotesStore((s) => s.deleteFolder)
  // 订阅 currentPath —— 笔记选中后高亮对应的 folder-child-row
  const currentPath = useNotesStore((s) => s.currentPath)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<typeof FOLDER_PALETTE[number]>('blue')
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  // BUG-7-fix：sentinel 明确分离 —— `undefined` 仅表示「没有正在悬停的 drop target」，
  // `null` 表示「悬停在『未分类』行上」，string 表示「悬停在某个用户文件夹上」。
  // "全部笔记" 行不再作为 drop target，因此不会触发 setHoverDrop。
  const [hoverDrop, setHoverDrop] = useState<typeof activeFolderId>(undefined)

  // Phase 5 (2-level-tree)：每个文件夹下面的笔记数 / 标题预览（hook 化）
  const notesByFolder = useNotesByFolder(folders)
  // 用 useTreeExpanded 单 key 订阅代替 isExpanded() 命令式调用 —— 后者
  // 走的是稳定的函数引用，Zustand 不会通知；前者订阅 boolean，状态变化
  // 触发本组件重渲染。直接订阅 expanded 整个 Set 会让所有折叠节点一起
  // 重渲染，单 key 订阅只让相关组件重渲染。
  const unsortedExpanded = useTreeExpanded('folder:__unsorted__')
  const toggleExpansion = useTreeExpansionStore((s) => s.toggle)

  // 拖出 / ESC / 失败时清掉 hover 态
  useWindowDragEndClear(setHoverDrop as (id: undefined) => void)

  // 初始拉取文件夹列表（首次挂载）
  useEffect(() => {
    void fetchFolders()
  }, [fetchFolders])

  async function handleCreate() {
    const name = newName.trim()
    // UX #3：空名直接拒绝创建，避免静默生成「新建文件夹」
    if (!name) return
    const folder = await createFolder({ name, color: newColor })
    if (folder) {
      setNewName('')
      setCreating(false)
      onSelectFolder(folder.id)
    }
  }

  async function handleRename(id: string) {
    const text = renameText.trim()
    if (!text) {
      setRenameId(null)
      return
    }
    await renameFolder(id, { name: text })
    setRenameId(null)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      const result = await deleteFolder(pendingDelete.folder.id)
      void result
    } finally {
      setPendingDelete(null)
    }
  }

  const unsortedNotes = notesByFolder.get(null) ?? EMPTY_NOTES

  return (
    <div className="note-folders-sidebar">
      <div className="folders-header">
        <span className="folders-title">文件夹</span>
        <button
          className="folder-action-btn"
          onClick={() => setCreating((v) => !v)}
          title="新建文件夹"
          aria-label="新建文件夹"
          aria-expanded={creating}
          aria-controls="folder-create-form"
        >
          ＋
        </button>
      </div>

      {creating && (
        <div className="folder-create-form">
          <input
            className="folder-name-input"
            placeholder="文件夹名"
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') {
                setCreating(false)
                setNewName('')
              }
            }}
          />
          <div className="folder-color-row">
            {FOLDER_PALETTE.map((c) => (
              <button
                key={c}
                className={`folder-color-dot color-${c} ${newColor === c ? 'selected' : ''}`}
                onClick={() => setNewColor(c)}
                aria-label={`选择颜色 ${c}`}
              />
            ))}
          </div>
          <div className="folder-form-actions">
            <button
              className="btn small primary"
              onClick={handleCreate}
              disabled={!newName.trim()}
            >
              创建
            </button>
            <button
              className="btn small ghost"
              onClick={() => {
                setCreating(false)
                setNewName('')
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div
        className="folder-list"
        onDragLeave={(e) => {
          const list = e.currentTarget
          const next = e.relatedTarget as Node | null
          if (next && list.contains(next)) return
          setHoverDrop(undefined)
        }}
      >
        {/* 全部笔记（取消文件夹过滤）—— 不是 drop target，dropEffect 显式置 'none' */}
        <FolderRow
          kind="all"
          label="全部笔记"
          active={activeFolderId === undefined}
          onClick={() => onSelectFolder(undefined)}
          acceptsDrop={false}
          onDrop={(noteId, folderId) => onDropToFolder(noteId, folderId)}
          setHoverDrop={setHoverDrop as (id: typeof activeFolderId) => void}
          isHovering={false}
        />

        {/* 未分类（folderId IS NULL）—— 现在也展开显示其下的笔记（合并文件列表） */}
        <FolderWithNotes
          folder={null}
          label="未分类"
          colorKey={null}
          active={activeFolderId === null}
          expanded={unsortedExpanded}
          children={unsortedNotes}
          onRowClick={() => onSelectFolder(null)}
          onToggleExpand={() => toggleExpansion('folder:__unsorted__')}
          acceptsDrop
          isHovering={hoverDrop === null}
          setHoverDrop={setHoverDrop as (id: typeof activeFolderId) => void}
          onDrop={onDropToFolder}
          onOpenNote={onOpenNote}
          onDeleteNote={onDeleteNote}
          hasSelectedChild={unsortedNotes.some((n) => n.path === currentPath)}
        />

        {/* 用户创建的文件夹 */}
        {folders.map((f) => {
          const children = notesByFolder.get(f.id) ?? EMPTY_NOTES
          const childHasSelected = children.some((n) => n.path === currentPath)
          return (
            <UserFolderRow
              key={f.id}
              folder={f}
              activeFolderId={activeFolderId}
              hoverDrop={hoverDrop}
              renameId={renameId}
              renameText={renameText}
              setHoverDrop={setHoverDrop as (id: typeof activeFolderId) => void}
              setRenameText={setRenameText}
              setRenameId={setRenameId}
              handleRename={handleRename}
              setPendingDelete={setPendingDelete}
              onSelectFolder={onSelectFolder}
              onDropToFolder={onDropToFolder}
              onOpenNote={onOpenNote}
              onDeleteNote={onDeleteNote}
              children={children}
              hasSelectedChild={childHasSelected}
            />
          )
        })}

        {/* W2-A④：回收站 —— 系统节点，不支持 drop / rename / delete。
            在所有用户文件夹之后，作为 sidebar 底部固定行。 */}
        {onOpenTrash && onPurgeAllTrash && (
          <TrashNode
            active={Boolean(trashActive)}
            onOpen={onOpenTrash}
            onPurgeAll={onPurgeAllTrash}
            refreshKey={trashRefreshKey ?? 0}
          />
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除文件夹"
        body={
          pendingDelete
            ? `确认删除文件夹「${pendingDelete.folder.name}」？该文件夹下的笔记会移至「未分类」。`
            : ''
        }
        confirmLabel="删除"
        tone="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

/** 默认导出保持命名导出形态，方便测试 import。 */
export default NoteFoldersSidebar

/** 重新导出 fetchFolders 调用 —— 实际上 NotesTree 已用 useNotesStore.getState()，
 *  这里只为兼容旧 import 路径的 module-level 调用，无副作用。 */
export { noteFoldersApi }
