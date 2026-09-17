/**
 * W2-A③ NoteFoldersSidebar 拆分 —— 工具函数
 */
import type { NoteFolder } from '@shared/types'
import type { FolderSelection } from '../../../stores/notes'
import type { FolderRowKind } from './types'

/** 把 kind + folder 解析成 drop target 的 folderId：
 *  - 'all'      → undefined（不接收 drop）
 *  - 'unsorted' → null（未分类）
 *  - 'user'     → folder.id（用户文件夹）
 */
export function kindToFolderId(
  kind: FolderRowKind,
  folder?: NoteFolder,
): FolderSelection {
  if (kind === 'all') return undefined
  if (kind === 'unsorted') return null
  return folder?.id ?? null
}

/** FolderRow 的图标字符（emoji） */
export function iconForKind(kind: FolderRowKind, folder?: NoteFolder): string {
  if (kind === 'all') return '🗂'
  if (kind === 'unsorted') return '📂'
  if (folder?.color) {
    return '●'
  }
  return '📁'
}

/** FolderRow 的图标 className —— 仅 kind=user + folder.color 时上色 */
export function iconClassName(kind: FolderRowKind, folder?: NoteFolder): string {
  if (kind === 'user' && folder?.color) {
    return `color-${folder.color}`
  }
  return ''
}
