/**
 * 笔记文件夹侧栏（Round 5：合并文件列表）
 *
 * 现在的职责：
 *   1. 顶部「全部笔记 / 未分类 / 用户文件夹」三类行 —— 作为 folder 过滤器，也是 drop target
 *   2. 每个文件夹 / 「未分类」下方的展开预览区：直接列出该 folder 下的笔记（取代旧 NotesTree 的平铺 note-list）
 *
 * 与旧版差异：
 *   - 删除了独立渲染的"全部笔记 → 未分类 → 用户文件夹"中"全部笔记 / 未分类"作为
 *     drop target 的逻辑不变；但「未分类」现在也展开显示其下的笔记（原先只有用户文件夹有展开）。
 *   - 不再向上抛 tagsSidebar / 过滤 chips / 搜索框 —— 由 NotesTree 处理
 *   - 文件夹下的笔记行支持 onOpenNote（点击）/ onDeleteNote（× 按钮）
 *
 * 设计：
 *   - 扁平结构（一层）—— 与便签 palette 一致
 *   - 文件夹可绑定 color（8 色 chip 显示）
 *   - 拖拽用原生 HTML5：source 在 .note-item 的 .note-drag-handle，target 在 .folder-row
 */
import { memo, useEffect, useState } from 'react'
import { ChevronRight } from '@renderer/lib/icon'
import { useNotesStore, type FolderSelection } from '../../stores/notes'
import type { NoteFolder, NoteFolderColor, NoteMeta } from '@shared/types'
import { noteFoldersApi } from '../../lib/ipc'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useTreeExpansionStore, useTreeExpanded } from '../../stores/treeExpansion'

const FOLDER_PALETTE: NoteFolderColor[] = [
  'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose',
]

/** 稳定空数组引用 —— notesByFolder.get(k) ?? EMPTY_NOTES 在 key 缺失时
 *  始终返回同一引用，避免破坏下游 React.memo comparator 的 `prev.children === next.children`。 */
const EMPTY_NOTES: NoteMeta[] = []

interface Props {
  /** 用于在拖拽时把笔记移到目标文件夹（folderId = null = 未分类；undefined = 全部，不处理） */
  onDropToFolder: (noteId: string, folderId: FolderSelection) => void
  /** 高亮态：当前选中 */
  activeFolderId: FolderSelection
  /** 切换激活 */
  onSelectFolder: (id: FolderSelection) => void
  /** 文件夹展开预览里的笔记行点击 → 打开笔记 */
  onOpenNote?: (note: NoteMeta) => void
  /** 文件夹展开预览里的笔记行删除按钮 */
  onDeleteNote?: (note: NoteMeta) => void
}

interface PendingDelete {
  folder: NoteFolder
}

export function NoteFoldersSidebar({
  activeFolderId,
  onSelectFolder,
  onDropToFolder,
  onOpenNote,
  onDeleteNote,
}: Props) {
  const folders = useNotesStore((s) => s.folders)
  const fetchFolders = useNotesStore((s) => s.fetchFolders)
  const createFolder = useNotesStore((s) => s.createFolder)
  const renameFolder = useNotesStore((s) => s.renameFolder)
  const deleteFolder = useNotesStore((s) => s.deleteFolder)
  // 订阅 currentPath —— 笔记选中后高亮对应的 folder-child-row
  const currentPath = useNotesStore((s) => s.currentPath)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<NoteFolderColor>('blue')
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  // BUG-7-fix：sentinel 明确分离 —— `undefined` 仅表示「没有正在悬停的 drop target」，
  // `null` 表示「悬停在『未分类』行上」，string 表示「悬停在某个用户文件夹上」。
  // "全部笔记" 行不再作为 drop target，因此不会触发 setHoverDrop。
  const [hoverDrop, setHoverDrop] = useState<FolderSelection>(undefined)

  // Phase 5 (2-level-tree)：每个文件夹下面的笔记数 / 标题预览。
  // 直接从后端拉一次，过滤 archived=排除，避免与笔记列表的实时过滤冲突。
  // Key = folderId（null = 未分类），Value = NoteMeta[]。
  const [notesByFolder, setNotesByFolder] = useState<Map<string | null, NoteMeta[]>>(new Map())
  // 用 useTreeExpanded 单 key 订阅代替 isExpanded() 命令式调用 —— 后者
  // 走的是稳定的函数引用，Zustand 不会通知；前者订阅 boolean，状态变化
  // 触发本组件重渲染。直接订阅 expanded 整个 Set 会让所有折叠节点一起
  // 重渲染，单 key 订阅只让相关组件重渲染。
  const unsortedExpanded = useTreeExpanded('folder:__unsorted__')
  const toggleExpansion = useTreeExpansionStore((s) => s.toggle)

  async function reloadTreeNotes() {
    const m = new Map<string | null, NoteMeta[]>()
    try {
      // R-findByFolders (low perf)：原版 N 次 listByFolder = N 轮 IPC +
      // N 次 SELECT * WHERE folder_id = ?。用户有 20 个文件夹时 sidebar
      // 要 21 轮 round-trip 才响应（每轮 1-3ms ≈ 20-60ms）。批量接口
      // listByFolders 单 IPC + 单 SQL（folder_id IN (...) + folder_id IS NULL
      // 复合谓词），把 round-trip 压到 1 次。
      const folderIds: Array<string | null> = [null, ...folders.map((f) => f.id)]
      const grouped = await noteFoldersApi.listByFolders(folderIds, {
        archived: false,
        limit: 10,
      })
      // IPC 返回 Record<string, NoteMeta[]>（key 'null' 表示未分类）
      for (const id of folderIds) {
        const key = id === null ? 'null' : id
        m.set(id, grouped[key] ?? [])
      }
    } catch {
      // 失败：保留空 map，UI 仍然显示文件夹
    }
    setNotesByFolder(m)
  }

  // 初始拉取文件夹列表（首次挂载）
  useEffect(() => {
    void fetchFolders()
  }, [fetchFolders])

  // 文件夹列表变化 / 创建 / 删除后刷新笔记树
  useEffect(() => {
    void reloadTreeNotes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders.length])

  // BUG-2-fix：监听 window-level dragend，确保 ESC / 拖到无效位置 / drop 失败时
  // 能立刻清掉 hover 状态。dragend 只在 source 元素触发，因此放在 source 的
  // 父级 (window) 上监听最稳。
  useEffect(() => {
    function onWindowDragEnd() {
      setHoverDrop(undefined)
    }
    window.addEventListener('dragend', onWindowDragEnd)
    return () => window.removeEventListener('dragend', onWindowDragEnd)
  }, [])

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
          setHoverDrop={setHoverDrop}
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
          setHoverDrop={setHoverDrop}
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
              setHoverDrop={setHoverDrop}
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

/* -------------------------------------------------------------------------- */
/* 单个 folder row                                                             */
/* -------------------------------------------------------------------------- */

interface FolderRowProps {
  kind: 'all' | 'unsorted' | 'user'
  label: string
  active: boolean
  onClick: () => void
  onDrop: (noteId: string, folderId: FolderSelection) => void
  setHoverDrop: (id: FolderSelection) => void
  isHovering: boolean
  /** BUG-7-fix：是否作为 drop target 接受拖入。
   *  - true  → dropEffect = 'move'，可放置
   *  - false → dropEffect = 'none'，鼠标显示禁止图标，drop handler 直接返回
   */
  acceptsDrop: boolean

  // 仅 kind === 'user' 时使用
  folder?: NoteFolder
  renaming?: boolean
  renameText?: string
  onRenameTextChange?: (s: string) => void
  onRenameConfirm?: () => void
  onRenameCancel?: () => void
  onStartRename?: () => void
  onDelete?: () => void
}

function FolderRow(props: FolderRowProps) {
  const { kind, label, active, onClick, onDrop, setHoverDrop, isHovering, acceptsDrop } = props

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!acceptsDrop) {
      if (e.dataTransfer.types.includes('application/x-note-id')) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }
    if (!e.dataTransfer.types.includes('application/x-note-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const target = kindToFolderId(kind, props.folder)
    if (target !== undefined) setHoverDrop(target)
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!acceptsDrop) return
    const list = e.currentTarget.closest('.folder-list')
    const next = e.relatedTarget as Node | null
    if (list && next && list.contains(next)) return
    setHoverDrop(undefined)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setHoverDrop(undefined)
    if (!acceptsDrop) return
    const noteId = e.dataTransfer.getData('application/x-note-id')
    if (!noteId) return
    const target = kindToFolderId(kind, props.folder)
    if (target === undefined) return
    onDrop(noteId, target)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (props.renaming) return
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      className={[
        'folder-row',
        `folder-row-${kind}`,
        active ? 'active' : '',
        isHovering ? 'is-drop-target' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={
        kind === 'all'
          ? '显示全部笔记'
          : kind === 'unsorted'
            ? '显示未分类笔记'
            : `切换到文件夹 ${label}`
      }
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span
        className={`folder-icon ${iconClassName(kind, props.folder)}`.trim()}
        aria-hidden
      >
        {iconForKind(kind, props.folder)}
      </span>

      {props.renaming ? (
        <input
          className="folder-rename-input"
          value={props.renameText}
          autoFocus
          aria-label="重命名文件夹"
          onChange={(e) => props.onRenameTextChange?.(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onRenameConfirm?.()
            if (e.key === 'Escape') props.onRenameCancel?.()
          }}
          onBlur={() => props.onRenameConfirm?.()}
        />
      ) : (
        <span className="folder-label">{label}</span>
      )}

      {kind === 'user' && !props.renaming && (
        <span className="folder-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="folder-action-btn small"
            title="重命名"
            aria-label={`重命名文件夹 ${label}`}
            onClick={props.onStartRename}
          >
            ✎
          </button>
          <button
            className="folder-action-btn small danger"
            title="删除"
            aria-label={`删除文件夹 ${label}`}
            onClick={props.onDelete}
          >
            ×
          </button>
        </span>
      )}
    </div>
  )
}

function kindToFolderId(kind: FolderRowProps['kind'], folder?: NoteFolder): FolderSelection {
  if (kind === 'all') return undefined
  if (kind === 'unsorted') return null
  return folder?.id ?? null
}

function iconForKind(kind: FolderRowProps['kind'], folder?: NoteFolder): string {
  if (kind === 'all') return '🗂'
  if (kind === 'unsorted') return '📂'
  if (folder?.color) {
    return '●'
  }
  return '📁'
}

function iconClassName(kind: FolderRowProps['kind'], folder?: NoteFolder): string {
  if (kind === 'user' && folder?.color) {
    return `color-${folder.color}`
  }
  return ''
}

/* -------------------------------------------------------------------------- */
/* 2 级文件夹树（folder row + note row 子节点）                                  */
/* -------------------------------------------------------------------------- */

interface FolderWithNotesProps {
  folder: NoteFolder | null
  label: string
  colorKey: NoteFolderColor | null
  active: boolean
  expanded: boolean
  children: NoteMeta[]
  renaming?: boolean
  renameText?: string
  onRenameTextChange?: (s: string) => void
  onRenameConfirm?: () => void
  onRenameCancel?: () => void
  onStartRename?: () => void
  onDelete?: () => void
  onRowClick: () => void
  onToggleExpand: () => void
  acceptsDrop: boolean
  isHovering: boolean
  setHoverDrop: (id: FolderSelection) => void
  onDrop: (noteId: string, folderId: FolderSelection) => void
  onOpenNote?: (note: NoteMeta) => void
  onDeleteNote?: (note: NoteMeta) => void
  /** 是否本文件夹下存在「当前选中」的笔记（用 boolean 替代整字符串 currentPath，
   *  避免 currentPath 翻转时所有 FolderWithNotes 一起 re-render —— 选中态的
   *  实际渲染放到 NoteSubRow 内部 subscribe currentPath 后按需触发）。 */
  hasSelectedChild: boolean
}

/**
 * 文件夹行（带展开 / 折叠 + 二级笔记行）
 *
 * - 复用了原 FolderRow 几乎所有拖拽 / 重命名 / 删除交互
 * - 多出一个 ChevronRight 按钮，展开时 rotate-90（无 transition —— 硬切）
 * - 展开后下方插入 note 行（最多显示 5 条 + 「+N 更多」）
 * - 点击 note 行 → 设置当前笔记，**不**切换 folder（folder 已经在 active 态）
 *
 * React.memo 自定义 comparator：
 *   用户报告「笔记文件夹点击卡顿」的根本原因之一 —— 父组件每次
 *   activeFolderId / currentPath / notesByFolder 变更都全量重建 N 个
 *   FolderWithNotes。这里只对「视觉相关 + 数据相关」的 props 做浅比较，
 *   handler 引用变化不触发重渲染（handler 逻辑只依赖 props 自带的字段，
 *   父级不需要为它们上 useCallback 也安全）。
 *   - 关键 props：folder 引用、label、colorKey、active、expanded、children 引用、
 *     renaming、renameText、currentPath、acceptsDrop、isHovering
 *   - 忽略 props：onRowClick / onToggleExpand / setHoverDrop / onDrop / onOpenNote /
 *     onDeleteNote / onRenameTextChange / onRenameConfirm / onRenameCancel /
 *     onStartRename / onDelete —— 父级 inline arrow 不稳定但行为只依赖本组件
 *     已经对比过的字段，没有 stale closure 风险
 */
const FolderWithNotes = memo(
function FolderWithNotes(props: FolderWithNotesProps) {
  const {
    folder, label, colorKey, active, expanded, children,
    renaming, renameText, onRenameTextChange, onRenameConfirm, onRenameCancel, onStartRename, onDelete,
    onRowClick, onToggleExpand, acceptsDrop, isHovering, setHoverDrop, onDrop,
    onOpenNote, onDeleteNote,
  } = props

  const folderId = folder?.id ?? null

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!acceptsDrop) return
    if (!e.dataTransfer.types.includes('application/x-note-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setHoverDrop(folderId)
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!acceptsDrop) return
    const list = e.currentTarget.closest('.folder-list')
    const next = e.relatedTarget as Node | null
    if (list && next && list.contains(next)) return
    setHoverDrop(undefined)
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setHoverDrop(undefined)
    if (!acceptsDrop) return
    const noteId = e.dataTransfer.getData('application/x-note-id')
    if (!noteId) return
    onDrop(noteId, folderId)
  }

  /**
   * Round 5 修复 (high)：原版点击行只触发 onRowClick（设置 folder 过滤），
   * 用户期望点击文件夹能"打开/展开"它。但 chevron 单独 stopPropagation
   * 阻止了行的展开行为 —— 用户根本找不到打开入口。
   *
   * 新行为：
   *   - 点击行（除 chevron / 重命名 / 删除按钮） → 切换展开 + 设为活跃
   *   - chevron 点击 → 仅切换展开（视觉反馈一致）
   *   - 行内按钮（重命名 / 删除）→ 阻止冒泡，行为不变
   *
   * R-fix-nested-interactive-role (medium a11y)：之前外层 div 同时挂了
   * role="button" + tabIndex=0 + aria-pressed，**嵌套**了真实的
   * chevron / 重命名 / 删除 <button>。这是 WAI-ARIA 不允许的「嵌套交互元素」
   * 反模式 —— VoiceOver 会读到「切换到文件夹 X 按钮」进入后再次读到
   * 「重命名文件夹 X 按钮 / 删除文件夹 X 按钮」，语义层级混乱；并触发
   * 4.1.2 Name Role Value 违规。修复：去掉外层的 role / tabIndex / aria-* /
   * onKeyDown，让 div 只承担布局 + 鼠标点击（onClick），键盘交互完全交给
   * 真按钮（chevron 切展开、actions 改 / 删）。与 NoteFoldersSidebar 旧实现
   * 对齐。
   */
  function handleRowClick(e: React.MouseEvent<HTMLDivElement>) {
    // 让行内按钮的 stopPropagation 生效；这里只处理 row 自身的点击
    if (e.target !== e.currentTarget) {
      // 但如果点到的是 chevron / 按钮 / input，已经 stopPropagation，这里不会触发
      return
    }
    onToggleExpand()
    onRowClick()
  }

  return (
    <div className={`folder-with-notes ${expanded ? 'is-expanded' : ''}`}>
      <div
        className={[
          'folder-row',
          'folder-row-user',
          active ? 'active' : '',
          isHovering ? 'is-drop-target' : '',
        ].filter(Boolean).join(' ')}
        onClick={handleRowClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* chevron */}
        <button
          type="button"
          className={`folder-chevron ${expanded ? 'is-expanded' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          aria-label={expanded ? `折叠 ${label}` : `展开 ${label}`}
          aria-expanded={expanded}
          aria-controls={`folder-children-${folder?.id ?? '__unsorted__'}`}
          title={expanded ? '折叠' : '展开'}
        >
          <ChevronRight size={12} aria-hidden />
        </button>

        <span
          className={`folder-icon ${colorKey ? `color-${colorKey}` : ''}`.trim()}
          aria-hidden
        >
          {colorKey ? '●' : folder ? '📁' : '📂'}
        </span>

        {renaming ? (
          <input
            className="folder-rename-input"
            value={renameText}
            autoFocus
            aria-label="重命名文件夹"
            onChange={(e) => onRenameTextChange?.(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameConfirm?.()
              if (e.key === 'Escape') onRenameCancel?.()
            }}
            onBlur={onRenameConfirm}
          />
        ) : (
          <span className="folder-label">{label}</span>
        )}

        {!renaming && children.length > 0 && (
          <span className="folder-count muted small">{children.length}</span>
        )}

        {!renaming && folder && (
          <span className="folder-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="folder-action-btn small"
              title="重命名"
              aria-label={`重命名文件夹 ${label}`}
              onClick={onStartRename}
            >
              ✎
            </button>
            <button
              className="folder-action-btn small danger"
              title="删除"
              aria-label={`删除文件夹 ${label}`}
              onClick={onDelete}
            >
              ×
            </button>
          </span>
        )}
      </div>
      {expanded && (
        <ul
          className="folder-children"
          role="group"
          aria-label={`${label} 下的笔记`}
          id={`folder-children-${folder?.id ?? '__unsorted__'}`}
        >
          {children.length === 0 && (
            <li className="folder-children-empty muted small">
              {folder ? '文件夹下没有笔记' : '还没有未分类的笔记'}
            </li>
          )}
          {children.slice(0, 5).map((n) => (
            <NoteSubRow
              key={n.path}
              note={n}
              onOpen={onOpenNote}
              onDelete={onDeleteNote}
            />
          ))}
          {children.length > 5 && (
            <li className="folder-children-more muted small">+{children.length - 5} 更多</li>
          )}
        </ul>
      )}
    </div>
  )
},
  (prev, next) =>
    prev.folder === next.folder &&
    prev.label === next.label &&
    prev.colorKey === next.colorKey &&
    prev.active === next.active &&
    prev.expanded === next.expanded &&
    prev.children === next.children &&
    prev.renaming === next.renaming &&
    prev.renameText === next.renameText &&
    prev.acceptsDrop === next.acceptsDrop &&
    prev.isHovering === next.isHovering,
    // R-fix-NoteFoldersSidebar-handlers (perf, medium)：原 comparator 含
    // currentPath —— 用户打开任意一条便签 → currentPath 字符串变化 → 所有
    // FolderWithNotes 的 comparator 全失效 → 整棵 sidebar re-render。
    // 改为父组件派生 hasSelectedChild boolean，只有「本 folder 下确实有笔记被选中」
    // 时才受影响；其它文件夹的 boolean 没变 → comparator 命中 → 跳过 re-render。
    // 同时 hasSelectedChild 也不必从此 comparator 移除；只有当某 folder 第一次
    // 进入「有选中子」状态时该 row 才 re-render，符合直觉。
)

/* -------------------------------------------------------------------------- */
/* 用户文件夹行 wrapper —— 把每个用户文件夹的 `useTreeExpanded(f.id)` 调用隔离
 * 到独立组件，让 React Rules of Hooks 不被 .map() 循环破坏，同时让单个文件夹
 * 展开状态变化只重渲染本行（不波及兄弟行）。                                  */
/* -------------------------------------------------------------------------- */

interface UserFolderRowProps {
  folder: NoteFolder
  activeFolderId: FolderSelection
  hoverDrop: FolderSelection
  renameId: string | null
  renameText: string
  children: NoteMeta[]
  setHoverDrop: (id: FolderSelection) => void
  setRenameText: (s: string) => void
  setRenameId: (id: string | null) => void
  handleRename: (id: string) => Promise<void>
  setPendingDelete: (p: PendingDelete) => void
  onSelectFolder: (id: FolderSelection) => void
  onDropToFolder: (noteId: string, folderId: FolderSelection) => void
  onOpenNote?: (note: NoteMeta) => void
  onDeleteNote?: (note: NoteMeta) => void
  /** 是否本文件夹下存在「当前选中」的笔记（boolean 替代字符串 currentPath，
   *  避免 currentPath 翻转时所有 UserFolderRow 一起 re-render） */
  hasSelectedChild: boolean
}

/** 把每个用户文件夹折叠/展开的订阅隔离开 —— 单独改一个文件夹不会触发
 *  其他兄弟文件夹或外层 NoteFoldersSidebar 任何无关重渲染。
 *
 *  R-fix-NoteFoldersSidebar-handlers (perf, medium)：原版未 memo 包裹，
 *  父组件 NoteFoldersSidebar 任何 render 都让所有 UserFolderRow 跟着 re-render。
 *  现在加 React.memo + 自定义 comparator：忽略 handler 引用变化（行为依赖外部
 *  store / setState，引用稳定即可；父组件已对 onOpenNote/onDeleteNote 等做了
 *  useCallback）。关键数据字段变化（folder / children / hoverDrop /
 *  renameId / renameText / hasSelectedChild）才触发重渲染。              */
const UserFolderRow = memo(
  function UserFolderRow(props: UserFolderRowProps) {
    const { folder, children, ...rest } = props
    // 单 key 订阅 —— Zustand selector 返回 boolean，Object.is 比较；
    // 仅该文件夹折叠状态变化才重渲染本组件，O(1) 而不是 O(N) 全列表。
    const expanded = useTreeExpanded(`folder:${folder.id}`)
    const toggleExpansion = useTreeExpansionStore((s) => s.toggle)

    return (
      <FolderWithNotes
        folder={folder}
        label={folder.name}
        colorKey={folder.color}
        active={rest.activeFolderId === folder.id}
        expanded={expanded}
        children={children}
        renaming={rest.renameId === folder.id}
        renameText={rest.renameText}
        acceptsDrop
        isHovering={rest.hoverDrop === folder.id}
        onRenameTextChange={rest.setRenameText}
        onRenameConfirm={() => void rest.handleRename(folder.id)}
        onRenameCancel={() => rest.setRenameId(null)}
        onStartRename={() => {
          rest.setRenameId(folder.id)
          rest.setRenameText(folder.name)
        }}
        onDelete={async () => {
          // R-fix-NoteFoldersSidebar-delete-count (correctness, medium)：原版
          // 走 listByFolder + limit:10 预拉一次只为拿数量，对 11+ 笔记的文件夹
          // 直接说谎（"将分离 10 条" 实际可能分离更多）。删除的真正数量由
          // 主进程 NOTE_FOLDER_DELETE 返回（{ deleted, detachedNotes }），
          // 这里没必要再多发一次 IPC。确认弹窗改为通用文案「该文件夹下的笔记
          // 会移至未分类」，让主进程去算账；结果仍可在删除后通过 toast 提示。
          rest.setPendingDelete({ folder })
        }}
        onRowClick={() => rest.onSelectFolder(folder.id)}
        onToggleExpand={() => toggleExpansion(`folder:${folder.id}`)}
        setHoverDrop={rest.setHoverDrop}
        onDrop={rest.onDropToFolder}
        onOpenNote={rest.onOpenNote}
        onDeleteNote={rest.onDeleteNote}
        hasSelectedChild={rest.hasSelectedChild}
      />
    )
  },
  // 浅比较 comparator：folder 引用 + 数据字段相同才跳过重渲染。handler 引用
  // 变化（onSelectFolder / onDropToFolder / onOpenNote / onDeleteNote /
  // setHoverDrop / setRenameText / setRenameId / handleRename / setPendingDelete）
  // 全部忽略 —— 它们的行为依赖外部稳定源（Zustand action / setState / 已 useCallback）。
  (prev, next) =>
    prev.folder === next.folder &&
    prev.activeFolderId === next.activeFolderId &&
    prev.hoverDrop === next.hoverDrop &&
    prev.renameId === next.renameId &&
    prev.renameText === next.renameText &&
    prev.children === next.children &&
    prev.hasSelectedChild === next.hasSelectedChild,
)

/** 二级笔记行 —— 显示标题 + 修改时间 + 删除按钮，点击切到当前笔记
 *
 * React.memo 自定义 comparator：
 *   - note 引用不变 + handler 引用不变 → 跳过重渲染
 *   - 选中态（isSelected）已下沉到本组件内 `useNotesStore((s) => s.currentPath === note.path)` 订阅：
 *     只有「自己变成/脱离选中」那一行 re-render，不再把 currentPath 沿 FolderWithNotes 整树透传。
 *   - onOpen/onDelete 由父级 useCallback 稳定（NotesTree 已包）。
 */
const NoteSubRow = memo(
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
    function fmt(iso: string): string {
      try {
        const d = new Date(iso)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      } catch {
        return ''
      }
    }
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
          <span className="folder-child-time muted">{fmt(note.mtime)}</span>
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
