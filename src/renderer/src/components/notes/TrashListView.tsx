/**
 * W2-A④ 回收站列表 —— 当 NotesTree 切到 trash 视图时替换主区
 *
 * 数据：notesApi.listTrash() → NoteMeta[]
 * 操作：每行提供「还原」「永久删除」「打开（只读）」三个按钮。
 *
 * 设计取舍：
 *   - 不复用 NotesTree 的搜索 / filter tab —— 回收站不需要这些。
 *   - 不在主进程 store 持久化 trashed 列表，每次进入重新拉。
 *   - 操作完成后回调 onChanged → NotesTree 自增 trashRefreshKey → TrashNode
 *     重新拉计数 + 视图重新拉列表。
 */
import { memo, useEffect, useState } from 'react'
import type { NoteMeta } from '@shared/types'
import { Trash, RotateCcw } from '@renderer/lib/icon'
import { notesApi } from '../../lib/ipc'
import { ConfirmDialog } from '../common/ConfirmDialog'

interface TrashListViewProps {
  onChanged: () => void
  /** 用户在回收站点开某条 —— 不真正编辑，只读预览（避免编辑后又得手动 trash）。 */
  onPreview?: (note: NoteMeta) => void
}

interface PendingPurge {
  path: string
  title: string
}

function TrashListViewImpl({ onChanged, onPreview }: TrashListViewProps) {
  const [items, setItems] = useState<NoteMeta[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pendingPurge, setPendingPurge] = useState<PendingPurge | null>(null)
  const [workingPath, setWorkingPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await notesApi.listTrash()
        if (!cancelled) {
          setItems(list)
          setLoadError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
          setItems([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleRestore(path: string) {
    setWorkingPath(path)
    try {
      await notesApi.restore(path)
      // 本地移除：避免再走一次 listTrash
      setItems((prev) => (prev ? prev.filter((n) => n.path !== path) : prev))
      onChanged()
    } finally {
      setWorkingPath(null)
    }
  }

  async function handlePurge() {
    if (!pendingPurge) return
    setWorkingPath(pendingPurge.path)
    try {
      await notesApi.purge(pendingPurge.path)
      setItems((prev) =>
        prev ? prev.filter((n) => n.path !== pendingPurge.path) : prev,
      )
      onChanged()
    } finally {
      setWorkingPath(null)
      setPendingPurge(null)
    }
  }

  if (items === null && !loadError) {
    return (
      <div className="trash-list-view">
        <div className="trash-list-empty muted">加载中…</div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="trash-list-view">
        <div className="trash-list-empty error" role="alert">
          加载失败：{loadError}
        </div>
      </div>
    )
  }

  if (items === null) {
    // TS 收窄：上面「items === null && !loadError」分支已返回；这里理论上不可达
    // —— 留作安全网，渲染空态。
    return (
      <div className="trash-list-view">
        <div className="trash-list-empty muted">回收站为空</div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="trash-list-view">
        <div className="trash-list-empty muted">
          <Trash size={20} aria-hidden />
          <p>回收站为空</p>
          <p className="muted small">被删的笔记会出现在这里，可以还原或永久删除。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="trash-list-view">
      <ul className="trash-list" aria-label="回收站笔记列表">
        {items.map((n) => {
          const working = workingPath === n.path
          return (
            <li key={n.path} className="trash-list-row">
              <button
                type="button"
                className="trash-list-title"
                onClick={() => onPreview?.(n)}
                title="只读预览"
              >
                <Trash size={12} aria-hidden />
                <span className="trash-list-title-text">{n.title || n.filename}</span>
              </button>
              <div className="trash-list-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => handleRestore(n.path)}
                  disabled={working}
                  title="把笔记还原到原位置"
                >
                  <RotateCcw size={12} aria-hidden />
                  还原
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => setPendingPurge({ path: n.path, title: n.title || n.filename })}
                  disabled={working}
                  title="永久删除（磁盘文件 + DB 行 + 版本历史一并清除）"
                >
                  永久删除
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <ConfirmDialog
        open={pendingPurge !== null}
        title="永久删除"
        body={
          pendingPurge
            ? `确认永久删除「${pendingPurge.title}」？磁盘文件 + 数据库行 + 版本历史都会被清除，无法恢复。`
            : ''
        }
        confirmLabel="永久删除"
        tone="danger"
        onCancel={() => setPendingPurge(null)}
        onConfirm={handlePurge}
      />
    </div>
  )
}

export const TrashListView = memo(TrashListViewImpl, (prev, next) => {
  return prev.onChanged === next.onChanged && prev.onPreview === next.onPreview
})
