/**
 * W2-A③ NoteFoldersSidebar 拆分 —— UserFolderRow
 *
 * 把每个用户文件夹的 `useTreeExpanded(f.id)` 调用隔离到独立组件：
 *   - 让 React Rules of Hooks 不被 .map() 循环破坏
 *   - 让单个文件夹展开状态变化只重渲染本行（不波及兄弟行）
 *
 * R-fix-NoteFoldersSidebar-handlers (perf, medium)：原版未 memo 包裹，
 * 父组件 NoteFoldersSidebar 任何 render 都让所有 UserFolderRow 跟着 re-render。
 * 现在加 React.memo + 自定义 comparator：忽略 handler 引用变化（行为依赖外部
 * store / setState，引用稳定即可；父组件已对 onOpenNote/onDeleteNote 等做了
 * useCallback）。关键数据字段变化（folder / children / hoverDrop /
 * renameId / renameText / hasSelectedChild）才触发重渲染。
 */
import { memo } from 'react'
import { useTreeExpansionStore, useTreeExpanded } from '../../../stores/treeExpansion'
import { FolderWithNotes } from './FolderWithNotes'
import type { UserFolderRowProps } from './types'

export const UserFolderRow = memo(
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
