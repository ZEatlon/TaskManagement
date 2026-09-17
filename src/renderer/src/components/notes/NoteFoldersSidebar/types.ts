/**
 * W2-A③ NoteFoldersSidebar 拆分 —— 类型 / 常量集中处
 */
import type { NoteFolder, NoteFolderColor, NoteMeta } from '@shared/types'
import type { FolderSelection } from '../../../stores/notes'

/** 8 色 chip 调色板 —— 与主进程 noteFoldersApi 一致 */
export const FOLDER_PALETTE: NoteFolderColor[] = [
  'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose',
]

/** 稳定空数组引用 —— notesByFolder.get(k) ?? EMPTY_NOTES 在 key 缺失时
 * 始终返回同一引用，避免破坏下游 React.memo comparator 的 `prev.children === next.children`。 */
export const EMPTY_NOTES: NoteMeta[] = []

/** W2-A④：Trash 节点的初始 count（首次挂载到 listTrash 返回前的占位）。
 *  使用 -1 区分「未知」与「已知为 0」，避免闪烁的 0→N 抖动让徽标误以为已变化。 */
export const EMPTY_TRASH_COUNT = -1

/** NoteFoldersSidebar 顶层 Props */
export interface NoteFoldersSidebarProps {
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
  // ── W2-A④：回收站 ──
  /** 当前是否在「回收站」视图（高亮 trash 节点）。 */
  trashActive?: boolean
  /** 点击 trash 节点：切到回收站视图。 */
  onOpenTrash?: () => void
  /** 永久清空回收站（purge-all 一次性删除所有 trashed 笔记）。 */
  onPurgeAllTrash?: () => Promise<void>
  /** trash 操作后递增，让 TrashNode 重新拉取数量。 */
  trashRefreshKey?: number
}

/** ConfirmDialog 状态机：等待用户确认删除的 folder */
export interface PendingDelete {
  folder: NoteFolder
}

/** kind 描述「这行是哪种 folder 行」—— all / unsorted / user 三态 */
export type FolderRowKind = 'all' | 'unsorted' | 'user'

/** 简易 FolderRow 的 props（用于未展开的「全部笔记 / 未分类」行） */
export interface FolderRowProps {
  kind: FolderRowKind
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

/** FolderWithNotesProps —— 文件夹行 + 二级笔记子节点 */
export interface FolderWithNotesProps {
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
   * 避免 currentPath 翻转时所有 FolderWithNotes 一起 re-render —— 选中态的
   * 实际渲染放到 NoteSubRow 内部 subscribe currentPath 后按需触发）。 */
  hasSelectedChild: boolean
}

/** UserFolderRowProps —— 把每个用户文件夹的 hook 调用隔离开 */
export interface UserFolderRowProps {
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
   * 避免 currentPath 翻转时所有 UserFolderRow 一起 re-render） */
  hasSelectedChild: boolean
}
