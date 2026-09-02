/**
 * 库目录丢失弹窗
 *
 * 触发条件：settings.libraryPath 有值，但该目录当前不可访问
 * （用户删了 / 移动了 / 卸载了挂载点）。
 *
 * 提供三种处置：
 *   1. 重新选择目录（→ 走 wizard 重新初始化）
 *   2. 清除库路径（回到 first-run 状态）
 *   3. 取消（关闭弹窗，由用户自行处理）
 */
import { useEffect, useRef } from 'react'
import { useState } from 'react'
import { libraryApi } from '@renderer/lib/ipc'
import { useSettingsStore } from '@renderer/stores/settings'
import { useFocusTrap } from '@renderer/lib/useFocusTrap'

interface Props {
  /** 失效的库路径 */
  missingPath: string
  /** 关闭弹窗（不做修改） */
  onClose: () => void
  /** 用户选择重新指定目录，新路径回调 */
  onReselect: (newPath: string) => void
}

export function LibraryMissingDialog({ missingPath, onClose, onReselect }: Props) {
  const setLibraryPath = useSettingsStore((s) => s.setLibraryPath)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // R12 修复 (high)：原版 dialog 没有 aria-modal / Esc / overlay click /
  // focus 移动。补齐完整 a11y 行为。
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // R21 修复 (low a11y)：补 useFocusTrap 防止 Tab 把焦点送出 modal
  // 落到背后的 LibraryPathPicker / 其它 background UI。
  useFocusTrap(dialogRef, true)

  // R24-a11y-2 修复 (high a11y-keyboard)：原版 Esc 监听挂在 window 上。
  // 与 CreateNoteConfirmDialog R18 同问题：所有 modal 同时挂载时（LibraryMissingDialog
  // + CommandBar / PomodoroStart / Setting 编辑），任意 modal 的 Esc 都会把其它
  // modal 一同关闭；并且 useStickyShortcuts 的单字母快捷键在 LibraryMissingDialog
  // 打开时仍会被 window 监听转发，按 'e' 期望无操作反而触发了 onArchiveFocused
  // 之类。修复：把 onKeyDown 绑到 modal 根 div（与 CreateNoteConfirmDialog R18
  // 模式一致），事件只在 modal 处于 focus 路径里时触发；其它 modal 仍按自己
  // 状态保留。Focus trap 仍挂在 window 上（tab 循环必须全局可见）。
  const onModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      onClose()
    }
  }
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => primaryButtonRef.current?.focus())
    return () => {
      // R25-Corr-5 修复 (medium a11y-focus-return)：原版直接 focus() 而
      // 不验证节点是否还在文档里。LibraryMissingDialog 打开时如果触发元素
      // 所在的父级组件同时被卸载（例如 nav 路由切走、FirstRunWizard 完
      // 成 → onComplete → 父级 unmount），ref 里捕获的 activeElement
      // 此刻已经 detached。focus() 一个 detached 节点会抛错（DOMException）
      // 或静默 no-op，焦点滞留在 document.body 上，后续键盘 Tab 进入未
      // 知位置。修复：focus 前先 document.contains 检查。
      const prev = previouslyFocusedRef.current
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus()
      }
    }
  }, [onClose])

  const handleReselect = async () => {
    setBusy(true)
    setError(null)
    try {
      const picked = await libraryApi.selectDirectory()
      if (!picked) {
        setBusy(false)
        return
      }
      const v = await libraryApi.validate(picked)
      if (!v.valid) {
        setError(v.reason ?? '所选目录不可用')
        setBusy(false)
        return
      }
      await libraryApi.initialize(picked)
      await setLibraryPath(picked)
      onReselect(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    setBusy(true)
    try {
      await libraryApi.clear()
      // 清空后通过 store 同步
      await setLibraryPath(null)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id="missing-title">⚠ 库目录不可访问</h2>
        </header>

        <div className="modal-body">
          <p>
            上次设置的库目录当前不可访问：
          </p>
          <code className="missing-path">{missingPath}</code>
          <p className="muted">
            可能的原因：目录已被移动 / 删除 / 重命名，或所在磁盘未挂载。
            TaskPilot 暂时无法访问你的数据。
          </p>

          {error && (
            <div className="error-box" role="alert">
              <strong>操作失败</strong>
              <p>{error}</p>
            </div>
          )}

          <p>请选择如何继续：</p>
          <ul className="missing-help">
            <li><strong>重新选择</strong>：挑选一个新目录作为库</li>
            <li><strong>清除库路径</strong>：回到首次启动状态，下次启动会再次提示</li>
            <li><strong>稍后</strong>：先恢复目录（如重新插上移动硬盘）再回来</li>
          </ul>
        </div>

        <footer className="modal-footer">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            稍后
          </button>
          <button className="btn" onClick={handleClear} disabled={busy}>
            清除库路径
          </button>
          <button
            ref={primaryButtonRef}
            className="btn primary"
            onClick={handleReselect}
            disabled={busy}
          >
            {busy ? '处理中…' : '重新选择…'}
          </button>
        </footer>
      </div>
    </div>
  )
}
