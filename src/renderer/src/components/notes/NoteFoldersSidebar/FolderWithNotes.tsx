/**
 * W2-A③ NoteFoldersSidebar 拆分 —— FolderWithNotes
 *
 * 文件夹行 + 二级笔记子节点。chevron 展开 / 折叠时下方插入 note 行
 * （最多显示 5 条 + 「+N 更多」）。点击 note 行 → 设置当前笔记，**不**
 * 切换 folder（folder 已经在 active 态）。
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
import { memo } from 'react'
import { ChevronRight } from '@renderer/lib/icon'
import { NoteSubRow } from './NoteSubRow'
import type { FolderWithNotesProps } from './types'

export const FolderWithNotes = memo(
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
