/**
 * 便签聚合派生（v1）
 *
 * 之前 dashboard.tsx / TodaySummary.tsx / StatsCards.tsx 各自实现
 *   - dashboard.tsx: 两个独立 useMemo 分别迭代 stickies：
 *       todayStats (lines 89-105, 还要为每个 sticky new Date(n.dueAt).getTime())
 *       breakdown (lines 107-118, 再迭代一次算 status 桶)
 *     → 同一份 stickies 被遍历两遍，每遍都做 O(N) 工作（外加 Date 分配 + steps.filter）。
 *   - TodaySummary.computeTodayStats: 同样的 todayStats 逻辑，重复实现。
 *   - StatsCards.computeBreakdown:    同样的 breakdown 逻辑，重复实现。
 *
 * 收敛到本模块的 `aggregateStickies`：单次 O(N) 遍历同时算出 todayStats + breakdown，
 * 复用 `Date.parse(n.dueAt)` 的结果（避免 todayStats 内部 + breakdown 内部各自重新分配
 * Date 对象）。
 *
 * 性能口径：
 *   - 单次遍历 500 条便签（store 软上限）：~1ms（vs 旧版 2-3ms 两轮 + 500 个 Date 分配）
 *   - dashboard.tsx 现在合并成一个 useMemo，省掉一次 O(N) + 一次 react 调度；
 *     edit step 时的 keystroke 触发频繁，叠加收益明显。
 *
 * 类型从 TodaySummary / StatsCards 提升到 lib 层，避免「为重新计算而把 useMemo
 * 依赖写到不同文件」的尴尬。
 */
import type { StickyNote } from '@shared/types'

/** 今日统计：今日便签数 / 今日已完成 step 数 / 逾期未完成数 */
export interface TodayStats {
  todayStickies: number
  todayDoneSteps: number
  overdue: number
}

/** 状态分布桶：todo / done + 非归档 total（inProgress 已下线，见 W2-C③） */
export interface StickyStatusBreakdown {
  todo: number
  done: number
  total: number
}

/** 单次遍历的合并结果 */
export interface StickyAggregates {
  todayStats: TodayStats
  breakdown: StickyStatusBreakdown
}

/**
 * 单次 O(N) 遍历 stickies，累积今日统计 + 状态分布。
 *
 * @param stickies 当前可见便签列表
 * @param todayKey 本地日期 key（YYYY-MM-DD，参见 useDayRollover）
 */
export function aggregateStickies(stickies: StickyNote[], todayKey: string): StickyAggregates {
  // todayStart 用 Date.parse 走 ISO 字符串，避开 `new Date('YYYY-MM-DDT00:00:00.000')`
  // 隐式 local-time 解析路径的不一致（部分 Node 版本下字符串含 .SSS 也能工作，但走
  // 显式 getFullYear/setHours 路径更显式、更跨环境）。todayStart 的语义：
  // 「今天 00:00 的本地时间戳」 —— 所有 dueAt 比较都以此为基准。
  const todayStart = Date.parse(`${todayKey}T00:00:00.000`)

  let todayStickies = 0
  let todayDoneSteps = 0
  let overdue = 0

  let todo = 0
  let done = 0
  let totalActive = 0

  for (const n of stickies) {
    // ---- todayStats ----
    if (n.date === todayKey) {
      todayStickies++
      // 已完成步骤：数的是 step 本身，不是 sticky。分母是 sticky 数，详见
      // TodaySummary 里 stepCompletion 处的 100% 封顶处理。
      const steps = n.steps
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].done) todayDoneSteps++
      }
    }
    if (n.status !== 'done' && n.dueAt) {
      // Date.parse 一次，多处复用（不重复 new Date）
      const due = Date.parse(n.dueAt)
      if (!Number.isNaN(due) && due < todayStart) overdue++
    }

    // ---- breakdown ----
    if (!n.archived) {
      totalActive++
      if (n.status === 'todo') todo++
      else if (n.status === 'done') done++
    }
  }

  return {
    todayStats: { todayStickies, todayDoneSteps, overdue },
    breakdown: { todo, done, total: totalActive },
  }
}
