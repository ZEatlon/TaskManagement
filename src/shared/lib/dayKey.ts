/**
 * 跨进程共享的本地日期工具（YYYY-MM-DD）
 *
 * 把原本散落在各处的 `new Date().toISOString().slice(0, 10)` 集中。
 * ISO string 是 UTC，slice 取的也是 UTC day —— 在 UTC+8 / UTC-12 时区，
 * 跨过本地 00:00 时会把便签 / 通知写到「昨天」。
 *
 * 本文件位于 src/shared/lib/，main / preload / renderer 三端共用，
 * 避免 IPC 边界两侧 date key 漂移（比如一边 '2025-01-02' 一边 '1-2'，
 * 造成 sticky_notes.date 的 INSERT ... ON CONFLICT 写入成功但读不出来）。
 */

/** 把 Date 转成 'YYYY-MM-DD'（本地时区，padStart 2 位） */
export function localDayKeyOf(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 返回 d 当天本地 00:00:00.000 的 Date（不修改 d 本身）。
 *
 * 之前 `setHours(0,0,0,0)` 写法散落在 main / renderer 7 处（backfill、
 * pomodoroService.listToday、statsBridge、HeatmapTooltip、heatmapData、
 * UpcomingStickies、StatsCards），各自 new Date 拷贝逻辑重复。
 * 统一到此处，避免后续增加「weekStartOf / monthStartOf」等变体时再次漂移。
 */
export function startOfDayLocal(d: Date = new Date()): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

/** startOfDayLocal 别名 —— 与 renderer/lib/date.ts 的 startOfDay 同语义，
 *  单独导出避免 IPC 边界要重复 import renderer 端工具。 */
export const startOfDay = startOfDayLocal

/**
 * YYYY-MM-DD 字面格式正则（无 anchors / flags —— JSON Schema 风格）。
 *
 * 历史上在 4 处独立 hardcode（tools/validators.parseSafeDayKey /
 * ai/navigateBridge.parseRoute 内联块 / ipc/sticky-note-handlers 的
 * YMD_RE / db/repositories/completions 的 YMD_RE）外加 5 处 JSON Schema
 * pattern（pomodoro.ts navigate.date / sticky.ts createSticky.date /
 * updateSticky.date / completeSticky.date / batchUpdateStickies.patch.date）
 * 也是同一字面量。规则微调（YYYYMMDD 紧凑格式、宽松分隔符、本地 vs UTC
 * 时区判定等）需要 9 处同步修改，漏改概率高（R-fix-createSticky-date-
 * silent-fallback 与 R-fix-batchUpdateStickies-date-no-pattern 时已经
 * 踩过同类问题）。
 *
 * 收口到 @shared/lib/dayKey 一处，9 处全部引用此常量。
 */
export const DAY_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/

/**
 * DAY_KEY_RE 的字面正则源（不带前后 `/` 与 flags）—— 喂给 JSON Schema
 * `pattern` 字段用。与 DAY_KEY_RE 同源同义，避免 schema 阶段 inline
 * 复刻同一字面量。
 *
 * 必须是字符串（`.source`），不是 RegExp —— JSON Schema 反序列化
 * （LLM 工具集 / IPC 序列化）会把 RegExp 拍平成空对象，pattern 字段丢失。
 */
export const DAY_KEY_SCHEMA_PATTERN: string = DAY_KEY_RE.source

/**
 * 校验字符串是否为合法 YYYY-MM-DD 日期（UTC 语义）。
 *
 * 用于：AI 工具 execute（parseSafeDayKey / navigateBridge.parseRoute）、
 * completions.record 写库前校验——与 DB `WHERE date = ?` 的语义对齐，
 * 必须确实存在这一天（防 2025-02-30 之类被 Date 解析滑到 03-02 误判为合法）。
 *
 * 返回 boolean：true 表示字面 + 真实日期均合法，可直接当 day key 用。
 */
export function isValidDayKey(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!DAY_KEY_RE.test(value)) return false
  const [y, m, d] = value.split('-').map((n) => Number(n))
  const dt = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(dt.getTime()) &&
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  )
}

/**
 * 与 localDayKeyOf() 语义一致的本地时区校验。
 *
 * 用于：ipc/sticky-note-handlers 写入 sticky_notes.date 前校验。
 * 原版用 UTC 校验在东八区会产生假阴性（早上 8 点前创建"今天"的便签会被
 * 拒），因为 'YYYY-MM-DDT00:00:00' 被 JS 当成本地时间，UTC 视角下已经
 * 跨到昨天；改为本地时区后与 dayKeyOf() 一一对应，不会再误拒。
 *
 * 与 isValidDayKey 的差异：时区锚点不同（UTC vs 本地），其它字面 + 真实
 * 日期判定完全相同。两个 helper 同源（DAY_KEY_RE）以避免规则微调漂移。
 */
export function isValidDayKeyLocal(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!DAY_KEY_RE.test(value)) return false
  const dt = new Date(`${value}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return false
  return (
    dt.getFullYear() === Number(value.slice(0, 4)) &&
    dt.getMonth() + 1 === Number(value.slice(5, 7)) &&
    dt.getDate() === Number(value.slice(8, 10))
  )
}
