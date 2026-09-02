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

/** 中文月份短标签 */
const MONTH_LABELS_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

/**
 * 把 Date / 时间戳转换为 YYYY-MM-DD（本地时区）
 */
export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 解析 YYYY-MM-DD 为本地时区 Date（时:分:秒=0）
 */
export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10))
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

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
  for (let t = userStart.getTime(); t <= userEnd.getTime(); t += 86400000) {
    const key = toISODate(new Date(t))
    days.push((dailyCounts[key] ?? 0) > 0)
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
  for (let t = userStart.getTime(); t <= userEnd.getTime(); t += 86400000) {
    const date = new Date(t)
    const key = toISODate(date)
    const c = dailyCounts[key] ?? 0
    if (c > maxCount) maxCount = c
    totalCount += c
    if (c > 0) activeDays += 1
  }

  // 构建周列表 + 月份标签
  const weeks: HeatmapWeek[] = []
  const monthLabels: HeatmapMonthLabel[] = []
  const totalDays =
    Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000) + 1
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
      monthLabels.push({ weekIndex: w, label: MONTH_LABELS_ZH[monthIdx] ?? '' })
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
  return buildHeatmap(dailyCounts, start, end, firstDayOfWeek)
}

/**
 * 工具：把周内的索引（0~6）转成周几标签（中文）
 */
export function weekdayLabel(weekdayIndex: number, firstDayOfWeek: FirstDayOfWeek = 0): string {
  const labels = ['日', '一', '二', '三', '四', '五', '六']
  const idx = (weekdayIndex + firstDayOfWeek) % 7
  return labels[idx]
}
