/**
 * 消息输入框
 *
 * 底部 textarea：
 *   - Enter 发送，Shift+Enter 换行
 *   - 附件按钮（占位，当前未实现选中文件预览）
 *   - 发送按钮在 streaming 状态变成"停止"
 */
import { useEffect, useRef, useState } from 'react'
import { useAiStore } from '../../stores/ai'

interface Props {
  disabled?: boolean
}

export function MessageInput({ disabled }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const sendMessage = useAiStore((s) => s.sendMessage)
  const abort = useAiStore((s) => s.abort)
  const streaming = useAiStore((s) => s.streaming)
  const activeCallId = useAiStore((s) => s.activeCallId)
  const prefillInput = useAiStore((s) => s.prefillInput)
  const clearPrefill = useAiStore((s) => s.clearPrefillInput)

  // 自适应高度（最多 6 行）
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'
  }, [value])

  // R15 修复 (high)：订阅 CreateNoteConfirmDialog「让 AI 再调整」按钮灌入
  // 的预填文本。useEffect dep 用 [prefillInput?.seq] 而不是 [prefillInput]，
  // 否则每次清空时（{seq, text} → null）会拿 null dep 把 effect 触发条件
  // 模糊掉。seq 自增保证「两次灌入相同文本」也能被识别为新请求。
  useEffect(() => {
    if (!prefillInput) return
    setValue(prefillInput.text)
    clearPrefill()
    // 重新计算高度：setValue 后 React 同步更新 textarea.scrollHeight
    queueMicrotask(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'
      ta.focus()
      // 滚到末尾，让用户看到追加的"调整提示 + 笔记正文"
      const len = ta.value.length
      ta.setSelectionRange(len, len)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillInput?.seq])

  const onSend = async () => {
    const text = value.trim()
    if (!text || streaming) return
    // R13 修复 (medium)：等 sendMessage resolve 后再清空输入。如果调用链中
    // 任一环节（无 currentId / systemPrompt 抛错 / IPC 失败）静默 return，
    // 用户输入必须保留，否则长 prompt 被吞掉无法恢复。
    let accepted = false
    try {
      const result = await sendMessage(text)
      // store 返回值约定：true=已接受并开始流式；false=拒绝（如无当前对话）
      accepted = result !== false
    } catch {
      accepted = false
    }
    if (accepted) {
      setValue('')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // R6A-3：IME 守卫 —— 中文输入法选词时按 Enter 不应触发 onSend。
    const isComposing =
      e.nativeEvent.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      e.preventDefault()
      onSend()
    }
  }

  const isRunning = streaming && !!activeCallId

  return (
    <div className="ai-input-area">
      <textarea
        ref={textareaRef}
        className="ai-input-textarea"
        placeholder={disabled ? '请先选择对话或配置 API Key' : '输入消息，Enter 发送，Shift+Enter 换行…'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        disabled={disabled}
      />
      <div className="ai-input-actions">
        <button
          type="button"
          className="ai-attachment-btn"
          disabled
          title="附件（即将上线）"
          // R17 修复 (low a11y)：icon-only disabled button 缺 aria-label，
          // 屏幕阅读器读出"按钮 已禁用"或"📎，按钮，已禁用"，用户无法得知
          // 这是「附件（即将上线）」。title 在 ARIA 1.2 下不是可靠的
          // accessible name 来源。补 aria-label。
          aria-label="附件（即将上线）"
        >
          📎
        </button>
        {isRunning ? (
          <button type="button" className="btn ai-stop-btn" onClick={() => abort()}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="btn primary ai-send-btn"
            onClick={onSend}
            disabled={disabled || !value.trim()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}

export default MessageInput
