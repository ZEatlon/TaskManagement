/**
 * 跨进程共享的优先级 / sticky 状态枚举权威源
 *
 * 历史来源：validators.ts（main）单文件维护 `VALID_PRIORITIES` /
 * `VALID_STICKY_STATUSES`，但全栈 9+ 处分别硬编码 'p0..p3' / 'todo..cancelled'
 * 字面量。R36 修复后统一收口在本文件：
 *   - PRIORITIES / STICKY_STATUSES：常量数组（喂 JSON Schema enum）
 *   - PRIORITY_RANK / STICKY_STATUS_RANK：排序权重
 *   - PRIORITY_SET / STICKY_STATUS_SET：O(1) 校验白名单（IPC handler、
 *     repo、LLM input 防御共用）
 *
 * 与 @shared/types 联合类型（Priority / StickyStatus）严格对齐。新增
 * p-1 / cancelled 子状态时，只改本文件即可让全栈同步生效。
 */
import type { Priority, StickyStatus } from '@shared/types'

/** 优先级数组（喂 JSON Schema enum，按顺序 = 排序权重） */
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const satisfies readonly Priority[]

/** sticky status 数组（喂 JSON Schema enum） */
export const STICKY_STATUSES = [
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const satisfies readonly StickyStatus[]

/** O(1) 校验白名单 */
export const PRIORITY_SET: ReadonlySet<string> = new Set<string>(PRIORITIES)

/** O(1) 校验白名单 */
export const STICKY_STATUS_SET: ReadonlySet<string> = new Set<string>(STICKY_STATUSES)

/**
 * 优先级的 SR-友好标签映射。
 *
 * R36 修复 (medium a11y)：QuickCaptureOverlay 之前直接渲染 `p.toUpperCase()`
 * （"P0"），屏幕阅读器读出"P zero"对用户毫无意义；StickyPriorityBadge
 * 内部又有自己的 META.label 副本。同源化到本文件，让两处 select 的
 * <option> 都用语义化文本（"P0 紧急" / "P1 高" / "P2 中" / "P3 低"），
 * 既消除重复又保证 NVDA/VoiceOver 能让用户在 QuickCapture 里区分紧急度。
 */
export const PRIORITY_LABEL: Record<Priority, string> = {
  p0: 'P0 紧急',
  p1: 'P1 高',
  p2: 'P2 中',
  p3: 'P3 低',
}

/**
 * 排序权重：值越小越靠前（p0 最优先）。
 * 替代散落的 `{p0:0,p1:1,p2:2,p3:3}` 字面量；不在白名单内返回大数推到最后。
 */
export const PRIORITY_RANK: Record<Priority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
}

export function priorityRankOf(p: string): number {
  if (p === 'p0' || p === 'p1' || p === 'p2' || p === 'p3') {
    return PRIORITY_RANK[p]
  }
  return Number.MAX_SAFE_INTEGER
}