/**
 * 日期 formatter —— 集中「今天 / 明天 / N 天后 / MM-DD」逻辑
 */
import { diffDays, fromDayKey, dayKeyOf } from './date'
import { getRelativeTimeMessages, toLocaleValue, type LocaleValue } from '@shared/i18n/locales'

/**
 * 把秒数格式化为 MM:SS。
 *
 * 契约：
 * - 负数会被 clamp 到 0（显示为 "00:00"，不抛错）。
 * - 非整数会被 floor（保证每秒整数稳定，不抖屏）。
 * - 大于 60 分钟时 m 段自然进位（"75:30" = 1h15m30s 而非 "1:15:30"）。
 *   若后续需要 hh:mm:ss 形态，再加 flag 切换。
 *
 * 之前散落在 TimerDisplay.tsx / MiniPomodoro.tsx / FocusModeOverlay.tsx
 * 三处同名函数实现，命名 / 边界口径都不完全一致；统一到此处。
 */
export function formatMmSs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/**
 * 解析 locale 入参：未传或非 LocaleValue 一律回退到默认 locale。
 *
 * R-fix-i18n-format-date (high)：formatDate.ts 原版硬编码中文，未接入
 * @shared/i18n/locales registry。改为：函数签名额外接收一个可选
 * locale，调用方可以从 settings store 注入；未传时回退到 DEFAULT_LOCALE
 * —— 保留旧 API 行为（保持向后兼容），新代码路径（widget / day section）
 * 通过 useSettingsStore 取当前 language 显式传入即可跟随 locale 切换。
 *
 * 直接复用 toLocaleValue() 完成窄化 —— 单一权威源收敛在
 * @shared/i18n/locales.ts，未来 LOCALE_OPTIONS 增项（如 en-US）时
 * 本函数自动跟随，无需同步修改此处。
 */
function resolveLocale(rawLocale: unknown): LocaleValue {
  return toLocaleValue(rawLocale)
}

/** 「今天 / 明天 / 后天 / N 天后 / N 天前 / MM-DD」
 *
 * 第二个参数 locale 可选：传 '' / undefined 时回退到默认 zh-CN（与
 * 旧行为兼容）；传 settings.language 时跟随 locale 切换。 */
export function formatDayLabel(dayKey: string, locale?: unknown): string {
  const messages = getRelativeTimeMessages(resolveLocale(locale))
  const today = dayKeyOf(new Date())
  const diff = diffDays(fromDayKey(dayKey), fromDayKey(today))
  if (diff === 0) return messages.today
  if (diff === 1) return messages.tomorrow
  if (diff === -1) return messages.yesterday
  if (diff === 2) return messages.dayAfterTomorrow
  if (diff === -2) return messages.dayBeforeYesterday
  if (diff > 0 && diff <= 7) return messages.inNDays(diff)
  if (diff < 0 && diff >= -7) return messages.nDaysAgo(-diff)
  // 跨周：直接 MM-DD
  const [, m, d] = dayKey.split('-')
  const month = Number(m)
  const day = Number(d)
  return messages.mmDd(month, day)
}

/** 「2026-08-31 周日 · 今天」 —— sticky header 用
 *
 * 第二个参数 locale 可选：未传时回退默认 locale；传 settings.language
 * 时跟随 locale 切换。 */
export function formatDayHeader(dayKey: string, locale?: unknown): string {
  const messages = getRelativeTimeMessages(resolveLocale(locale))
  const d = fromDayKey(dayKey)
  const relative = formatDayLabel(dayKey, locale)
  const weekday = messages.weekdayFull[d.getDay()]
  return messages.dayHeaderTemplate(dayKey, weekday, relative)
}

/** 「刚刚 / X 分钟前 / X 小时前 / X 天前 / YYYY-MM-DD」 —— 时间显示
 *
 * 第二个参数 locale 可选：未传时回退默认 locale；传 settings.language
 * 时跟随 locale 切换。 */
export function formatTimeAgo(iso: string | null | undefined, locale?: unknown): string {
  const messages = getRelativeTimeMessages(resolveLocale(locale))
  if (!iso) return messages.timeAgoEmpty
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return messages.timeAgoEmpty
  const diffMs = Date.now() - t
  const sec = Math.floor(diffMs / 1000)
  if (sec < 30) return messages.justNow
  if (sec < 60) return messages.secondsAgo(sec)
  const min = Math.floor(sec / 60)
  if (min < 60) return messages.minutesAgo(min)
  const hr = Math.floor(min / 60)
  if (hr < 24) return messages.hoursAgo(hr)
  const day = Math.floor(hr / 24)
  if (day < 7) return messages.daysAgo(day)
  const d = new Date(iso)
  return dayKeyOf(d)
}
