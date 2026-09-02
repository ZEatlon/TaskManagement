/**
 * 本地日期工具（YYYY-MM-DD）
 *
 * 把原本散落在各处的 `new Date().toISOString().slice(0, 10)` 集中。
 * ISO string 是 UTC，slice 取的也是 UTC day —— 在 UTC+8 / UTC-12 时区，
 * 跨过本地 00:00 时会把便签 / 通知写到「昨天」。
 *
 * 用本文件的 localDayKeyOf() 拿「本地」日期，与 stickyNotes.localDayKeyOf 同语义。
 */
export function localDayKeyOf(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}