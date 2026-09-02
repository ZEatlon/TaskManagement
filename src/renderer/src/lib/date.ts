/**
 * 日期工具函数（统一日期处理）
 *
 * 把原本散落在 `today.tsx` / `dashboard.tsx` / `tasks.ts` 里的日期逻辑集中。
 * 注意：所有方法都使用**本地时区**（不转换为 UTC），
 * 与 `dayKeyOf` 的 `YYYY-MM-DD` 字符串语义保持一致。
 */

/** 把 Date 转成 'YYYY-MM-DD'（本地时区） */
export function dayKeyOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 把 'YYYY-MM-DD' 转成本地时区的 Date（时间设为 00:00:00） */
export function fromDayKey(s: string): Date {
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10))
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0)
}

/** 在 d 的基础上加 n 天（n 可以为负数） */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

/** 当天 00:00:00 */
export function startOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

/** 当天 23:59:59.999 */
export function endOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(23, 59, 59, 999)
  return r
}

/** 是否同一天（本地时区） */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** a - b 相差的天数（按 startOfDay 对齐；a > b 返回正数） */
export function diffDays(a: Date, b: Date): number {
  return Math.floor((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000)
}

/** 一天的开始 ISO 时间戳（'YYYY-MM-DDTHH:mm:ss.sssZ'） */
export function startOfDayISO(d: Date): string {
  return startOfDay(d).toISOString()
}

/** 一天的结束 ISO 时间戳 */
export function endOfDayISO(d: Date): string {
  return endOfDay(d).toISOString()
}