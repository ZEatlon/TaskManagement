/**
 * 日期 formatter —— 集中「今天 / 明天 / N 天后 / MM-DD」逻辑
 */
import { diffDays, fromDayKey, dayKeyOf } from './date'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 「今天 / 明天 / 后天 / N 天后 / N 天前 / MM-DD」 */
export function formatDayLabel(dayKey: string): string {
  const today = dayKeyOf(new Date())
  const diff = diffDays(fromDayKey(dayKey), fromDayKey(today))
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  if (diff === 2) return '后天'
  if (diff === -2) return '前天'
  if (diff > 0 && diff <= 7) return `${diff} 天后`
  if (diff < 0 && diff >= -7) return `${-diff} 天前`
  // 跨周：直接 MM-DD
  const [, m, d] = dayKey.split('-')
  return `${m}-${d}`
}

/** 「2026-08-31 周日 · 今天」 —— sticky header 用 */
export function formatDayHeader(dayKey: string): string {
  const d = fromDayKey(dayKey)
  const relative = formatDayLabel(dayKey)
  const weekday = WEEKDAYS[d.getDay()]
  return `${dayKey} ${weekday} · ${relative}`
}

/** 「刚刚 / X 分钟前 / X 小时前 / X 天前 / YYYY-MM-DD」 —— 时间显示 */
export function formatTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diffMs = Date.now() - t
  const sec = Math.floor(diffMs / 1000)
  if (sec < 30) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  const d = new Date(iso)
  return dayKeyOf(d)
}