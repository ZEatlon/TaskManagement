/**
 * 通用 aria-live 公告器
 *
 * R8A-5/R8A-6：屏幕阅读器用户需要知道后台发生的事情
 *   - 「已创建便签 ...」
 *   - 「便签已移动到 9 月 1 日」
 *   - 「步骤 3 已完成，便签自动标记为完成」
 *
 * 实现：
 *   - 用 React Portal 渲染到 <body> 末尾
 *   - 双通道：polite（一般）和 assertive（错误/重要）
 *   - 全局唯一 announcer：通过模块级 setMessage() 触发
 *   - 消息 1.5s 后清空，避免 DOM 上遗留文本影响 SR 阅读焦点
 *
 * 用法（任意组件内）：
 *   import { announce } from '@renderer/components/common/AriaAnnouncer'
 *   announce('便签已保存')
 *   announce('删除失败', 'assertive')
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Channel = 'polite' | 'assertive'

interface AnnouncerMessage {
  id: number
  text: string
  channel: Channel
  ts: number
}

/** 模块级队列 + 单一订阅者 */
let nextId = 1
const subscribers = new Set<(msg: AnnouncerMessage) => void>()

/** 触发一次公告。同一文本在 500ms 内重复触发会被合并，避免 SR 重复朗读。 */
const recentTexts = new Map<string, number>()
function dedup(text: string): boolean {
  const last = recentTexts.get(text) ?? 0
  if (Date.now() - last < 500) return false
  recentTexts.set(text, Date.now())
  // 防止内存无限增长：保留最近 50 条
  if (recentTexts.size > 50) {
    const first = recentTexts.keys().next().value
    if (first) recentTexts.delete(first)
  }
  return true
}

export function announce(text: string, channel: Channel = 'polite'): void {
  if (!text || typeof window === 'undefined') return
  if (!dedup(text)) return
  const msg: AnnouncerMessage = {
    id: nextId++,
    text,
    channel,
    ts: Date.now(),
  }
  for (const sub of subscribers) sub(msg)
}

/**
 * 把 announcer 挂在 body 末尾的 portal（screen reader 才会朗读）。
 * 在 main.tsx 中渲染一次即可。
 */
export function AriaAnnouncerMount() {
  const [polite, setPolite] = useState<string>('')
  const [assertive, setAssertive] = useState<string>('')

  useEffect(() => {
    // R9 修复：每个 channel 一个独立 timer，避免 assertive 消息清掉 polite 文本
    // （反之亦然）。原版共享一个 timerRef，新消息会取消旧 timer，导致
    // 上一条 polite 消息的清空逻辑被覆盖，polite 文本永远滞留 DOM。
    let politeTimer: number | null = null
    let assertiveTimer: number | null = null

    const sub = (msg: AnnouncerMessage) => {
      if (msg.channel === 'assertive') {
        if (assertiveTimer !== null) window.clearTimeout(assertiveTimer)
        setAssertive(msg.text)
        assertiveTimer = window.setTimeout(() => {
          assertiveTimer = null
          setAssertive('')
        }, 1500)
      } else {
        if (politeTimer !== null) window.clearTimeout(politeTimer)
        setPolite(msg.text)
        politeTimer = window.setTimeout(() => {
          politeTimer = null
          setPolite('')
        }, 1500)
      }
    }
    subscribers.add(sub)
    return () => {
      subscribers.delete(sub)
      if (politeTimer !== null) window.clearTimeout(politeTimer)
      if (assertiveTimer !== null) window.clearTimeout(assertiveTimer)
    }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </>,
    document.body,
  )
}

export default AriaAnnouncerMount