/**
 * 午夜滚动 hook（day rollover）
 *
 * 用途：今日 / 明日视图、Dashboard 今日待办面板等依赖于"今天日期"的视图，需要在
 * 系统日期跨越 0:00 时自动刷新数据。
 *
 * 行为：
 * 1. 每分钟检查一次 `Date.now()` 的"日期部分"（YYYY-MM-DD）。
 * 2. 一旦发现日期变了，立即调用 `onDayChange(newDate)`。
 * 3. 同时监听 `visibilitychange`：当页面切回前台（用户从休眠 / 锁屏返回），也触发一次回调。
 * 4. 多组件挂载：内部用一个模块级 Set 共享同一个轮询定时器；任何一个调用方卸载，
 *    只要还有其它订阅者，定时器就不停。
 * 5. **同一分钟内同一日期只会触发一次回调**，不会因为 cleanup/setup 抖动而重复触发。
 *
 * 参数：
 * - onDayChange(dateKey: string) —— 必填，回调拿到的是新的日期键
 *
 * 退出策略：
 * - 调用方组件卸载时自动取消订阅。
 */
import { useEffect, useRef, useState } from 'react'

/** 把 Date 转成 'YYYY-MM-DD'，用于"今天"判定 */
export function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type Listener = (dateKey: string) => void

const subscribers = new Set<Listener>()
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 模块级 "上一次真正派发过的日期键" —— 只有它变化时才广播 */
let lastBroadcastKey: string | null = null

/** 真正派发：被 interval 和 visibilitychange 共用；带去重 */
function broadcastIfDayChanged() {
  const cur = dayKey(new Date())
  if (cur === lastBroadcastKey) return
  lastBroadcastKey = cur
  // 复制一份订阅者列表后再遍历 —— 避免回调里再次 add/remove 导致 forEach 跳过/重复
  const snapshot = Array.from(subscribers)
  for (const cb of snapshot) {
    try {
      cb(cur)
    } catch (err) {
      console.error('[useDayRollover] subscriber threw:', err)
    }
  }
}

function ensurePolling() {
  if (pollTimer !== null) return
  // 第一次启动时把 lastBroadcastKey 同步到今天 —— 避免"模块加载早于当天首次挂载"导致
  // 用户在当天首次进入路由时就被广播"昨天"或"明天"
  if (lastBroadcastKey === null) {
    lastBroadcastKey = dayKey(new Date())
  }
  pollTimer = setInterval(broadcastIfDayChanged, 60_000)

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility)
  }
}

function handleVisibility() {
  if (document.visibilityState !== 'visible') return
  broadcastIfDayChanged()
}

function teardownPolling() {
  if (subscribers.size > 0) return
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibility)
  }
}

/**
 * 使用 ref 稳定回调引用：
 * - 业务回调总是拿"最新的"setState / fetch（避免闭包过期）
 * - 但 hook 内部的 subscribe / unsubscribe 只在组件挂载/卸载时跑一次
 *   避免 onDayChange 引用每次变化导致 useEffect 反复 add/remove，污染全局订阅表
 */
export function useDayRollover(onDayChange: (dateKey: string) => void): void {
  const cbRef = useRef(onDayChange)
  cbRef.current = onDayChange

  // 仅在组件挂载/卸载时跑一次；onDayChange 引用变化不会重订阅
  useEffect(() => {
    const wrapper: Listener = (k) => cbRef.current(k)
    subscribers.add(wrapper)
    ensurePolling()
    return () => {
      subscribers.delete(wrapper)
      teardownPolling()
    }
  }, [])
}

/** 调试 / 测试用：手动模拟一次日期切换，立即触发所有订阅者 */
export function _debugForceRollover(): void {
  lastBroadcastKey = null
  broadcastIfDayChanged()
}

/**
 * R5R-4 配套：返回当前 YYYY-MM-DD，并在跨午夜时自动更新。
 *
 * - 组件若直接 `dayKeyOf(new Date())` 拿 todayKey，跨过午夜后视图就会一直停留在昨天。
 * - 用 useState + useDayRollover 实现订阅：午夜 0 点切换 / visibilitychange 切回前台 → 重算。
 */
export function useTodayKey(): string {
  const [key, setKey] = useState<string>(() => dayKey(new Date()))
  useDayRollover((newDay) => setKey(newDay))
  return key
}