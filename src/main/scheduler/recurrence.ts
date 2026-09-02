/**
 * 重复规则计算（RRULE 子集）
 *
 * 包装 rrule 包，提供两个高层 API：
 *   - nextOccurrence(rruleString, after?): 下一次触发时间
 *   - between(rruleString, start, end): 区间内所有触发
 *
 * 输入为 iCalendar RRULE 字符串（不含 DTSTART，例如 "FREQ=DAILY;INTERVAL=2"）。
 * dtstart 必须由调用方提供，默认使用当前时间。
 */
import { RRule, rrulestr } from 'rrule'
import log from '../log'

/** 解析 RRULE 字符串为 RRule 对象；解析失败返回 null */
function parse(rruleString: string, dtstart?: Date): RRule | null {
  try {
    const start = dtstart ?? new Date()
    // 用 rrulestr 更宽容，允许不写 DTSTART 的纯 RRULE 行
    const rule = rrulestr(`DTSTART:${formatICal(start)}\nRRULE:${rruleString}`) as RRule
    return rule
  } catch (err) {
    log.warn('[recurrence] parse failed:', rruleString, (err as Error).message)
    return null
  }
}

// R11 修复 (medium #24)：原版硬编码 UTC（`...Z` 后缀），dtstart 一律当 UTC 处理。
// 用户设置「每天 9:00 提醒」时若 dtstart 是本地 9:00，rrule 会按 UTC 9:00 计算
// 后续发生时间，漂移 = 用户时区偏移小时数（中国大陆 = UTC+8 → 漂 8 小时）；
// 观察 DST 的地区在切换日会再漂 ±1 小时。改为发本地时间（无 Z），rrule
// 把 DTSTART 当 floating/local 处理 —— 后续发生时间按本地时钟自然推进，
// DST 由 JS Date 对象本身吸收。
function formatICal(d: Date): string {
  // YYYYMMDDTHHMMSS（本地时间，无 Z）
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * 下一次触发时间。
 * @param rruleString RRULE 字符串（不含 DTSTART）
 * @param after 起始时间，默认 now
 * @param dtstart DTSTART，默认 now
 */
export function nextOccurrence(
  rruleString: string,
  after: Date = new Date(),
  dtstart?: Date,
): Date | null {
  const rule = parse(rruleString, dtstart)
  if (!rule) return null
  const next = rule.after(after, false)
  return next ?? null
}

/**
 * 区间内所有触发时间（含 start, 不含 end）。
 * 返回按时间升序的 Date 数组。
 */
export function between(
  rruleString: string,
  start: Date,
  end: Date,
  dtstart?: Date,
): Date[] {
  const rule = parse(rruleString, dtstart)
  if (!rule) return []
  try {
    // 第三个参数 inc: true 表示 start 边界若恰为一次发生则包含
    return rule.between(start, end, true)
  } catch (err) {
    log.warn('[recurrence] between failed:', (err as Error).message)
    return []
  }
}

/**
 * 工具：从 RecurrenceRule 结构构造 RRULE 字符串（与 repository 保持互逆）。
 */
export interface SimpleRecurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  byweekday?: number[]
  bymonthday?: number[]
  count?: number
  until?: string
}

export function toRRuleString(rule: SimpleRecurrence): string {
  const parts: string[] = []
  parts.push(`FREQ=${rule.freq.toUpperCase()}`)
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byweekday && rule.byweekday.length > 0) {
    parts.push(`BYDAY=${rule.byweekday.join(',')}`)
  }
  if (rule.bymonthday && rule.bymonthday.length > 0) {
    parts.push(`BYMONTHDAY=${rule.bymonthday.join(',')}`)
  }
  if (typeof rule.count === 'number') parts.push(`COUNT=${rule.count}`)
  if (rule.until) {
    const u = new Date(rule.until)
    parts.push(`UNTIL=${formatICal(u)}`)
  }
  return parts.join(';')
}