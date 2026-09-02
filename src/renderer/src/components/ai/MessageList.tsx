/**
 * 消息列表
 *
 * 渲染当前对话的所有消息：
 *   - user：右对齐气泡
 *   - assistant：左对齐，含流式光标 + 工具调用卡片
 */
import { memo, useEffect, useRef } from 'react'
import { useAiStore, type UiMessage } from '../../stores/ai'
import { ToolCallCard } from './ToolCallCard'
import { StreamingCursor } from './StreamingCursor'
import { MarkdownView } from './MarkdownView'
import { BrandMark } from '../brand/BrandMark'

export function MessageList() {
  const messages = useAiStore((s) => s.messages)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // R26-perf-19 修复 (medium scroll UX)：原版 useEffect([messages]) 每
  // 次 messages 变化都强制 scrollTop=scrollHeight，包括用户主动向上滚动
  // 看历史时（点旧消息 → messages 更新 → 视图被拽回底部 → 阅读位置丢失）。
  // 修复：只在「用户原本就靠近底部」时才自动滚；用户已向上滚超过 ~80px
  // 时不动他的阅读位置，让他继续看历史。
  const userPinnedToBottomRef = useRef(true)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const node = el
    // 在每次 scroll 事件里维护这个 flag —— scrollTop 与 scrollHeight
    // - clientHeight 差值 < 80 视为「还在底部」。
    function onScroll() {
      const distanceFromBottom =
        node.scrollHeight - node.clientHeight - node.scrollTop
      userPinnedToBottomRef.current = distanceFromBottom < 80
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    // 自动滚到底部 —— 仅当用户原本就贴在底部
    const el = containerRef.current
    if (!el) return
    if (userPinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  if (messages.length === 0) {
    return (
      // R12 修复 (medium)：空态容器加 role="status" aria-live="polite"，
      // 屏幕阅读器首次进入能听到"开始与 TaskPilot 助手对话"的提示，
      // 而不是沉默或只读 page heading。
      <div className="ai-empty-state" role="status" aria-live="polite">
        <BrandMark size={56} className="ai-empty-icon" title="TaskPilot" aria-hidden />
        <h3>开始与 TaskPilot 助手对话</h3>
        <p>试试说："新建一个明天的会议任务"，或"帮我整理笔记摘要"</p>
      </div>
    )
  }

  return (
    <div className="ai-message-list" ref={containerRef}>
      {messages.map((m) => (
        <MessageBubble key={m.id} msg={m} />
      ))}
    </div>
  )
}

/**
 * 把消息时间戳格式化为 "HH:mm"，无效/缺失时返回空串。
 * 老 DB 记录可能没有 ts 字段，new Date(undefined) 会得到 Invalid Date，
 * 这里统一兜底，避免 UI 上出现 "Invalid Date"。
 */
function formatBubbleTime(ts: string | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// R15 修复 (medium)：流式场景下 store.messages 每 token 整体更新一次 references，
// 未 memo 的 MessageBubble 会让所有历史气泡（即使已完成、props 不变）每 token 重渲。
// 100 条消息长对话下，单 token 触发的重渲染 ≈ N 个 bubble（含 MarkdownView /
// ToolCallCard 子树），流式期间把交互式滚动 / 选中文本 / IME 都卡顿。memo + 自定义
// equality 让"仅 streaming 字段变化"也强制重渲（否则用户看不到光标前进），其余气泡
// 完全跳过。注：msg 引用在 store 中实际是原地 mutate content + streaming 字段，
// 默认 referential equality 永远 false；自定义 equality 判断只有 toolCalls / role /
// ts 变化才走更新，content 变化只在 streaming=true 时算。
const MessageBubble = memo(
  function MessageBubbleInner({ msg }: { msg: UiMessage }) {
    const isUser = msg.role === 'user'
    const timeText = formatBubbleTime(msg.ts)
    return (
      <div className={`ai-bubble ${isUser ? 'ai-bubble-user' : 'ai-bubble-assistant'}`}>
        <div className="ai-bubble-meta">
          <span className="ai-bubble-role">{isUser ? '你' : '助手'}</span>
          {timeText && <time className="ai-bubble-time">{timeText}</time>}
        </div>
        <div className="ai-bubble-body">
          {msg.content && (
            <div className={`ai-bubble-text ${msg.streaming ? 'is-streaming' : ''}`}>
              {msg.streaming ? (
                // 流式中：原始文本 + 光标，每 token 立即出现
                <>
                  {msg.content}
                  <StreamingCursor />
                </>
              ) : (
                // 已完成：走完整的 markdown 渲染
                <MarkdownView content={msg.content} />
              )}
            </div>
          )}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div className="ai-bubble-tools">
              {msg.toolCalls.map((tc) => (
                <ToolCallCard key={tc.id} tool={tc} />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  },
  (prev, next) => {
    // streaming 期间 content 持续变，强制更新；非 streaming 时按内容/角色/工具列
    // 表的"语义身份"判断。ts 不变化就视为同一条消息。
    if (prev.msg === next.msg) return true
    return (
      prev.msg.role === next.msg.role &&
      prev.msg.streaming === next.msg.streaming &&
      prev.msg.content === next.msg.content &&
      prev.msg.ts === next.msg.ts &&
      prev.msg.toolCalls === next.msg.toolCalls
    )
  },
)

export default MessageList
