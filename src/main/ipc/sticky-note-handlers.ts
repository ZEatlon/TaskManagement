/**
 * 便签（多级待办 / 统一任务实体）IPC 处理器
 *
 * 提供 15 个通道：
 *   - 基础 CRUD（5）：list / get / create / update / delete
 *   - Step CRUD（3）：add-step / update-step / remove-step
 *   - 统一后新增的能力（7）：
 *       complete / set-status / archive / toggle-starred /
 *       search / list-filtered / record-completion
 */
import { handle } from './channels'
import { stickyNotesRepo } from '../db/repositories/stickyNotes'
import { invalidateStickyTitle } from '../pomodoro/pomodoroService'
import { ackPendingDue } from '../notifications/notify'
import type {
  ID as IDType,
  StickyNoteCreate,
  StickyNoteUpdate,
  StickyNoteStepPatch,
  StickyStatus,
  StickyNoteFilter,
  StickyNoteSearchOptions,
} from '@shared/types'
import { IPC_CHANNELS } from '@shared/ipc/channels'

/**
 * R12 修复 (medium)：sticky-note:create / update 的入参边界检查。被攻击渲染端
 * 可注入 100MB description 或 100k step rows 阻塞 IPC。handler 层做轻量上限。
 */
const MAX_TITLE_BYTES = 500
const MAX_DESCRIPTION_BYTES = 50_000
const MAX_STEPS = 200
const MAX_STEP_CONTENT_BYTES = 2_000
const MAX_TAGS = 100

// R33-Corr-3 修复 (MEDIUM validate-sticky-input-no-enum-checks)：原版只
// 校验 title / description / steps / tags.length，但 priority / status /
// color / recurrence / date / scheduledAt / dueAt 这些 enum/ISO 字段都不
// 校验。被攻击渲染端（或前落后于 schema bump 的旧渲染端）可注入
// `{priority: 'p9', status: 'weird', recurrence: 'hourly'}` 之类垃圾，
// 直入 SQLite TEXT 列污染下游 filter / sort / 通知调度。修复：enum
// allowlist + 日期/ISO 解析校验。defense-in-depth —— stickyNotesRepo.create
// 也跑这套。
const ALLOWED_PRIORITY: ReadonlySet<string> = new Set(['p0', 'p1', 'p2', 'p3'])
const ALLOWED_STATUS: ReadonlySet<string> = new Set([
  'todo', 'in_progress', 'done', 'cancelled',
])
const ALLOWED_RECURRENCE: ReadonlySet<string> = new Set([
  'none', 'daily', 'weekly', 'monthly',
])
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDayKey(s: string): boolean {
  if (!YMD_RE.test(s)) return false
  const d = new Date(s + 'T00:00:00')
  return !Number.isNaN(d.getTime())
    && d.getUTCFullYear() === Number(s.slice(0, 4))
    && d.getUTCMonth() + 1 === Number(s.slice(5, 7))
    && d.getUTCDate() === Number(s.slice(8, 10))
}

function isValidIsoOrNull(s: unknown): boolean {
  if (s === null || s === undefined) return true
  if (typeof s !== 'string') return false
  if (s === '') return true // null 与 undefined 已跳过；空串视为清空
  const t = Date.parse(s)
  return Number.isFinite(t)
}

function validateStickyInput(input: {
  title?: string | null
  description?: string | null
  steps?: Array<{ content: string }>
  tags?: unknown
  // R33-Corr-3：扩 7 个新可选字段
  priority?: string
  status?: string
  color?: string | null
  recurrence?: string | null
  date?: string
  scheduledAt?: string | null
  dueAt?: string | null
}): void {
  if (input.title !== undefined && input.title !== null
      && Buffer.byteLength(input.title, 'utf8') > MAX_TITLE_BYTES) {
    throw new Error(`sticky-note: title exceeds ${MAX_TITLE_BYTES} bytes`)
  }
  if (input.description !== undefined && input.description !== null
      && Buffer.byteLength(input.description, 'utf8') > MAX_DESCRIPTION_BYTES) {
    throw new Error(`sticky-note: description exceeds ${MAX_DESCRIPTION_BYTES} bytes`)
  }
  if (input.steps !== undefined) {
    if (input.steps.length > MAX_STEPS) {
      throw new Error(`sticky-note: steps length exceeds ${MAX_STEPS}`)
    }
    for (const s of input.steps) {
      if (typeof s.content !== 'string'
          || Buffer.byteLength(s.content, 'utf8') > MAX_STEP_CONTENT_BYTES) {
        throw new Error(`sticky-note: each step content must be string <= ${MAX_STEP_CONTENT_BYTES} bytes`)
      }
    }
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS) {
      throw new Error(`sticky-note: tags must be array, length <= ${MAX_TAGS}`)
    }
  }
  // R33-Corr-3 续：枚举/格式校验（仅校验显式传入的字段，undefined = 不动）
  if (input.priority !== undefined && !ALLOWED_PRIORITY.has(input.priority)) {
    throw new Error(`sticky-note: priority must be one of ${[...ALLOWED_PRIORITY].join(',')}`)
  }
  if (input.status !== undefined && !ALLOWED_STATUS.has(input.status)) {
    throw new Error(`sticky-note: status must be one of ${[...ALLOWED_STATUS].join(',')}`)
  }
  if (input.recurrence !== undefined
      && input.recurrence !== null
      && !ALLOWED_RECURRENCE.has(input.recurrence)) {
    throw new Error(`sticky-note: recurrence must be one of ${[...ALLOWED_RECURRENCE].join(',')}`)
  }
  if (input.color !== undefined
      && input.color !== null
      && (typeof input.color !== 'string' || !HEX_COLOR_RE.test(input.color))) {
    throw new Error(`sticky-note: color must match ${HEX_COLOR_RE}`)
  }
  if (input.date !== undefined && (typeof input.date !== 'string' || !isValidDayKey(input.date))) {
    throw new Error('sticky-note: date must be YYYY-MM-DD and a real calendar date')
  }
  if (!isValidIsoOrNull(input.scheduledAt)) {
    throw new Error('sticky-note: scheduledAt must be parseable ISO timestamp or null')
  }
  if (!isValidIsoOrNull(input.dueAt)) {
    throw new Error('sticky-note: dueAt must be parseable ISO timestamp or null')
  }
}

export function registerStickyNoteHandlers(): void {
  /** 按日期范围查便签（含 steps；默认排除 archived） */
  handle(IPC_CHANNELS.STICKY_NOTE_LIST, async (_e, args: { startDate: string; endDate: string }) => {
    return stickyNotesRepo.findByDateRange(args.startDate, args.endDate)
  })

  handle(IPC_CHANNELS.STICKY_NOTE_GET, async (_e, id: IDType) => {
    return stickyNotesRepo.findById(id)
  })

  handle(IPC_CHANNELS.STICKY_NOTE_CREATE, async (_e, input: StickyNoteCreate) => {
    validateStickyInput(input)
    return stickyNotesRepo.create(input)
  })

  handle(IPC_CHANNELS.STICKY_NOTE_UPDATE, async (_e, args: { id: IDType; patch: StickyNoteUpdate }) => {
    validateStickyInput(args.patch)
    const result = await stickyNotesRepo.update(args.id, args.patch)
    // R11 修复 (high #11)：重命名 / 更新 title 后让 pomodoro 服务的标题缓存失效，
    // 下次 focus 完成时 getCachedStickyTitle 返回 null → cacheStickyTitleAsync
    // 重新查 DB。否则通知里写的是缓存里的旧 title。
    invalidateStickyTitle(args.id)
    return result
  })

  handle(IPC_CHANNELS.STICKY_NOTE_DELETE, async (_e, id: IDType) => {
    const result = await stickyNotesRepo.remove(id)
    invalidateStickyTitle(id)
    return result
  })

  handle(IPC_CHANNELS.STICKY_NOTE_ADD_STEP, async (_e, args: { noteId: IDType; content: string; order?: number }) => {
    if (typeof args.content !== 'string'
        || Buffer.byteLength(args.content, 'utf8') > MAX_STEP_CONTENT_BYTES) {
      throw new Error(`sticky-note: step content exceeds ${MAX_STEP_CONTENT_BYTES} bytes`)
    }
    return stickyNotesRepo.addStep(args.noteId, args.content, args.order)
  })

  handle(
    IPC_CHANNELS.STICKY_NOTE_UPDATE_STEP,
    async (_e, args: { stepId: IDType; patch: StickyNoteStepPatch }) => {
      if (args.patch.content !== undefined
          && (typeof args.patch.content !== 'string'
              || Buffer.byteLength(args.patch.content, 'utf8') > MAX_STEP_CONTENT_BYTES)) {
        throw new Error(`sticky-note: step content exceeds ${MAX_STEP_CONTENT_BYTES} bytes`)
      }
      return stickyNotesRepo.updateStep(args.stepId, args.patch)
    },
  )

  handle(IPC_CHANNELS.STICKY_NOTE_REMOVE_STEP, async (_e, stepId: IDType) => {
    return stickyNotesRepo.removeStep(stepId)
  })

  /* ===== 统一后新增 ===== */

  /** 完成便签：status=done + completed_at + 写 completions */
  handle(IPC_CHANNELS.STICKY_NOTE_COMPLETE, async (_e, args: { id: IDType; date?: string }) => {
    const result = await stickyNotesRepo.complete(args.id, args.date ? { date: args.date } : undefined)
    // R20 修复 (medium)：complete() 在 id 不存在 / archived 时返回 null（无
    // 变化），但原代码无条件 ackPendingDue(1) → 通知调度器以为少了一次完成，
    // 下次扫描时少发通知 + 计数与 UI 状态脱钩。只在确实完成时 ack。
    //
    // R29-DI-9 修复 (HIGH over-ack)：complete() 在「已是 done 且同一天」会
    // 走幂等早返回（line 803 返回 findById 的 truthy row）—— 但 status 实际
    // 没变。这条 case 不应 ack，否则用户连点「标记完成」按钮 / 重复 IPC 触发
    // 会让 ack 累计多次，pending-due 计数下溢。修复：只有当 result.status
    // 确实是 'done'（completed() 已记录）才 ack；同一天幂等返回（status 仍
    // done 但本次没新完成）跳过 ack。
    if (result && result.status === 'done' && result.completedAt) {
      // R13 修复 (medium)：完成便签 → 未读 due 计数 -1，避免长期悬挂的
      // dock badge / 窗口标题。
      ackPendingDue(1)
    }
    return result
  })

  /** 显式设置状态（不限于 done；可在 todo/in_progress/done/cancelled 之间切换） */
  handle(IPC_CHANNELS.STICKY_NOTE_SET_STATUS, async (_e, args: { id: IDType; status: StickyStatus }) => {
    const result = await stickyNotesRepo.setStatus(args.id, args.status)
    // R22 修复 (high data integrity)：原版无条件 ackPendingDue(1) —— 当
    // setStatus 因 row 缺失 / archived / 并发 CAS miss 返回 null 时，
    // 计数仍 -1，dock badge / 通知调度计数脱钩（与下方 STICKY_NOTE_COMPLETE
    // 已修过的同根问题）。
    //
    // R29-DI-9 修复补充：setStatus 在「已是 done 同一天」走 skipCompletion
    // 早返回（line 1000 return，finalResult = null）。result 在 status
    // 已变 + 写 completions 时才非 null。仅当 result 真值且本次真的把
    // status 改成 done/cancelled（args.status 等于 result.status，说明
    // 没被早返回吞掉）才 ack。
    if (result && (args.status === 'done' || args.status === 'cancelled') && result.status === args.status) {
      ackPendingDue(1)
    }
    return result
  })

  /** 归档 / 取消归档 */
  handle(IPC_CHANNELS.STICKY_NOTE_ARCHIVE, async (_e, args: { id: IDType; archived: boolean }) => {
    const result = await stickyNotesRepo.archive(args.id, args.archived)
    // R33-Corr-2 修复 (MEDIUM archive-unconditional-ack)：原版无条件
    // ackPendingDue(1) —— archive() 在 row 缺失 / row 已是目标 archived 值
    // / 3 次 CAS 重试耗尽（并发 writer 抢占）时返回 null，handler 仍 ack。
    // 与 STICKY_NOTE_COMPLETE / SET_STATUS 已修过的同根问题（result 真值且
    // 真的改了才 ack）。同时断言 result.archived === args.archived 防御
    // 未来 short-circuit 提前返回未变 row 的路径。
    if (args.archived && result && result.archived === args.archived) {
      // 归档 = 用户处理过此便签，从未读 due 计数扣除。
      ackPendingDue(1)
    }
    return result
  })

  /** 翻转星标（starred 字段 0↔1） */
  handle(IPC_CHANNELS.STICKY_NOTE_TOGGLE_STARRED, async (_e, id: IDType) => {
    return stickyNotesRepo.toggleStarred(id)
  })

  /** 模糊搜索（title / description / step content） */
  handle(
    IPC_CHANNELS.STICKY_NOTE_SEARCH,
    async (_e, opts: StickyNoteSearchOptions) => stickyNotesRepo.search(opts),
  )

  /** 多条件过滤列表（Dashboard / Pomodoro 任务选择 / Stats） */
  handle(IPC_CHANNELS.STICKY_NOTE_LIST_FILTERED, async (_e, filter: StickyNoteFilter) =>
    stickyNotesRepo.listFiltered(filter),
  )

  /** 单独写入 completions（不更新 status）—— 用于回填或外部触发 */
  handle(IPC_CHANNELS.STICKY_NOTE_RECORD_COMPLETION, async (_e, args: { id: IDType; date: string }) => {
    return stickyNotesRepo.recordCompletion(args.id, args.date)
  })
}