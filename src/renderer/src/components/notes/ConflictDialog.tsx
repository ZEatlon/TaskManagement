/**
 * 冲突解决对话框
 *
 * 当 conflict 状态机检测到本地内存与磁盘内容不一致时弹出。
 * 提供三种解决方式：
 *   - 保留本地（keepLocal）：用本地版本覆盖磁盘
 *   - 保留远程（keepRemote）：丢弃本地改动，重新加载磁盘版本
 *   - 手动合并（merge）：在文本框中编辑合并结果后写入
 */
import { useEffect, useRef, useState } from 'react'
import { useNotesStore } from '../../stores/notes'
import { useFocusTrap } from '../../lib/useFocusTrap'

interface Props {
  open: boolean
  path: string
  /** 本地内存中的内容 */
  localContent: string
  /** 磁盘上的内容（由调用方读出后传入） */
  remoteContent: string
  onClose: () => void
}

export function ConflictDialog({ open, path, localContent, remoteContent, onClose }: Props) {
  const resolve = useNotesStore((s) => s.resolve)
  const [tab, setTab] = useState<'local' | 'remote' | 'merge'>('merge')
  const [merged, setMerged] = useState('')
  const prevOpenRef = useRef(false)
  // R12 修复 (high)：把焦点移动到默认"保留本地版本"按钮 + 记录原焦点以便
  // 关闭时恢复。键盘用户进入对话框后立即看到该按钮被聚焦，关闭后焦点回到
  // 触发处，不会丢失上下文。
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  // R6R-8：把 localContent/remoteContent 存到 ref —— deps 改为 [open]，effect 不再随
  // textarea 每次按键 / 自动保存触发；同时保留 ref.current 在打开时取最新值。
  const localContentRef = useRef(localContent)
  const remoteContentRef = useRef(remoteContent)

  // 把 props 同步到 ref（render 阶段即可，无需 effect）
  localContentRef.current = localContent
  remoteContentRef.current = remoteContent

  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    // 仅在 open 由 false 变为 true（即对话框刚打开）时重置合并内容，
    // 避免父组件重渲染（计时器、自动保存等）传入新的 localContent/remoteContent
    // 引用时，把用户已经编辑好的合并文本覆盖掉。
    if (open && !wasOpen) {
      // 记录打开前的焦点元素，关闭时恢复
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null
      setTab('merge')
      // 简单合并策略：本地在前，远程在后，附分隔线
      setMerged(
        `<<<<<<< LOCAL\n${localContentRef.current}\n=======\n${remoteContentRef.current}\n>>>>>>> REMOTE\n`,
      )
      // 移动焦点到默认 primary 按钮
      requestAnimationFrame(() => {
        primaryButtonRef.current?.focus()
      })
    }
    if (!open && wasOpen) {
      // 关闭时恢复焦点
      previouslyFocusedRef.current?.focus?.()
      previouslyFocusedRef.current = null
    }
  }, [open])

  // R6A-2：补 Escape 关闭 + 给 modal-overlay 加上 click-outside + ARIA dialog 语义
  //
  // R25-a11y-2 修复 (medium a11y-modal-layering)：原 Esc 监听挂在 window 上，
  // 与 SyncConfirmDialog R25 / ToolConfirmDialog R25 同样的多 modal 误触问题。
  // 修复：把 Esc 绑到 modal 根 div 的 onKeyDown。Focus trap 仍在 window 上
  // （Tab 循环必须全局可见）。
  const onModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      onClose()
    }
  }

  // R20 修复 (high a11y)：role=dialog + aria-modal 暗示模态，但缺 Tab 拦截
  // 键盘用户 Tab 出弹窗落到背景 notes 列表 / 编辑器 → 误触发删除/打开。
  // 共享 hook（useFocusTrap）已在 CommandBar / CreateNoteConfirmDialog 落地，
  // 这里把同一个 hook 接到 dialog 根 ref。
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useFocusTrap(dialogRef, open)

  if (!open) return null

  async function handleResolve(action: 'keepLocal' | 'keepRemote' | 'merge') {
    await resolve(path, action, action === 'merge' ? merged : undefined)
    onClose()
  }

  const filename = path.split(/[\\/]/).pop() ?? path

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id="conflict-dialog-title">冲突解决</h2>
          <button className="close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="muted">
            笔记 <code>{filename}</code> 在磁盘上发生了改动，
            与你本地的未保存编辑产生冲突。请选择一种处理方式：
          </p>

          <div className="conflict-tabs" role="tablist" aria-label="冲突解决方式">
            {/* R12 修复 (high)：conflict tabs 之前没有 role/aria-selected，
                屏幕阅读器无法识别当前选中的 tab。补齐 a11y 与方向键导航。 */}
            <button
              role="tab"
              aria-selected={tab === 'local'}
              tabIndex={tab === 'local' ? 0 : -1}
              className={`tab ${tab === 'local' ? 'active' : ''}`}
              onClick={() => setTab('local')}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  const order: Array<'local' | 'remote' | 'merge'> = ['local', 'remote', 'merge']
                  const idx = order.indexOf(tab)
                  const next = e.key === 'ArrowRight'
                    ? order[(idx + 1) % order.length]
                    : order[(idx - 1 + order.length) % order.length]
                  setTab(next)
                }
              }}
            >
              本地版本
            </button>
            <button
              role="tab"
              aria-selected={tab === 'remote'}
              tabIndex={tab === 'remote' ? 0 : -1}
              className={`tab ${tab === 'remote' ? 'active' : ''}`}
              onClick={() => setTab('remote')}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  const order: Array<'local' | 'remote' | 'merge'> = ['local', 'remote', 'merge']
                  const idx = order.indexOf(tab)
                  const next = e.key === 'ArrowRight'
                    ? order[(idx + 1) % order.length]
                    : order[(idx - 1 + order.length) % order.length]
                  setTab(next)
                }
              }}
            >
              磁盘版本
            </button>
            <button
              role="tab"
              aria-selected={tab === 'merge'}
              tabIndex={tab === 'merge' ? 0 : -1}
              className={`tab ${tab === 'merge' ? 'active' : ''}`}
              onClick={() => setTab('merge')}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  const order: Array<'local' | 'remote' | 'merge'> = ['local', 'remote', 'merge']
                  const idx = order.indexOf(tab)
                  const next = e.key === 'ArrowRight'
                    ? order[(idx + 1) % order.length]
                    : order[(idx - 1 + order.length) % order.length]
                  setTab(next)
                }
              }}
            >
              手动合并
            </button>
          </div>

          <div className="conflict-content">
            {tab === 'local' && (
              <pre className="diff local">{localContent}</pre>
            )}
            {tab === 'remote' && (
              <pre className="diff remote">{remoteContent}</pre>
            )}
            {tab === 'merge' && (
              <textarea
                className="merge-textarea"
                value={merged}
                onChange={(e) => setMerged(e.target.value)}
                spellCheck={false}
              />
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn" onClick={() => handleResolve('keepRemote')}>
            保留磁盘版本
          </button>
          {/* R12 修复 (high)：ref 聚焦到默认 primary 按钮（保留本地版本），
              让键盘用户进入对话框立即看到 Tab stop 与明确的"安全默认"操作。 */}
          <button ref={primaryButtonRef} className="btn" onClick={() => handleResolve('keepLocal')}>
            保留本地版本
          </button>
          <button className="btn primary" onClick={() => handleResolve('merge')}>
            应用合并结果
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConflictDialog
