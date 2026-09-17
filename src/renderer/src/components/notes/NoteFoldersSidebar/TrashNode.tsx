/**
 * W2-A④ Trash 节点 —— sidebar 底部固定行
 *
 * 与 user folder 不同：
 *   - 不支持 drop（trash 接受来自 editor 的删除操作；不在本节点里挂 drop）
 *   - 不支持重命名 / 删除（trash 是系统功能）
 *   - 选中后由 NotesTree 把主区切到「回收站列表」
 *   - 显示当前 trashed 数量徽标（调用 notesApi.listTrash 异步拉）
 *
 * Props 通过 props 注入而非 zustand，避免父组件重渲染。
 */
import { memo, useEffect, useState } from 'react'
import { IconTrash } from '@tabler/icons-react'
import { notesApi } from '../../../lib/ipc'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { EMPTY_TRASH_COUNT } from './types'

interface TrashNodeProps {
  /** 'trash' 表示已进入回收站视图。 */
  active: boolean
  onOpen: () => void
  /** 「清空回收站」按钮点击后弹出二次确认 → 确认后触发。 */
  onPurgeAll: () => Promise<void>
  /** NotesTree 通过 dirty bit 通知本节点重新拉取数量（trash 操作后）。 */
  refreshKey: number
}

function TrashNodeImpl({ active, onOpen, onPurgeAll, refreshKey }: TrashNodeProps) {
  const [count, setCount] = useState(EMPTY_TRASH_COUNT)
  const [confirmingPurge, setConfirmingPurge] = useState(false)

  // 拉取 + 监听 refreshKey 变化（trash 后立即刷新）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await notesApi.listTrash()
        if (!cancelled) setCount(list.length)
      } catch {
        // 拉取失败不影响主显示 —— 徽标留 0
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  return (
    <div className="trash-node-row">
      <button
        className={`folder-row trash-row ${active ? 'active' : ''}`}
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        title="查看回收站中的笔记"
        type="button"
      >
        <IconTrash size={14} aria-hidden />
        <span className="trash-label">回收站</span>
        {count > 0 && <span className="trash-badge" aria-label={`${count} 条已删除`}>{count}</span>}
      </button>
      {count > 0 && (
        <button
          className="trash-purge-btn"
          onClick={() => setConfirmingPurge(true)}
          title="永久清空回收站"
          aria-label="永久清空回收站"
          type="button"
        >
          清空
        </button>
      )}
      <ConfirmDialog
        open={confirmingPurge}
        title="永久清空回收站"
        body="回收站里的所有笔记将被永久删除（磁盘文件 + 数据库 + 版本历史），无法恢复。是否继续？"
        confirmLabel="永久删除"
        tone="danger"
        onCancel={() => setConfirmingPurge(false)}
        onConfirm={async () => {
          setConfirmingPurge(false)
          await onPurgeAll()
        }}
      />
    </div>
  )
}

// Memo comparator：refreshKey 必查；其他 props 都是稳定引用或 primitive。
export const TrashNode = memo(TrashNodeImpl, (prev, next) => {
  return (
    prev.active === next.active &&
    prev.onOpen === next.onOpen &&
    prev.onPurgeAll === next.onPurgeAll &&
    prev.refreshKey === next.refreshKey
  )
})
