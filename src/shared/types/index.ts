/**
 * 共享类型定义
 * 主进程、preload、渲染进程共用
 * 业务实体的类型在此集中声明
 */

/** ISO 字符串时间 */
export type ISODateTime = string

/** 通用 ID（uuid v4 或 nanoid） */
export type ID = string

/** 优先级枚举 */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3'

/** 标签（支持嵌套，用 parentId 表达层级） */
export interface Tag {
  id: ID
  name: ID
  parentId: ID | null
  color: string | null
  order: number
  createdAt: ISODateTime
  // R17 修复 (high correctness)：tags.update 用作 CAS predicate 的版本列。
  // 原 created_at 由 create() 写入后所有后续 update() 都不修改 → 并发
  // CAS 失效。详见 src/main/db/migrations/010-tags-updated-at.sql。
  updatedAt: ISODateTime
}

/** 笔记文件夹（与便签 palette 共用色） */
export type NoteFolderColor =
  | 'yellow'
  | 'pink'
  | 'blue'
  | 'green'
  | 'orange'
  | 'purple'
  | 'teal'
  | 'rose'

/** 笔记文件夹实体 —— 用于把多个笔记组织成一组 */
export interface NoteFolder {
  id: ID
  name: string
  color: NoteFolderColor | null
  order: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

/** 笔记元数据 */
export interface NoteMeta {
  id: ID
  path: string
  filename: string
  title: string
  size: number
  mtime: ISODateTime
  ctime: ISODateTime
  tags: string[]
  isPinned: boolean
  isFavorite: boolean
  /** 归属文件夹；null = 未分类 */
  folderId: ID | null
}

/** 笔记完整内容 */
export interface Note extends NoteMeta {
  content: string
}

/** 数据库状态 */
export interface DbStatus {
  initialized: boolean
  version: number
  path: string
  sizeBytes: number
}

/** 历史回填单条结果（任务完成 / 笔记事件共用） */
export interface BackfillResult {
  scanned: number
  inserted: number
  skipped: boolean
  durationMs: number
}

/** runAllBackfills 聚合结果 */
export interface BackfillSummary {
  completions: BackfillResult
  noteEvents: BackfillResult
}

/* ============================================================================
 * 便签（多级待办）—— 统一的任务实体
 *
 * 一张便签 = 一组任务（subject + multiple steps）：
 *   - 1 级 = 便签标题 + 优先级 + 归属日 + 状态 + 截止时间 + 标签 + ...
 *   - 2 级 = sticky_note_steps（每个步骤的 content + done）
 *
 * 历史上叫"任务（Task）"的概念已全部合入此类型；不再有 Task 类型。
 * ========================================================================== */

/** sticky 整体状态（取代原 TaskStatus） */
export type StickyStatus = 'todo' | 'in_progress' | 'done' | 'cancelled'

/** sticky 主题色：缺省时按 priority 派生 4 色；用户可选 8 色覆盖 */
export type StickyColor =
  | 'yellow'
  | 'pink'
  | 'blue'
  | 'green'
  | 'orange'
  | 'purple'
  | 'teal'
  | 'rose'

/** sticky 重复规则类型（频率） */
export type StickyRecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** sticky 重复规则（RRULE 子集，序列化存储到 recurrence TEXT） */
export interface StickyRecurrence {
  freq: StickyRecurrenceFreq
  interval: number
  byweekday?: number[]
  bymonthday?: number[]
  count?: number
  until?: ISODateTime
  rruleString: string
}

/** 便签步骤（2级目录：具体内容） */
export interface StickyNoteStep {
  id: ID
  noteId: ID
  content: string
  done: boolean
  order: number
  createdAt: ISODateTime
}

/** 便签实体 —— 统一的任务实体 */
export interface StickyNote {
  id: ID
  title: string
  date: string // YYYY-MM-DD（便签归属日，本地时区）
  priority: Priority

  // === 以下为原 tasks 字段，迁移合入 ===
  status: StickyStatus
  description: string | null
  scheduledAt: ISODateTime | null
  dueAt: ISODateTime | null
  completedAt: ISODateTime | null
  tags: ID[]
  /** RRULE 字符串（重复规则）；解析/构造在仓储层 */
  recurrence: string | null
  estimatedMinutes: number | null
  actualMinutes: number | null
  pomodoroCount: number
  starred: boolean
  archived: boolean

  // === 新增：用户主题色覆盖 ===
  color: StickyColor | null

  steps: StickyNoteStep[]
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

/** 便签创建入参 */
export interface StickyNoteCreate {
  title: string
  date: string
  priority: Priority
  status?: StickyStatus
  description?: string | null
  scheduledAt?: ISODateTime | null
  dueAt?: ISODateTime | null
  tags?: ID[]
  color?: StickyColor | null
  recurrence?: string | null
  estimatedMinutes?: number | null
  starred?: boolean
  steps: Array<{ content: string; done?: boolean; order?: number }>
}

/** 便签更新 patch（不含 steps，steps 通过独立 API 操作） */
export type StickyNoteUpdate = Partial<{
  title: string
  date: string
  priority: Priority
  status: StickyStatus
  description: string | null
  scheduledAt: ISODateTime | null
  dueAt: ISODateTime | null
  completedAt: ISODateTime | null
  tags: ID[]
  color: StickyColor | null
  recurrence: string | null
  estimatedMinutes: number | null
  actualMinutes: number | null
  pomodoroCount: number
  starred: boolean
  archived: boolean
}>

/** 便签步骤更新 patch */
export interface StickyNoteStepPatch {
  content?: string
  done?: boolean
  order?: number
}

/** 便签过滤条件（仓储 + IPC 共用） */
export interface StickyNoteFilter {
  status?: StickyStatus | StickyStatus[]
  priority?: Priority | Priority[]
  starred?: boolean
  archived?: boolean
  dueBefore?: string // YYYY-MM-DD
  dueAfter?: string
  scheduledBefore?: string
  scheduledAfter?: string
  tags?: ID[]
  limit?: number
}

/** 便签搜索选项（仓储 + IPC 共用） */
export interface StickyNoteSearchOptions {
  query: string
  includeArchived?: boolean
  limit?: number
}