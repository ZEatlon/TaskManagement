/**
 * 工具调用确认对话框
 *
 * AI 助手请求执行有副作用或破坏性的工具（createSticky / updateSticky /
 * completeSticky 等）时，主进程会暂停工具循环并通过 requires_confirmation
 * 事件通知渲染端。Store 把请求暂存在 pendingConfirm；本组件订阅并弹出
 * 用户确认。
 *
 * 关键交互：
 *   - 必须有焦点管理（dialog open 时聚焦"允许"按钮）
 *   - Esc / 关闭 = dismiss（拒绝）
 *   - "允许" = acceptPendingConfirm，store 转发 aiApi.confirmTool 给主进程
 *
 * 关联 R13 修复 (high)：见 stores/ai.ts 中 acceptPendingConfirm/dismissPendingConfirm
 * 历史从未被任何 UI 调用的根因。
 */
import { useEffect, useId, useRef } from 'react'
import type { PendingConfirm } from '../../stores/ai'
import { useFocusTrap } from '../../lib/useFocusTrap'

interface Props {
  pending: PendingConfirm
  onAccept: () => void
  onDismiss: () => void
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

export function ToolConfirmDialog({ pending, onAccept, onDismiss }: Props) {
  const acceptRef = useRef<HTMLButtonElement | null>(null)
  // R23-Corr-3 修复 (medium a11y)：原版在 [pending.toolCallId] 副作用里捕获
  // previouslyFocusedRef，结果：dialog A 渲染时把焦点移到 A 的"允许"按钮 →
  // 用户没来得及关，pending 切成 B 触发重新渲染 → 副作用再跑一次，捕获的
  // 「之前焦点」变成 A 的"允许"按钮本身（已聚焦的那个），而非打开弹窗前
  // 的真正来源元素（聊天输入框 / 快捷键调用方）。最终弹窗关闭时焦点还原
  // 失败（target 已不在 document 里）。
  //
  // 修复：拆成两个 effect。effect#1 仅在挂载时记录**真正的原始焦点**（一次，
  // 不再覆盖）；effect#2 仅在 toolCallId 变化时把焦点搬到「允许」按钮。
  // 卸载时的焦点还原只读 ref 不再写入。
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  // R21 修复 (low a11y)：补 useFocusTrap 防止 Tab 把焦点送出 modal。
  useFocusTrap(dialogRef, true)

  // effect#1：仅挂载时记录原始焦点（空 deps，永不重写）。
  useEffect(() => {
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null
  }, [])

  // effect#2：toolCallId 变化时把焦点搬到"允许"按钮（不重写 previouslyFocusedRef）。
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      acceptRef.current?.focus()
    })
    return () => {
      window.cancelAnimationFrame(id)
    }
  }, [pending.toolCallId])

  // R25-a11y-3 修复 (medium a11y-modal-layering)：原 Esc 监听挂在 window
  // 上。当 ToolConfirmDialog 与 CreateNoteConfirmDialog / CommandBar /
  // LibraryMissingDialog / ConflictDialog 同帧挂载时（AI 流中多个确认并存
  // 是常态），任意 modal 的 window-level Esc 都会误触其它 modal 的关闭。
  // 修复：把 Esc 绑到 modal 根 div 的 onKeyDown，与 LibraryMissingDialog R24 +
  // SyncConfirmDialog R25 一致。Focus trap 仍在 window 上（Tab 循环必须
  // 全局可见）。
  const onModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      onDismiss()
    }
  }

  // 卸载时还原焦点（pending 清空 → 父组件移除本组件 → 这里 unmount 触发）。
  useEffect(() => {
    return () => {
      const prev = previouslyFocusedRef.current
      if (prev && document.contains(prev)) {
        prev.focus()
      }
    }
  }, [])

  const isDestructive = pending.risk === 'destructive'

  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div
        ref={dialogRef}
        className="modal tool-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id={titleId}>
            {isDestructive ? '⚠ 危险操作确认' : 'AI 助手请求权限'}
          </h2>
          <button className="close" onClick={onDismiss} aria-label="关闭">×</button>
        </header>

        <div className="modal-body">
          <p className="tool-confirm-summary">{pending.summary}</p>
          <details className="tool-confirm-args">
            <summary>查看参数（{pending.toolName}）</summary>
            <pre>{formatArgs(pending.args)}</pre>
          </details>
          <p className="muted small">
            AI 助手正在请求执行一个有副作用的操作。你可以选择允许或拒绝。
          </p>
        </div>

        <footer className="modal-footer">
          <button className="btn ghost" onClick={onDismiss}>拒绝</button>
          <button
            ref={acceptRef}
            className={`btn ${isDestructive ? 'danger' : 'primary'}`}
            onClick={onAccept}
          >
            {isDestructive ? '我了解风险，允许' : '允许'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default ToolConfirmDialog