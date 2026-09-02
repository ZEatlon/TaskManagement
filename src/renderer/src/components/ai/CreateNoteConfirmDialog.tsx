/**
 * createNote 工具确认弹窗
 *
 * 触发链路：
 *   AI 助手工具调用 createNote → 后端返回 `{ kind: 'confirm_create', ... }`
 *   → 流事件 tool_result 携带此结果 → store 把它塞进 pendingCreateNote
 *   → 本组件渲染弹窗 → 用户点 [接受] → 调 confirmCreateNote IPC → 真正落盘
 *
 * 设计要点：
 *   - 三个按钮固定顺序：[接受][修改][放弃]
 *   - 接受是默认焦点（Enter 键直接接受）
 *   - Esc 键关闭（等同于放弃）
 *   - 不阻塞用户继续看消息（弹窗覆盖在右下角而非全屏）
 */
import { useEffect, useRef } from 'react'
import { useAiStore } from '../../stores/ai'
import { useFocusTrap } from '../../lib/useFocusTrap'

const MAX_PREVIEW_CHARS = 480

function previewText(text: string): string {
  if (text.length <= MAX_PREVIEW_CHARS) return text
  return text.slice(0, MAX_PREVIEW_CHARS) + '…[已截断]'
}

export function CreateNoteConfirmDialog() {
  const pending = useAiStore((s) => s.pendingCreateNote)
  const accept = useAiStore((s) => s.acceptCreateNote)
  const dismiss = useAiStore((s) => s.dismissCreateNote)
  const requestPrefill = useAiStore((s) => s.requestPrefillInput)
  const streaming = useAiStore((s) => s.streaming)
  const acceptBtnRef = useRef<HTMLButtonElement | null>(null)
  // R15 修复 (medium)：弹窗关闭时把焦点还给弹窗打开前的 activeElement，
  // 否则用户在 AI 输入框里点击触发的弹窗，关闭后会丢焦点，键盘无障碍体验断裂
  const previouslyFocusedRef = useRef<Element | null>(null)

  useEffect(() => {
    if (pending) {
      // 记住弹窗弹出前的焦点元素，关闭时还回去
      previouslyFocusedRef.current = document.activeElement
      // 微延迟：等 modal 进场的 220ms 动画结束再聚焦，避免视觉跳动
      const id = setTimeout(() => acceptBtnRef.current?.focus(), 240)
      return () => {
        clearTimeout(id)
        const prev = previouslyFocusedRef.current
        if (prev instanceof HTMLElement) prev.focus()
        previouslyFocusedRef.current = null
      }
    }
    return undefined
  }, [pending])

  // R18 修复 (medium ux)：Esc 监听从 window 收窄到 modalRef 根节点。
  // R17 的实现挂在 window 上，多个 modal 同时挂载时（CreateNoteConfirmDialog
  // + CommandBar / PomodoroStart / Setting 编辑等），任意 modal 的 Esc 触发
  // 都会把其它 modal 也 dismiss 掉 —— 用户在 AI 弹窗里按 Esc，本想放弃创建，
  // 结果 PomodoroStart、CommandBar 等一同关闭。改成把 onKeyDown 绑到 modal
  // 根 div 上，事件只在 modal 处于 focus 路径里时触发；其它 modal 仍按自己
  // 状态保留。Focus trap 仍挂在 window 上（tab 循环必须全局可见）。
  const onModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      dismiss()
    }
  }

  // R17 修复 (high a11y)：focus trap。role=dialog + aria-modal=true 暗示模态，
  // 但缺 Tab 拦截键盘会走出弹窗落到背景 AI chat 输入框或工具调用按钮。
  // 监听 Tab / Shift+Tab，把焦点圈在 modal 内的 4 个可聚焦元素内（close +
  // 放弃 + 让 AI 再调整 + 接受）。modal 通过 useRef 抓到的 dom 子树限定查询。
  //
  // R21 修复 (low consolidation)：把内联 focus trap 替换为共享 useFocusTrap，
  // 与 ConflictDialog / DashboardEditorModal / ToolConfirmDialog 用同一份实现，
  // 避免四份相同代码飘移。
  const modalRef = useRef<HTMLDivElement | null>(null)
  useFocusTrap(modalRef, !!pending)

  if (!pending) return null

  return (
    // R6A-7：补 click-outside 关闭，inner modal 上 stopPropagation 防止误关
    <div
      className="ai-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="确认创建笔记"
      onClick={dismiss}
    >
      <div
        ref={modalRef}
        className="ai-confirm-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
        tabIndex={-1}
      >
        <header className="ai-confirm-head">
          <span className="ai-confirm-icon">✨</span>
          <div>
            <h3 className="ai-confirm-title">AI 想创建一篇笔记</h3>
            <p className="ai-confirm-sub">仅在库目录的 notes/ 写入，不会动到便签 / 设置 / Git。</p>
          </div>
          <button
            className="ai-confirm-close"
            onClick={dismiss}
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            ×
          </button>
        </header>

        <dl className="ai-confirm-meta">
          <div className="ai-confirm-row">
            <dt>文件名</dt>
            <dd>
              <code>{pending.filename || '—'}</code>
            </dd>
          </div>
          <div className="ai-confirm-row">
            <dt>标题</dt>
            <dd>{pending.title}</dd>
          </div>
        </dl>

        <div className="ai-confirm-body">
          <div className="ai-confirm-label">正文预览</div>
          <pre className="ai-confirm-pre">{previewText(pending.content)}</pre>
        </div>

        <footer className="ai-confirm-foot">
          <span className="ai-confirm-hint">
            {streaming ? 'AI 仍在生成中…可先预览，结果会以最终版本落盘' : '已准备好写入'}
          </span>
          <div className="ai-confirm-actions">
            <button className="btn ghost" onClick={dismiss}>
              放弃
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                // R15 修复 (high)：原版通过 document.querySelector 找 textarea，
                // 然后直接赋值 + dispatch input 事件，属于命令式 mutate 受控
                // 组件，会绕过 React state、导致 dispatch 'input' 同步覆盖可能
                // 失序，且依赖恰好存在 .ai-input-textarea 这个 selector（耦合 +
                // 不可测试）。改为走 store.requestPrefillInput：MessageInput 订
                // 阅 prefillInput.seq 后在 effect 里 setValue，唯一的 React 通道。
                dismiss()
                const next = `请把上面这篇笔记调整后重新输出，确认前不要写盘：\n\n${pending.content}`
                requestPrefill(next)
              }}
            >
              让 AI 再调整
            </button>
            <button
              ref={acceptBtnRef}
              className="btn primary"
              onClick={() => void accept()}
            >
              接受并写入 (Enter)
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default CreateNoteConfirmDialog
