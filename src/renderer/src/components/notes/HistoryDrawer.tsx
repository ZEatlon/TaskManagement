/**
 * W2-A④ 版本历史 drawer
 *
 * 从 NoteEditor 顶栏「历史」按钮触发；从右侧滑入。
 *
 * 数据流：
 *   list-revisions(noteId)  → Array<{id, noteId, createdAt, length, source}>
 *   read-revision(id)       → {content, frontmatter}
 *   restore-revision(id)    → 触发 note:write 把 revision 内容写回（写之前
 *                              writeNote 会 snapshot 当前到 revisions，所以
 *                              「还原」就是「旧版留底 + 新版 = revision 内容」）
 *
 * 关闭条件：点击 backdrop / Esc / 选中某 revision 后点击「关闭」。
 *
 * 性能：每次打开重新拉列表（cheap，单 note ≤ 50 条）；详情按需读全文。
 */
import { useEffect, useState } from 'react'
import { X, History, RotateCcw } from '@renderer/lib/icon'
import { notesApi } from '../../lib/ipc'
import { announce } from '../common/AriaAnnouncer'

export interface RevisionSummary {
  id: number
  noteId: string
  createdAt: string
  length: number
  source: 'auto' | 'manual'
}

interface HistoryDrawerProps {
  open: boolean
  noteId: string | null
  noteTitle?: string
  onClose: () => void
  /** restore-revision 成功后父组件需要重新拉当前笔记内容 —— 由 store 自行处理 */
  onRestored?: () => void
}

interface LoadedRevision extends RevisionSummary {
  content: string
  frontmatter: string
}

export function HistoryDrawer({
  open,
  noteId,
  noteTitle,
  onClose,
  onRestored,
}: HistoryDrawerProps) {
  const [revisions, setRevisions] = useState<RevisionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<LoadedRevision | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 打开 / noteId 变化时重新拉列表
  useEffect(() => {
    if (!open || !noteId) {
      setRevisions([])
      setSelected(null)
      return
    }
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const list = await notesApi.listRevisions(noteId)
        if (!cancelled) setRevisions(list)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, noteId])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  async function handleSelect(rev: RevisionSummary) {
    if (!noteId) return
    setLoadingDetail(true)
    setError(null)
    try {
      const detail = await notesApi.readRevision(rev.id)
      if (!detail) {
        setError(`revision ${rev.id} 不存在`)
        setSelected(null)
      } else {
        setSelected({ ...rev, content: detail.content, frontmatter: detail.frontmatter })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingDetail(false)
    }
  }

  async function handleRestore() {
    if (!selected) return
    setRestoring(true)
    setError(null)
    try {
      await notesApi.restoreRevision(selected.id)
      announce(`已还原到 ${formatTimestamp(selected.createdAt)} 的版本`)
      onRestored?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(false)
    }
  }

  if (!open) return null

  return (
    <div className="history-drawer-root">
      <button
        type="button"
        className="history-drawer-backdrop"
        aria-label="关闭历史面板"
        onClick={onClose}
      />
      <aside
        className="history-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-drawer-title"
      >
        <header className="history-drawer-header">
          <h3 id="history-drawer-title" className="history-drawer-title">
            <History size={16} aria-hidden />
            版本历史
            {noteTitle && <span className="muted"> · {noteTitle}</span>}
          </h3>
          <button
            type="button"
            className="history-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="history-drawer-body">
          <ul className="history-revision-list" aria-label="历史快照列表">
            {loading && (
              <li className="history-empty muted">加载中…</li>
            )}
            {!loading && revisions.length === 0 && (
              <li className="history-empty muted">
                这条笔记还没有历史快照。保存后会在改写前自动 snapshot。
              </li>
            )}
            {!loading && revisions.map((rev) => {
              const isSelected = selected?.id === rev.id
              return (
                <li key={rev.id}>
                  <button
                    type="button"
                    className={`history-revision-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleSelect(rev)}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <span className="history-revision-time">
                      {formatTimestamp(rev.createdAt)}
                    </span>
                    <span className="history-revision-meta">
                      <span className={`history-source history-source-${rev.source}`}>
                        {rev.source === 'manual' ? '手动' : '自动'}
                      </span>
                      <span className="history-revision-length muted">
                        {formatLength(rev.length)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="history-revision-detail">
            {error && <div className="history-error" role="alert">{error}</div>}
            {loadingDetail && <div className="history-empty muted">加载详情…</div>}
            {!loadingDetail && !selected && (
              <div className="history-empty muted">
                从左侧选一个版本查看正文预览。
              </div>
            )}
            {selected && (
              <>
                <div className="history-revision-detail-head">
                  <span className="muted">
                    {formatTimestamp(selected.createdAt)} ·{' '}
                    {selected.source === 'manual' ? '手动保存' : '自动 snapshot'}
                  </span>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={handleRestore}
                    disabled={restoring}
                    title="把当前笔记还原为此版本的内容（旧版本会自动留底）"
                  >
                    <RotateCcw size={14} aria-hidden />
                    {restoring ? '还原中…' : '还原为当前版本'}
                  </button>
                </div>
                <pre className="history-revision-content">{selected.content}</pre>
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

function formatTimestamp(iso: string): string {
  // 与界面其他时间格式一致：本地时区 + 中文 locale
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatLength(n: number): string {
  if (n < 1024) return `${n} 字符`
  return `${(n / 1024).toFixed(1)} KB`
}
