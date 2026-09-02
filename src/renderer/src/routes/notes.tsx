/**
 * 笔记主页（/notes）
 *
 * Round 5 布局：
 *   左（笔记列表 NotesTree） | 中（编辑器 NoteEditor） | 右（元数据 NoteMetaPanel + 标签 RightTagsPanel）
 *   - NotesTree 内：搜索 + 过滤 tab + 文件夹 + 文件列表（合并显示）
 *   - 右侧 aside 垂直堆叠 NoteMetaPanel（顶部）和 RightTagsPanel（底部）
 *
 * 启动时：
 *   - 调用 note:watch-start 启动文件监听
 *   - 订阅 note:fs-event，外部文件变更时刷新列表
 *
 * 左右侧栏可通过 header 上的 ⟨ / ⟩ 按钮独立折叠，状态持久化到 localStorage。
 */
import { useEffect, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useNotesStore } from '../stores/notes'
import { useAppStore } from '../stores/app'
import {
  NotesTree,
  NoteEditor,
  NoteMetaPanel,
  RightTagsPanel,
  ConflictDialog,
} from '../components/notes'

export function NotesRoute() {
  const search = useSearch({ from: '/notes' }) as { open?: string | null }
  const currentPath = useNotesStore((s) => s.currentPath)
  const currentNote = useNotesStore((s) => s.currentNote)
  const draftContent = useNotesStore((s) => s.draftContent)
  const fileState = useNotesStore((s) =>
    currentPath ? s.fileStates[currentPath] : undefined,
  )
  const fetch = useNotesStore((s) => s.fetch)
  const open = useNotesStore((s) => s.open)

  // 左右侧栏折叠状态（持久化）
  const leftCollapsed = useAppStore((s) => s.notesLeftCollapsed)
  const rightCollapsed = useAppStore((s) => s.notesRightCollapsed)
  const toggleLeft = useAppStore((s) => s.toggleNotesLeftSidebar)
  const toggleRight = useAppStore((s) => s.toggleNotesRightSidebar)

  const [conflictOpen, setConflictOpen] = useState(false)
  const [remoteContent, setRemoteContent] = useState('')

  // 初次挂载：拉取列表 + 启动监听
  useEffect(() => {
    void fetch()
    void window.api.invoke('note:watch-start', undefined).catch(() => {})
  }, [fetch])

  // 订阅文件事件：add/change/unlink 时刷新列表
  useEffect(() => {
    const off = window.api.on('note:fs-event', (_e, payload: unknown) => {
      const ev = payload as { type: string; path?: string }
      if (ev.type === 'add' || ev.type === 'change' || ev.type === 'unlink') {
        // 列表数据由主进程 chokidar 自动更新仓储，这里重新拉一次
        void fetch()
        if (ev.path && ev.path === currentPath && ev.type === 'change') {
          // 当前打开的文件在磁盘被外部修改 → 标记 conflict
          // ConflictDialog 会在 fileState === 'conflict' 时自动弹出
        }
      }
    })
    return () => off()
  }, [fetch, currentPath])

  // 当进入 conflict 状态时拉取磁盘内容（用于对话框展示 remote）
  useEffect(() => {
    if (fileState === 'conflict' && currentPath) {
      void window.api
        .invoke<string, { content: string } | null>('note:read', currentPath)
        .then((n) => setRemoteContent(n?.content ?? ''))
        .catch(() => setRemoteContent(''))
      setConflictOpen(true)
    } else {
      setConflictOpen(false)
    }
  }, [fileState, currentPath])

  // 处理来自 Dashboard 的「打开指定笔记」请求（?open=path）
  useEffect(() => {
    const target = search?.open
    if (target && target !== currentPath) {
      void open(target)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.open, currentPath])

  const layoutClasses = [
    'notes-layout',
    leftCollapsed ? 'left-collapsed' : '',
    rightCollapsed ? 'right-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="notes-page">
      <div className={layoutClasses}>
        <aside className={['notes-sidebar', leftCollapsed ? 'collapsed' : ''].filter(Boolean).join(' ')}>
          <NotesTree />
          <button
            type="button"
            className="notes-rail-handle"
            onClick={toggleLeft}
            title={leftCollapsed ? '展开左侧笔记列表' : '折叠左侧笔记列表'}
            aria-label={leftCollapsed ? '展开左侧笔记列表' : '折叠左侧笔记列表'}
            aria-pressed={leftCollapsed}
          />
        </aside>

        <main className="notes-main">
          <NoteEditor path={currentPath} />
        </main>

        <aside className={['notes-aside', rightCollapsed ? 'collapsed' : ''].filter(Boolean).join(' ')}>
          {currentNote ? (
            <NoteMetaPanel noteId={currentNote.id} />
          ) : (
            <div className="aside-empty muted">选择笔记后展示元数据</div>
          )}
          {/* 标签管理面板（始终显示，无论是否选中笔记） */}
          <RightTagsPanel />
          <button
            type="button"
            className="notes-rail-handle"
            onClick={toggleRight}
            title={rightCollapsed ? '展开右侧元数据' : '折叠右侧元数据'}
            aria-label={rightCollapsed ? '展开右侧元数据' : '折叠右侧元数据'}
            aria-pressed={rightCollapsed}
          />
        </aside>
      </div>

      {currentPath && (
        <ConflictDialog
          open={conflictOpen}
          path={currentPath}
          localContent={draftContent ?? currentNote?.content ?? ''}
          remoteContent={remoteContent}
          onClose={() => setConflictOpen(false)}
        />
      )}
    </div>
  )
}

export default NotesRoute
