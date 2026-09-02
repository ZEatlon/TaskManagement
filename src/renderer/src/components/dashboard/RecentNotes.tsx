/**
 * 最近编辑的笔记（Top 5）
 *
 * 数据：useNotesStore.notes（已按 filter / folderId 过滤），按 mtime DESC 排序。
 * 点击 → 跳转到 /notes 并通过 search.open(path) 让笔记编辑器打开该笔记。
 *
 * 父组件传入 notes 可（避免组件内直接订阅 store 引发多个 panel 各自触发 fetch）；
 * 不传则内部 useNotesStore 订阅。
 */
import { useCallback, useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FileText, Pin } from 'lucide-react'
import type { NoteMeta } from '@shared/types'
import { useNotesStore } from '../../stores/notes'

interface Props {
  notes?: NoteMeta[]
  /** 显示上限，默认 5 */
  limit?: number
}

export function RecentNotes({ notes: providedNotes, limit = 5 }: Props) {
  const navigate = useNavigate()
  const storeNotes = useNotesStore((s) => s.notes)
  const open = useNotesStore((s) => s.open)
  const setFilter = useNotesStore((s) => s.setFilter)
  const notes = providedNotes ?? storeNotes

  const recent = useMemo(() => {
    return [...notes]
      .sort((a, b) => (a.mtime > b.mtime ? -1 : a.mtime < b.mtime ? 1 : 0))
      .slice(0, limit)
  }, [notes, limit])

  const handleOpen = useCallback(
    async (path: string) => {
      await open(path)
      // 跳转 /notes —— NotePage 会读 currentPath 自动打开编辑器
      navigate({ to: '/notes' })
    },
    [open, navigate],
  )

  const handleViewAll = useCallback(() => {
    setFilter('all')
    navigate({ to: '/notes' })
  }, [setFilter, navigate])

  if (recent.length === 0) {
    return (
      <div className="recent-notes">
        <header className="card-header">
          <h3>最近编辑</h3>
        </header>
        <div className="empty-mini">还没有笔记 ✨</div>
      </div>
    )
  }

  return (
    <div className="recent-notes">
      <header className="card-header">
        <h3>最近编辑</h3>
        <button
          type="button"
          className="card-header-action muted small"
          onClick={handleViewAll}
        >
          全部笔记 →
        </button>
      </header>
      <ul className="recent-notes-list">
        {recent.map((n) => (
          <li key={n.id} className="recent-note-item">
            <button
              type="button"
              className="recent-note-btn"
              onClick={() => void handleOpen(n.path)}
              title={n.path}
            >
              <FileText size={14} aria-hidden className="recent-note-icon" />
              <span className="recent-note-title">{n.title || n.filename}</span>
              {n.isPinned && (
                <Pin
                  size={12}
                  aria-hidden
                  className="recent-note-pin"
                  fill="currentColor"
                />
              )}
              <span className="recent-note-mtime muted small">
                {formatMtime(n.mtime)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 格式化 mtime → 相对时间（≤7d 显示「Xd 前」；更早显示日期） */
function formatMtime(iso: string): string {
  const t = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = now - t
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}小时前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 7) return `${diffDay}天前`
  return new Date(iso).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  })
}

export default RecentNotes