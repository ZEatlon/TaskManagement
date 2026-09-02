/**
 * 同步确认对话框
 *
 * 用途：
 *   在 GitStatusBadge 或其他入口触发"立即同步"时弹出，
 *   让用户确认要提交的文件列表与 commit message。
 *
 * 展示内容：
 *   - 待提交文件清单（modified + untracked），最大显示 20 条
 *   - 默认 commit message（用户可编辑）
 *   - 远程地址（用于推送提示）
 *   - 确认 / 取消按钮
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useGitStore } from '../../stores/git'
import { useFocusTrap } from '../../lib/useFocusTrap'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: (message: string) => Promise<{ ok: boolean; error?: string }>
}

/** 生成默认 commit message（与 autoSync / store 保持一致） */
function buildDefaultMessage(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `chore: sync notes ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** 文件清单显示上限 */
const FILE_LIMIT = 20

export function SyncConfirmDialog({ open, onClose, onConfirm }: Props) {
  const status = useGitStore((s) => s.status)
  const refresh = useGitStore((s) => s.refresh)
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // R12 修复 (medium)：打开对话框时把焦点放到「确认同步」按钮 + 关闭时还原。
  // 没有这个 guard，键盘用户必须 Tab 一圈才能到主要动作。
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // R25-a11y-1 修复 (high a11y-keyboard)：原版 role='dialog' + aria-modal=true
  // 但没有 useFocusTrap → 键盘用户 Tab 一次就穿透 modal 落到 AppHeader /
  // GitStatusBadge / 背后的 sticky timeline（DOM 中这些元素并未 unmount，
  // 仅被 overlay 视觉遮挡）。Git 同步是「不可逆」动作（commit + push），
  // 误触背景 nav 元素危险性高。WCAG 2.1.2 No Keyboard Trap 反面（无 containment）。
  useFocusTrap(dialogRef, true)

  // 打开时刷新状态、重置 message
  useEffect(() => {
    if (!open) return
    setMessage(buildDefaultMessage())
    setError(null)
    void refresh()
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null
    const id = window.requestAnimationFrame(() => {
      confirmButtonRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(id)
  }, [open, refresh])

  // R6A-4：补 Escape 关闭（提交 + 推送是不可逆动作，必须能被键盘取消）。
  //
  // R25-a11y-2 修复 (medium a11y-modal-layering)：原 Esc 监听挂在 window 上。
  // 与 ConflictDialog / ToolConfirmDialog 同样的问题：当多个 modal 同帧
  // 挂载（git sync + AI tool confirm + CreateNoteConfirmDialog 同时开），
  // 任意 modal 的 window-level Esc 都会误触其它 modal 的关闭。修复：把
  // Esc 监听绑到 modal 根 div 的 onKeyDown，与 LibraryMissingDialog R24-a11y-2
  // + ConflictDialog 一致。Focus trap 仍在 window 上（Tab 循环必须全局可见）。
  const onModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      onClose()
    }
  }

  // R12 修复 (medium)：关闭时把焦点还给之前打开 dialog 的触发元素。
  useEffect(() => {
    if (open) return
    const prev = previouslyFocusedRef.current
    if (prev && document.contains(prev)) {
      prev.focus()
    }
    previouslyFocusedRef.current = null
  }, [open])

  const files = useMemo(() => {
    if (!status) return []
    const seen = new Set<string>()
    const all: { path: string; kind: 'modified' | 'untracked' }[] = []
    for (const p of status.modified) {
      if (!seen.has(p)) {
        seen.add(p)
        all.push({ path: p, kind: 'modified' })
      }
    }
    for (const p of status.untracked) {
      if (!seen.has(p)) {
        seen.add(p)
        all.push({ path: p, kind: 'untracked' })
      }
    }
    return all
  }, [status])

  const hasChanges = files.length > 0
  const truncated = files.length > FILE_LIMIT
  const visible = truncated ? files.slice(0, FILE_LIMIT) : files

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await onConfirm(message.trim() || buildDefaultMessage())
      if (result.ok) {
        onClose()
      } else {
        setError(result.error ?? '同步失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal sync-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-confirm-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id="sync-confirm-title">确认同步</h2>
          <button className="close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="modal-body">
          {!status ? (
            <div className="muted">正在读取仓库状态…</div>
          ) : !status.hasRemote ? (
            <div className="sync-warn">
              ⚠ 当前仓库未配置远程地址，仅会创建本地提交，不会推送到任何远端。
            </div>
          ) : null}

          <section className="sync-section">
            <h3 className="sync-section-title">
              待提交文件 <span className="muted">（{files.length}）</span>
            </h3>
            {!hasChanges ? (
              <div className="muted">无变更可提交</div>
            ) : (
              <ul className="sync-file-list">
                {visible.map((f) => (
                  <li key={f.path} className={`sync-file sync-file-${f.kind}`}>
                    <span className="sync-file-kind">
                      {f.kind === 'modified' ? 'M' : '?'}
                    </span>
                    <span className="sync-file-path">{f.path}</span>
                  </li>
                ))}
                {truncated && (
                  <li className="muted sync-file-more">
                    还有 {files.length - FILE_LIMIT} 个文件未显示…
                  </li>
                )}
              </ul>
            )}
          </section>

          <section className="sync-section">
            <label className="field">
              <span>提交信息</span>
              <textarea
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="commit message"
              />
            </label>
            <div className="muted" style={{ marginTop: 4 }}>
              {status?.hasRemote
                ? '提交后将自动推送到 origin/main'
                : '当前为本地提交，不会推送'}
            </div>
          </section>

          {error && <div className="sync-error">{error}</div>}
        </div>

        <footer className="modal-footer">
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            className="btn primary"
            ref={confirmButtonRef}
            onClick={submit}
            disabled={submitting || (!hasChanges && !status?.hasRemote)}
          >
            {submitting ? '同步中…' : '确认同步'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default SyncConfirmDialog
