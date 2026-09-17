/**
 * W2-B AI 助手通知 toast
 *
 * 挂到主应用根部（main.tsx），订阅 window.api.assistant.onHint/onChat：
 *   - hint → 显示底部右侧的 toast，4 秒自动消失，可手动 × 关闭
 *   - chat → 不做 toast，触发 AIChatPanel 打开对话（共享 chat 触发机制）
 *
 * 设计取舍：
 *   - 单文件、轻量、零外部 store —— 主进程 push 事件直接驱动显示
 *   - 多个 hint 堆叠：FIFO 队列最多 3 条；第 4 条入队时挤掉最老
 *   - chat 不做 in-app toast —— 用户期望 chat 是个持续对话窗口，
 *     我们复用现有 /ai 路由；具体跳路由由 chat 事件里的 payload.route
 *     决定（默认 /ai）
 */
import { useCallback, useEffect, useState } from 'react'
import { X, Sparkles } from '@renderer/lib/icon'

interface HintItem {
  id: string
  category: string
  text: string
  atIso: string
}

interface ChatPayload {
  id: string
  category: string
  prompt: string
  atIso: string
  /** 渲染端决定跳到哪条路由；默认 /ai。 */
  route?: string
}

const MAX_VISIBLE_HINTS = 3
const AUTO_DISMISS_MS = 4000

export function AINotificationHost() {
  const [hints, setHints] = useState<HintItem[]>([])
  const [chatPayload, setChatPayload] = useState<ChatPayload | null>(null)

  const dismiss = useCallback((id: string) => {
    setHints((prev) => prev.filter((h) => h.id !== id))
  }, [])

  // 订阅主进程推送的 hint + chat 事件
  useEffect(() => {
    const offHint = window.api.assistant.onHint((_e, payload) => {
      setHints((prev) => {
        const next = [...prev, payload]
        // FIFO：保留最新 N 条
        if (next.length > MAX_VISIBLE_HINTS) {
          return next.slice(next.length - MAX_VISIBLE_HINTS)
        }
        return next
      })
      // 自动消失
      window.setTimeout(() => {
        setHints((prev) => prev.filter((h) => h.id !== payload.id))
      }, AUTO_DISMISS_MS)
    })
    const offChat = window.api.assistant.onChat((_e, payload) => {
      setChatPayload(payload)
    })
    return () => {
      offHint()
      offChat()
    }
  }, [])

  // chat 事件触发：通知 AIChatPanel 打开（通过 zustand store 或 navigate）
  // 简化：直接走 navigate('/ai?focus=...') + 全局事件，让 AI 页面读到
  useEffect(() => {
    if (!chatPayload) return
    // 优先用 payload.route；否则跳 /ai
    const route = chatPayload.route ?? '/ai'
    // 标记 assistant-initiated chat，让 AI 页面预填 prompt
    const params = new URLSearchParams({
      assistant: '1',
      prompt: chatPayload.prompt,
      category: chatPayload.category,
    })
    window.location.hash = `${route}?${params.toString()}`
    setChatPayload(null)
  }, [chatPayload])

  return (
    <div className="ai-notification-host" aria-live="polite" aria-relevant="additions">
      {hints.map((h) => (
        <div key={h.id} className="ai-hint-toast" role="status">
          <Sparkles size={14} aria-hidden />
          <span className="ai-hint-text">{h.text}</span>
          <button
            type="button"
            className="ai-hint-close"
            onClick={() => dismiss(h.id)}
            aria-label="关闭通知"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
