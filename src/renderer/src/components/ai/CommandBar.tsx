/**
 * 全局 AI 命令栏（Raycast 风格）
 *
 * 触发：Header ✨ 按钮 / 全局 Cmd+K（Mac）/ Ctrl+K（其他）
 * 位置：屏幕顶部居中浮卡，离顶 72px，宽 480px
 * 能力：
 *   - 任意页都能用，不切走当前页面
 *   - 流式响应在弹窗内即时显示
 *   - Esc 关闭；Cmd/Ctrl+Enter 发送
 *   - 与 /ai 页面共享 conversation（用户后续在 /ai 能看到本次提问历史）
 *
 * 设计要点：
 *   - 不引入新动画 token：复用 --motion-fast / --ease-out
 *   - 不引入新色：复用 --ai-glow / --ai-hint / --accent
 *   - 移动端友好：viewport < 540px 时全屏化
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { useAiStore } from '../../stores/ai'
import { useSettingsStore } from '../../stores/settings'
import { useFocusTrap } from '../../lib/useFocusTrap'
import { useShortcutBinding } from '../../lib/useShortcut'
import { formatShortcutForOS } from '../../lib/shortcuts'
import { MarkdownView } from './MarkdownView'
import { StreamingCursor } from './StreamingCursor'

/** 简短提示词模板（点击即填入输入框） */
const SUGGESTIONS: Array<{ icon: string; label: string; prompt: string }> = [
  {
    icon: '📋',
    label: '本周总结',
    prompt: '帮我总结一下本周我做了什么（查便签 + 笔记 + 番茄钟）',
  },
  {
    icon: '🧠',
    label: '拆解便签',
    prompt: '把当前优先级最高的便签拆成 3-5 步可执行步骤',
  },
  {
    icon: '📝',
    label: '写一篇笔记',
    prompt: '帮我在 notes/ 下新建一篇关于「{主题}」的笔记',
  },
  {
    icon: '🗓',
    label: '今日计划',
    prompt: '根据今日便签给我一个执行顺序建议',
  },
]

export function CommandBar() {
  // Perf-fix #10：selector fan-out 收敛 —— 9 个独立订阅（每 store update 9 次比较）
  // 合并到 1 个 shallow + 3 个 stable action 订阅。流式响应每个 token 触发一次
  // set，原版每次跑 9 次 selector equality check，新版只跑 2 次（shallow + messages）。
  const { open, messages, streaming, activeCallId, error } = useAiStore(
    useShallow((s) => ({
      open: s.commandBarOpen,
      messages: s.messages,
      streaming: s.streaming,
      activeCallId: s.activeCallId,
      error: s.error,
    })),
  )
  const close = useAiStore((s) => s.closeCommandBar)
  const openBar = useAiStore((s) => s.openCommandBar)
  const send = useAiStore((s) => s.sendMessage)
  const abort = useAiStore((s) => s.abort)
  const aiProvider = useSettingsStore((s) => s.aiProvider)
  const aiEnabled = useSettingsStore((s) => s.aiEnabled)
  const shortcutOverrides = useSettingsStore((s) => s.shortcutOverrides)
  const navigate = useNavigate()

  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // R16 修复 (medium)：打开时记录之前 activeElement，关闭时把焦点还回去；
  // 之前 Esc 关闭后焦点丢失到 document.body，键盘用户必须 Tab 多次才能恢复。
  // 同时存 modal ref 用于 focus trap（Tab/Shift+Tab 在边界循环）。
  const cardRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // R14 修复 (low)：用 useMemo 缓存最后一条 assistant；该 IIFE 在
  // 每次 keystroke / 流式增量都会重跑，对长会话 O(N) 无谓扫描。
  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i]
    }
    return null
  }, [messages])
  const isStreaming = streaming && !!activeCallId

  // 全局快捷键：mod+K 触发（受用户覆盖影响）；打开时按 Esc 关闭。
  // useShortcutBinding 不支持「打开时按 Esc 关闭」的复合语义（Esc 不是 binding），
  // 所以这里手写一个 keydown 拦截 Esc 即可。
  useShortcutBinding('mod+k', () => {
    if (open) close()
    else void openBar()
  })
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // 打开时：聚焦输入框 + 滚动到底部 + 记录之前焦点
  useEffect(() => {
    if (!open) {
      // 关闭时把焦点还给打开前的 activeElement（与 CreateNoteConfirmDialog / ToolConfirmDialog 一致）
      const prev = previouslyFocusedRef.current
      if (prev && document.body.contains(prev)) {
        prev.focus()
      }
      previouslyFocusedRef.current = null
      return
    }
    // 打开瞬间 activeElement 通常是 ✨ 触发按钮或 document.body，记下来
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null
    const id = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(id)
  }, [open])

  // R21 修复 (low consolidation)：把内联 focus trap 替换为共享 useFocusTrap，
  // 与 ConflictDialog / DashboardEditorModal / CreateNoteConfirmDialog /
  // ToolConfirmDialog / LibraryMissingDialog 用同一份实现，避免 4 份相同代码
  // 飘移。R16 原始内联版本只处理 first/last 边界，未处理焦点已逃出 modal 的
  // 情况（如用户用鼠标点了 backdrop 然后按 Tab）；useFocusTrap 的
  // root.contains(active) 判定补上这块。
  useFocusTrap(cardRef, open)

  // 流式响应时滚到底部
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lastAssistant?.content, open])

  if (!open) return null

  const onSend = () => {
    const text = input.trim()
    if (!text || isStreaming) return
    void send(text)
    setInput('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // R6A-3：IME 守卫 —— 中文输入法选词时按 Enter 会先触发 compositionend，
    // 此时 keyCode === 229 / isComposing === true，不应触发 onSend。
    const isComposing =
      e.nativeEvent.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      (e.metaKey || e.ctrlKey) &&
      !isComposing
    ) {
      e.preventDefault()
      onSend()
    }
  }

  const commandBarBinding = shortcutOverrides?.['command-bar.toggle'] || 'mod+k'
  const shortcutLabel = formatShortcutForOS(commandBarBinding)

  // AI 未启用时：降级为提示卡片
  if (!aiEnabled || !aiProvider) {
    return (
      <div className="cb-overlay" onClick={close}>
        <div
          ref={cardRef}
          className="cb-card"
          role="dialog"
          aria-modal="true"
          aria-label="AI 助手未启用"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="cb-head">
            <span className="cb-icon">✨</span>
            <span className="cb-title">AI 助手</span>
            <span className="cb-shortcut">{shortcutLabel}</span>
            <button className="cb-close" onClick={close} aria-label="关闭">
              ×
            </button>
          </div>
          <div className="cb-empty">
            <p>请先在「设置 → AI 助手」启用并配置 Provider 后再使用。</p>
            <button
              className="btn primary"
              onClick={() => {
                close()
                void navigate({ to: '/settings' })
              }}
            >
              前往设置
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cb-overlay" onClick={close}>
      <div
        ref={cardRef}
        className="cb-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="AI 命令栏"
      >
        <div className="cb-head">
          <span className="cb-icon">✨</span>
          <span className="cb-title">问 AI</span>
          <span className="cb-provider">
            {aiProvider}
            <span className="cb-provider-dot" />
            {aiProvider === 'openai'
              ? 'gpt-4o-mini'
              : aiProvider === 'anthropic'
                ? 'claude-3-5-sonnet'
                : 'MiniMax-M3'}
          </span>
          <span className="cb-shortcut">{shortcutLabel}</span>
          <button className="cb-close" onClick={close} aria-label="关闭 (Esc)">
            ×
          </button>
        </div>

        <div className="cb-body" ref={scrollRef}>
          {!lastAssistant && messages.length === 0 && (
            <div className="cb-suggestions">
              <div className="cb-suggestions-label">试试：</div>
              <div className="cb-suggestions-grid">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    className="cb-suggestion"
                    onClick={() => {
                      setInput(s.prompt)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="cb-suggestion-icon">{s.icon}</span>
                    <span className="cb-suggestion-label">{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {lastAssistant && (
            <div className="cb-response">
              <div className="cb-response-label">
                {isStreaming ? '正在生成…' : '助手'}
              </div>
              <div
                className={`cb-response-text ${
                  lastAssistant.streaming ? 'is-streaming' : ''
                }`}
              >
                {lastAssistant.content ? (
                  lastAssistant.streaming ? (
                    <>
                      {lastAssistant.content}
                      <StreamingCursor />
                    </>
                  ) : (
                    <MarkdownView content={lastAssistant.content} />
                  )
                ) : (
                  <span className="cb-thinking">
                    <span /> <span /> <span />
                  </span>
                )}
              </div>
              {lastAssistant.toolCalls && lastAssistant.toolCalls.length > 0 && (
                <div
                  className="cb-tools"
                  // R26-a11y-2 修复 (medium aria)：原版 tool-chip 仅是
                  // <span>，SR 完全听不到 LLM 调用了哪些工具、状态如何。加
                  // role="list" + aria-label 让 SR 用户能听到「助手调用了
                  // N 个工具：createSticky 完成、updateSticky 进行中 …」
                  role="list"
                  aria-label={`助手调用了 ${lastAssistant.toolCalls.length} 个工具`}
                >
                  {lastAssistant.toolCalls.map((tc) => (
                    <span
                      key={tc.id}
                      role="listitem"
                      className={`cb-tool-chip ${tc.status}`}
                      title={JSON.stringify(tc.args)}
                      aria-label={`${tc.name} ${
                        tc.status === 'calling'
                          ? '调用中'
                          : tc.status === 'error'
                            ? '出错'
                            : '完成'
                      }`}
                    >
                      {tc.status === 'calling' ? '⏳' : tc.status === 'error' ? '⚠️' : '✓'}{' '}
                      {tc.name}
                    </span>
                  ))}
                </div>
              )}
              {!lastAssistant.streaming && lastAssistant.content && (
                <div className="cb-response-foot">
                  <button
                    className="btn ghost cb-open-ai"
                    onClick={() => {
                      close()
                      void navigate({ to: '/ai' })
                    }}
                  >
                    在 AI 助手页打开 ↗
                  </button>
                </div>
              )}
            </div>
          )}
          {error && !isStreaming && <div className="cb-error">⚠ {error}</div>}
        </div>

        <div className="cb-input-area">
          <textarea
            ref={inputRef}
            className="cb-input"
            placeholder="问 AI 任何事…Shift+Enter 换行"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
          />
          <div className="cb-input-actions">
            {isStreaming ? (
              <button className="btn cb-stop" onClick={() => abort()}>
                停止
              </button>
            ) : (
              <button
                className="btn primary cb-send"
                onClick={onSend}
                disabled={!input.trim()}
              >
                发送 · {shortcutLabel}↵
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default CommandBar
