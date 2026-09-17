/**
 * W2-A③ NoteFoldersSidebar 拆分 —— 简易 FolderRow
 *
 * 用于「全部笔记 / 未分类」等不需要展开子节点的轻量行（不支持 chevron 展开）。
 * 带重命名 / 删除按钮（仅 kind === 'user' 时显示）。
 * 不在本组件内订阅任何外部状态 —— props 全部由父级注入。
 */
import type { FolderRowProps } from './types'
import { iconClassName, iconForKind, kindToFolderId } from './utils'

export function FolderRow(props: FolderRowProps) {
  const {
    kind, label, active, onClick, onDrop, setHoverDrop, isHovering, acceptsDrop,
  } = props

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
