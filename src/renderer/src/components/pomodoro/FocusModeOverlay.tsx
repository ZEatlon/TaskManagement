/**
 * 专注模式（Focus Mode）全屏遮罩
 *
 * 设计目标：
 *   - 全屏半透明遮罩（z-index 9999，背景 var(--color-bg-base) + backdrop blur）
 *   - 只显示一个极简大时钟 + 模式文字 + 右上角小 × 关闭按钮
 *   - 关闭 → 调 store.setFocusMode(false)；主进程若同时 stop service，会再
 *     推一次 focus-mode-changed 事件，store 保持 false 幂等。
 *
 * 数据订阅：拆分 timer / control 两个切片，时钟只依赖 timer（每秒重渲染），
 * 关闭按钮不依赖高频数据，避免每秒整个 overlay 重渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@renderer/lib/icon'
import { usePomodoroStore } from '../../stores/pomodoro'
import { formatMmSs } from '../../lib/formatDate'
import { useFocusTrap } from '../../lib/useFocusTrap'

interface Props {
  /** 退出回调（store.setFocusMode(false) + 可选主进程 stop） */
  onExit: () => void
}

/** 极简时钟：只订阅 timer.remainingSec，1Hz 更新即可 */
const MinimalClock = memo(function MinimalClock({ remainingSec }: { remainingSec: number }) {
  const text = useMemo(() => formatMmSs(remainingSec), [remainingSec])
  return <div className="focus-mode-clock">{text}</div>
})

/** 模式文本：低频更新（mode / cycleIndex 变化时才变） */
const ModeLabel = memo(function ModeLabel({ mode, cycleIndex }: {
  mode: 'focus' | 'shortBreak' | 'longBreak'
  cycleIndex: number
}) {
  const label =
    mode === 'focus' ? '专注中' :
    mode === 'longBreak' ? '长休中' :
    '短休中'
  return (
    <div className="focus-mode-label">
      <span className="focus-mode-tag">{label}</span>
      {mode === 'focus' && (
        <span className="focus-mode-cycle">第 {cycleIndex + 1} 轮</span>
      )}
    </div>
  )
})

export function FocusModeOverlay({ onExit }: Props): JSX.Element | null {
  // 拆分订阅：control 只在 mode/cycleIndex 变时重渲；timer 只每秒重渲
  const mode = usePomodoroStore((s) => s.control.mode)
  const cycleIndex = usePomodoroStore((s) => s.control.cycleIndex)
  const remainingSec = usePomodoroStore((s) => s.timer.remainingSec)

  // R29 修复 (high a11y)：aria-modal 弹窗必须
  //   1) 把 Tab 焦点圈在弹窗内（useFocusTrap），
  //   2) 关闭时把焦点还原给打开前的触发元素（previouslyFocusedRef）。
  // 否则用户在 /today 关闭 FocusModeOverlay 后焦点丢失到 body，
  // 下一次按键（尤其 `n`）会直接穿过到背景 QuickCaptureOverlay 触发器。
  const overlayRef = useRef<HTMLDivElement | null>(null)
  // 仅挂载时记录一次真正的原始焦点（不随重渲染覆盖）。
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  useFocusTrap(overlayRef, true)

  // effect#1：仅挂载时记录原始焦点（空 deps，永不重写）。
  useEffect(() => {
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null
  }, [])

  // effect#2：卸载时还原焦点。
  useEffect(() => {
    return () => {
      const prev = previouslyFocusedRef.current
      if (prev && document.contains(prev)) {
        prev.focus()
      }
    }
  }, [])

  const handleExit = useCallback(() => {
    onExit()
  }, [onExit])

  // Esc 也退出（绑定到 modal 根节点 onKeyDown：focus trap 在 window 上拦截 Tab，
  // Esc 留到 root 节点避免多 modal 同帧挂载时互相误关，与 ToolConfirmDialog R25 一致）
  const onOverlayKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      handleExit()
    }
  }

  // SSR / 非浏览器环境兜底
  if (typeof document === 'undefined') return null

  const node = (
    <div
      ref={overlayRef}
      className="focus-mode-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="专注模式"
      tabIndex={-1}
      onKeyDown={onOverlayKeyDown}
    >
      <button
        type="button"
        className="focus-mode-close"
        onClick={handleExit}
        aria-label="退出专注模式"
        title="退出专注模式（Esc）"
      >
        <X size={18} aria-hidden />
      </button>
      <div className="focus-mode-body">
        <ModeLabel mode={mode} cycleIndex={cycleIndex} />
        <MinimalClock remainingSec={remainingSec} />
        <div className="focus-mode-hint">Esc 或点击 × 退出</div>
      </div>
    </div>
  )
  // 用 portal 把遮罩直接挂到 body，避免被嵌入容器 overflow / transform 影响定位
  return createPortal(node, document.body)
}

export default FocusModeOverlay
