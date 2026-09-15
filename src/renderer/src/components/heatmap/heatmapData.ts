/**
 * 热力图数据计算工具
 *
 * 负责把 `Record<string, number>` (YYYY-MM-DD → count)
 * 转换为按周分组的数据，供 Heatmap 组件渲染。
 *
 * 设计：
 * - 每列代表一周（周一→周日或周日→周六，由 firstDayOfWeek 决定）
 * - 起始日期对齐到周首日，结束日期对齐到周末日
 * - level（0~4）按最大值的比例四等分（GitHub 风格）
 * - 每个月第一周额外标记 monthStarts，用于渲染月份分隔
 */
import { startOfDayLocal, localDayKeyOf } from '@shared/lib/dayKey'
import { fromDayKey } from '../../lib/date'

/** 单元格强度等级：0=空，4=最高 */
export type HeatmapLevel = 0 | 1 | 2 | 3 | 4

/** 单格数据 */
export interface HeatmapDay {
  /** YYYY-MM-DD */
  date: string
  /** 当日完成次数（任务或笔记事件） */
  count: number
  /** 颜色档位 0~4 */
  level: HeatmapLevel
  /** 是否在用户请求的 [startDate, endDate] 范围内（用于淡化范围外填充） */
  inRange: boolean
  /** 是否为今天 */
  isToday: boolean
}

/** 单周（7 天） */
export interface HeatmapWeek {
  /** 该周 7 天（顺序与 firstDayOfWeek 对齐） */
  days: HeatmapDay[]
  /** 该周首日的月份与该周在月份分区上的归属（用于月分隔） */
  monthIndex: number
  /** 是否为某个月的第一周（仅在该周首日落在 1~7 号时为 true） */
  isFirstWeekOfMonth: boolean
}

/** 顶部月份标签 —— weekIndex → { label, span } */
export interface HeatmapMonthLabel {
  /** 落在哪一列上方 */
  weekIndex: number
  /** 月份短标签（"1月" / "Jan"） */
  label: string
}

/** 整体热力图数据 */
export interface HeatmapData {
  weeks: HeatmapWeek[]
  /** 顶部月份标签 */
  monthLabels: HeatmapMonthLabel[]
  /** 当前所在年份（用于头部） */
  year: number
  /** 区间内最大 count（用于图例与归一化） */
  maxCount: number
  /** 起始日期（含前置填充） */
  startDate: Date
  /** 结束日期（含后置填充） */
  endDate: Date
  /** 区间内总完成数 */
  totalCount: number
  /** 活跃天数（count > 0） */
  activeDays: number
  /** 当前连续活跃天数（从今天往前数） */
  currentStreak: number
  /** 历史最长连续天数 */
  longestStreak: number
  /** 平均每日完成数 */
  avgPerDay: number
}

/** 一周起始：0=周日，1=周一 */
export type FirstDayOfWeek = 0 | 1

/** 月份短标签默认值（zh-CN）—— 与 R-fix-i18n-weekday-label 同模式：未传
 *  时回退到历史硬编码字典，保持向后兼容；新 caller 从 getCalendarMessages
 *  取出 monthShort 传入。 */
const DEFAULT_MONTH_SHORT_ZH = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
] as const

/**
 * 把 Date / 时间戳转换为 YYYY-MM-DD（本地时区）
 * 本函数保留为 backward-compatible alias —— 实质实现下沉到
 * @shared/lib/dayKey.localDayKeyOf，避免与 main 端 statsBridge /
 * backfill 等 inline 实现分叉。
 */
export function toISODate(d: Date): string {
  return localDayKeyOf(d)
}

/**
 * 解析 YYYY-MM-DD 为本地时区 Date（时:分:秒=0）
 *
 * R32-Corr-1 (low duplication)：原版函数体（s.split('-').map(parseInt) +
 * new Date(y, m-1, d)）与 lib/date.ts:fromDayKey 完全相同；两个名字两份
 * 实现让规则微调（如允许紧凑 YYYYMMDD）容易 drift。改为 re-export，
 * HeatmapTooltip 等既有 import 路径不变，与 lib/date.ts 同一权威源。
 */
export const fromISODate = fromDayKey

/**
 * 根据 count 与 max 计算 5 档颜色等级
 * - count == 0 → 0
 * - 其余按 max 的 25% / 50% / 75% 切分
 */
export function calcLevel(count: number, max: number): HeatmapLevel {
  if (count <= 0 || max <= 0) return 0
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/**
 * 给定 max，返回 5 档 level 的下界（包含 count == 0）。
 * 用于图例标注：每个色块代表"≥ 这个次数"。
 *
 * 算法（与 calcLevel 完全对齐）：
 *   - level 0: count == 0
 *   - level 1: 1 <= count <= max*0.25 → 下界 = 1
 *   - level 2: max*0.25 < count <= max*0.5   → 下界 = floor(max*0.25)+1
 *   - level 3: max*0.5 < count <= max*0.75   → 下界 = floor(max*0.5)+1
 *   - level 4: max*0.75 < count               → 下界 = floor(max*0.75)+1
 *
 * 例：max = 12 → [0, 1, 4, 7, 10]
 *   - level-0: 0 次
 *   - level-1: ≥ 1 次
 *   - level-2: ≥ 4 次
 *   - level-3: ≥ 7 次
 *   - level-4: ≥ 10 次
 */
export function calcLevelThresholds(max: number): [number, number, number, number, number] {
  if (max <= 0) return [0, 0, 0, 0, 0]
  return [
    0,
    1,
    Math.max(2, Math.floor(max * 0.25) + 1),
    Math.max(3, Math.floor(max * 0.5) + 1),
    Math.max(4, Math.floor(max * 0.75) + 1),
  ]
}

/**
 * 调整到所在周的首日（周日=0，周一=1）
 */
function alignToWeekStart(d: Date, firstDayOfWeek: FirstDayOfWeek): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const day = out.getDay()
  const diff = (day - firstDayOfWeek + 7) % 7
  out.setDate(out.getDate() - diff)
  return out
}

/**
 * 调整到所在周的末日（与 firstDayOfWeek 对应的 +6 天）
 */
function alignToWeekEnd(d: Date, firstDayOfWeek: FirstDayOfWeek): Date {
  const start = alignToWeekStart(d, firstDayOfWeek)
  const out = new Date(start)
  out.setDate(out.getDate() + 6)
  return out
}

/**
 * 计算连续活跃天数相关统计
 */
function computeStreaks(
  userStart: Date,
  userEnd: Date,
  dailyCounts: Record<string, number>,
  todayKey: string,
): { currentStreak: number; longestStreak: number } {
  const days: boolean[] = []
  // L7 修复 (low correctness)：原版用 `t += 86400000`（24h）循环 —— 跨
  // DST 切换日（春令前 / 秋令后各一小时）时本地日期会偏移：
  //   - 春令跳 1 小时（本地 23h → 次日 01h），同一 t 落在两个本地日期
  //     → key 算两次 + 漏一个中间日
  //   - 秋令重 1 小时（本地 01h 重复）→ key 漏一天
  // 中国大陆没有 DST 几乎不可见；观察 DST 的用户（美 / 欧）热力图
  // 在切换日附近会少 1 天或重 1 天，连续天数算错。
  // 修复：用 setDate(getDate() + 1) 一天一天推进，Date 内部按本地日期
  // 自然吸收 DST（getDate 在春令/秋令日返回正确日编号）。
  const cursor = startOfDayLocal(userStart)
  const endMs = userEnd.getTime()
  while (cursor.getTime() <= endMs) {
    const key = toISODate(cursor)
    days.push((dailyCounts[key] ?? 0) > 0)
    cursor.setDate(cursor.getDate() + 1)
  }

  let longest = 0
  let run = 0
  for (const active of days) {
    if (active) {
      run += 1
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }

  // currentStreak：从今天往前数。如果今天还未签到，则允许从昨天开始数（避免用户当天 0 显得很挫败）
  let current = 0
  // 直接在 days 里查找 today 的索引，避免 userEnd 与 today 不一致时 todayIdx 错位
  const today = new Date()
  const todayKeyStr = toISODate(today)
  let todayIdx = days.findIndex((_active, i) => {
    const d = new Date(userStart.getTime() + i * 86400000)
    return toISODate(d) === todayKeyStr
  })
  if (todayIdx < 0) todayIdx = Math.max(0, days.length - 1)
  let startIdx = todayIdx
  if (!days[todayIdx] && todayIdx > 0 && days[todayIdx - 1]) {
    startIdx = todayIdx - 1
  }
  for (let i = startIdx; i >= 0; i -= 1) {
    if (days[i]) current += 1
    else break
  }
  void todayKey // 保留接口一致性

  return { currentStreak: current, longestStreak: longest }
}

/**
 * 主入口：构建完整热力图数据
 *
 * @param dailyCounts  日期到完成数的映射（来自 IPC）
 * @param startDate    区间起始（用户视角）
 * @param endDate      区间结束（用户视角）
 * @param firstDayOfWeek  一周起始日，默认周日（GitHub 风格）
 */
export function buildHeatmap(
  dailyCounts: Record<string, number>,
  startDate: Date,
  endDate: Date,
  firstDayOfWeek: FirstDayOfWeek = 0,
  monthShort: readonly string[] = DEFAULT_MONTH_SHORT_ZH,
): HeatmapData {
  // 归一化起止日期
  const userStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
  const userEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())

  // 对齐到周首/末
  const gridStart = alignToWeekStart(userStart, firstDayOfWeek)
  const gridEnd = alignToWeekEnd(userEnd, firstDayOfWeek)

  // 今天（用于 isToday 标记）
  const today = new Date()
  const todayKey = toISODate(today)

  // 计算最大 count（仅在用户区间内）
  let maxCount = 0
  let totalCount = 0
  let activeDays = 0
  // L-Fix (low correctness)：与同文件 computeStreaks 对齐。原版用
  // `t += 86400000`（24h UTC 步进），在本地 DST 切换日（春令 23h / 秋令 25h）
  // 会让某一天要么算两次要么漏一天，导致 maxCount / totalCount / activeDays
  // 错算，level 颜色档位整体偏移。改用 cursor.setDate() 一天一天推进，
  // Date 内部按本地日期自然吸收 DST 偏移。
  const cursor = new Date(userStart)
  const endMs = userEnd.getTime()
  while (cursor.getTime() <= endMs) {
    const key = toISODate(cursor)
    const c = dailyCounts[key] ?? 0
    if (c > maxCount) maxCount = c
    totalCount += c
    if (c > 0) activeDays += 1
    cursor.setDate(cursor.getDate() + 1)
  }

  // 构建周列表 + 月份标签
  const weeks: HeatmapWeek[] = []
  const monthLabels: HeatmapMonthLabel[] = []
  // L-Fix (low correctness)：同上 —— 用 cursor.setDate() 推进，避免 Math.round
  // 在跨 DST 切换日时假设"每天恰好 86400000ms"而引入 ±1 天误差（实践中
  // 单纯 ±1h 偏移靠 Math.round(+1) 仍能 round 到正确整数，但与上面 cursor
  // 模式不一致更难审计；这里换成同样的 cursor 推进，逻辑统一也更稳）。
  const gridCursor = new Date(gridStart)
  const gridEndMs = gridEnd.getTime()
  let totalDays = 0
  while (gridCursor.getTime() <= gridEndMs) {
    totalDays += 1
    gridCursor.setDate(gridCursor.getDate() + 1)
  }
  const weekCount = totalDays / 7

  let lastMonthIdx = -1
  for (let w = 0; w < weekCount; w += 1) {
    const days: HeatmapDay[] = []
    const firstDateOfWeek = new Date(gridStart)
    firstDateOfWeek.setDate(firstDateOfWeek.getDate() + w * 7)
    const monthIdx = firstDateOfWeek.getMonth()

    // 标记"该周首日为月份 1~7 号"为该月第一周 → 顶部显示月份
    const isFirstWeekOfMonth = firstDateOfWeek.getDate() <= 7 && monthIdx !== lastMonthIdx
    if (isFirstWeekOfMonth) {
      monthLabels.push({ weekIndex: w, label: monthShort[monthIdx] ?? '' })
      lastMonthIdx = monthIdx
    }

    for (let d = 0; d < 7; d += 1) {
      const date = new Date(gridStart)
      date.setDate(date.getDate() + w * 7 + d)
      const key = toISODate(date)
      const count = dailyCounts[key] ?? 0
      const inRange = date >= userStart && date <= userEnd
      days.push({
        date: key,
        count,
        level: calcLevel(count, maxCount),
        inRange,
        isToday: key === todayKey,
      })
    }
    weeks.push({ days, monthIndex: monthIdx, isFirstWeekOfMonth })
  }

  // 连续天数
  const { currentStreak, longestStreak } = computeStreaks(
    userStart,
    userEnd,
    dailyCounts,
    todayKey,
  )

  const totalRangeDays =
    Math.round((userEnd.getTime() - userStart.getTime()) / 86400000) + 1
  const avgPerDay = totalRangeDays > 0 ? totalCount / totalRangeDays : 0

  return {
    weeks,
    monthLabels,
    year: userEnd.getFullYear(),
    maxCount,
    startDate: userStart,
    endDate: userEnd,
    totalCount,
    activeDays,
    currentStreak,
    longestStreak,
    avgPerDay,
  }
}

/**
 * 便捷工具：根据"过去 N 天"构建（默认 365）
 * endDate 默认为今天（本地）
 *
 * 智能对齐：
 *   - days >= 365 时 → 整年对齐到 endDate 所在自然年的 [Jan 1, Dec 31]
 *     （用户需求：「贡献热力图」要看到完整全年方块，不只是过去 365 天滚动窗口）
 *   - days < 365 时 → 保持原有"过去 N 天"语义
 *
 * 这样今天（2026-08-31）打开热力图，看到的就是 2026-01-01 → 2026-12-31 的全年网格，
 * 未来日期的格子会被淡化（out-of-range）。
 */
export function buildHeatmapLastNDays(
  dailyCounts: Record<string, number>,
  days = 365,
  endDate: Date = new Date(),
  firstDayOfWeek: FirstDayOfWeek = 0,
  monthShort: readonly string[] = DEFAULT_MONTH_SHORT_ZH,
): HeatmapData {
  const ref = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
  let start: Date
  let end: Date
  if (days >= 365) {
    // 整年：endDate 所在年的 Jan 1 → Dec 31
    start = new Date(ref.getFullYear(), 0, 1)
    end = new Date(ref.getFullYear(), 11, 31)
  } else {
    end = ref
    start = new Date(ref)
    start.setDate(start.getDate() - (days - 1))
  }
  return buildHeatmap(dailyCounts, start, end, firstDayOfWeek, monthShort)
}

/**
 * 工具：把周内的索引（0~6）转成周几标签。
 *
 * 历史：原版硬编码返回 ['日','一',…,'六']，与 settings.language 完全脱钩。
 * R-fix-i18n-weekday-label (medium)：增加第三个可选参数 weekdayShort
 * （长度固定 7 的字符串数组，Sunday=0 → Saturday=6），由调用方从
 * @shared/i18n/locales.getCalendarMessages().weekdayShort 传入，实现
 * 跟随 locale 切换（zh-CN: ['日','一',…,'六']；未来 en-US:
 * ['Sun','Mon',…,'Sat']）。
 *
 * 保持向后兼容：第三个参数可选，未传时回退原版中文 7 项 —— 历史 callers
 * 与单元测试不必改一行代码；新 caller（Heatmap / HeatmapWidget /
 * FocusCalendar）从 getCalendarMessages 取字典传入。
 */
export function weekdayLabel(
  weekdayIndex: number,
  firstDayOfWeek: FirstDayOfWeek = 0,
  weekdayShort?: readonly string[],
): string {
  const labels = weekdayShort ?? DEFAULT_WEEKDAY_SHORT_ZH
  const idx = (weekdayIndex + firstDayOfWeek) % 7
  return labels[idx] ?? ''
}

/** 与 R-fix-i18n-weekday-label (medium) 同时新增：原硬编码字典的内部 alias，
 *  拆出 const 是为了让可选参数 `??` 有一个明确默认值（避免在签名里写
 *  array literal 引起 lint 重复）。 */
const DEFAULT_WEEKDAY_SHORT_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const
