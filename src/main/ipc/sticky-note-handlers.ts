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
import { PRIORITY_SET, STICKY_STATUS_SET } from '@shared/lib/priorities'
import { isValidDayKeyLocal } from '@shared/lib/dayKey'

/**
 * R12 修复 (medium)：sticky-note:create / update 的入参边界检查。被攻击渲染端
 * 可注入 100MB description 或 100k step rows 阻塞 IPC。handler 层做轻量上限。
 */
const MAX_TITLE_BYTES = 500
const MAX_DESCRIPTION_BYTES = 50_000
const MAX_STEPS = 200
const MAX_STEP_CONTENT_BYTES = 2_000
const MAX_TAGS = 100
const MAX_TAG_BYTES = 128
const MAX_FILTER_LIMIT = 1000
const MIN_FILTER_LIMIT = 1
const DEFAULT_FILTER_LIMIT = 200
const MAX_SEARCH_LIMIT = 200
const DEFAULT_SEARCH_LIMIT = 50
const MAX_SEARCH_QUERY_BYTES = 1024

// R33-Corr-3 修复 (MEDIUM validate-sticky-input-no-enum-checks)：原版只
// 校验 title / description / steps / tags.length，但 priority / status /
// color / recurrence / date / scheduledAt / dueAt 这些 enum/ISO 字段都不
// 校验。被攻击渲染端（或前落后于 schema bump 的旧渲染端）可注入
// `{priority: 'p9', status: 'weird', recurrence: 'hourly'}` 之类垃圾，
// 直入 SQLite TEXT 列污染下游 filter / sort / 通知调度。修复：enum
// allowlist + 日期/ISO 解析校验。defense-in-depth —— stickyNotesRepo.create
// 也跑这套。
const ALLOWED_PRIORITY: ReadonlySet<string> = PRIORITY_SET
const ALLOWED_STATUS: ReadonlySet<string> = STICKY_STATUS_SET
const ALLOWED_RECURRENCE: ReadonlySet<string> = new Set([
  'none', 'daily', 'weekly', 'monthly',
])
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * R-fix-daykey-dedup (MEDIUM)：与渲染端 dayKeyOf() 语义保持一致 —— 一律
 * 用**本地时区**比较。原版用 getUTCFullYear/getUTCMonth/getUTCDate 在东
 * 八区会假阴性（早上 8 点前创建"今天"的便签会被拒），因为 'YYYY-MM-DD
 * T00:00:00' 被 JS 当成本地时间，UTC 视角下已经跨到昨天。
 *
 * 解析：'2026-09-03T00:00:00'（无时区后缀）= 本地 00:00；上海时区 =
 * UTC 前一天 16:00；d.getFullYear()/getMonth()/getDate() 拿本地年月日
 * 与 s.slice 比对即可。
 *
 * 收口到 @shared/lib/dayKey.isValidDayKeyLocal（与 validators.parseSafeDayKey
 * / navigateBridge.parseRoute 共享字面正则源 DAY_KEY_RE，但时区锚点是本地
 * 不是 UTC —— 写入 sticky_notes.date 路径必须用本地与 dayKeyOf() 一一对应）。
 */
function isValidDayKey(s: string): boolean {
  return isValidDayKeyLocal(s)
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

/**
 * R33-Corr-4 修复 (MEDIUM id-no-runtime-validation)：peer handlers
 * (CREATE/UPDATE/SET_STATUS/ADD_STEP/UPDATE_STEP/ARCHIVE) 都在 R33-Corr-3 加
 * 了 enum/format 校验，但 DELETE/REMOVE_STEP/TOGGLE_STARRED/GET 这四条只接
 * `id: IDType`，handler 层未做运行时校验。TypeScript `ID = string` 只是编译期
 * 装饰，IPC structured-clone 跨信任边界（被攻渲染端 / devtools / preload /
 * 落后 schema 的旧渲染端）可注入 number/object/null/空串；better-sqlite3
 * bind undefined → NULL → UPDATE WHERE id=NULL 影响 0 行，但 renderer 端
 * 乐观删除已发生 → UI 与 repo 状态脱钩。handler 层加一道防御，让
 * `handle()` 真正成为 R33-Corr-3 设计意图的 defense-in-depth 层。
 */
function assertId(id: unknown, channel: string): asserts id is IDType {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`${channel}: id must be non-empty string`)
  }
}

/**
 * R43 修复 (MEDIUM input-validation-asymmetry-search-list-filtered)：search /
 * listFiltered handler 此前未做运行时校验。被攻渲染端可注入 200k 长 tag 数组
 * 让 IN-clause 膨胀成 200MB prepared statement，或注入字符串 limit 让
 * Math.max('all', 1) → NaN → LIMIT 失效 → UI 静默返空。与 validateStickyInput
 * 共享 MAX_TAGS / isValidDayKey 同一字面源，defense-in-depth。
 *
 * 校验项：
 *   - filter.tags：数组且 length ≤ MAX_TAGS，每项非空字符串且 byte ≤ MAX_TAG_BYTES
 *   - filter.limit / opts.limit：有限整数 ∈ [MIN_*, MAX_*]，否则用 DEFAULT_*
 *   - filter.dueBefore/dueAfter/scheduledBefore/scheduledAfter：YYYY-MM-DD
 *   - opts.query：字符串且 byte ≤ MAX_SEARCH_QUERY_BYTES
 *   - opts.includeArchived：可显式 boolean
 */
function coerceLimit(raw: unknown, min: number, max: number, fallback: number, channel: string): number {
  if (raw === undefined || raw === null) return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${channel}: limit must be integer in [${min}, ${max}]`)
  }
  return n
}

function validateStickyFilter(filter: unknown): void {
  const ch = IPC_CHANNELS.STICKY_NOTE_LIST_FILTERED
  if (filter === undefined || filter === null) return
  if (typeof filter !== 'object') {
    throw new Error(`${ch}: filter must be an object`)
  }
  const f = filter as Record<string, unknown>
  if (f.tags !== undefined) {
    if (!Array.isArray(f.tags) || f.tags.length > MAX_TAGS) {
      throw new Error(`${ch}: tags must be array, length <= ${MAX_TAGS}`)
    }
    for (const t of f.tags) {
      if (typeof t !== 'string' || t === '' || Buffer.byteLength(t, 'utf8') > MAX_TAG_BYTES) {
        throw new Error(`${ch}: each tag must be non-empty string <= ${MAX_TAG_BYTES} bytes`)
      }
    }
  }
  if (f.limit !== undefined) {
    f.limit = coerceLimit(f.limit, MIN_FILTER_LIMIT, MAX_FILTER_LIMIT, DEFAULT_FILTER_LIMIT, ch)
  }
  for (const k of ['dueBefore', 'dueAfter', 'scheduledBefore', 'scheduledAfter']) {
    if (f[k] !== undefined && f[k] !== null) {
      if (typeof f[k] !== 'string' || !isValidDayKey(f[k] as string)) {
        throw new Error(`${ch}: ${k} must be YYYY-MM-DD and a real calendar date`)
      }
    }
  }
}

function validateStickySearch(opts: unknown): void {
  const ch = IPC_CHANNELS.STICKY_NOTE_SEARCH
  if (opts === undefined || opts === null) return
  if (typeof opts !== 'object') {
    throw new Error(`${ch}: opts must be an object`)
  }
  const o = opts as Record<string, unknown>
  if (typeof o.query !== 'string'
      || Buffer.byteLength(o.query, 'utf8') > MAX_SEARCH_QUERY_BYTES) {
    throw new Error(`${ch}: query must be string <= ${MAX_SEARCH_QUERY_BYTES} bytes`)
  }
  if (o.limit !== undefined) {
    o.limit = coerceLimit(o.limit, MIN_FILTER_LIMIT, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT, ch)
  }
  if (o.includeArchived !== undefined && typeof o.includeArchived !== 'boolean') {
    throw new Error(`${ch}: includeArchived must be boolean`)
  }
}

export function registerStickyNoteHandlers(): void {
  /** 按日期范围查便签（含 steps；默认排除 archived） */
  handle(IPC_CHANNELS.STICKY_NOTE_LIST, async (_e, args: { startDate: string; endDate: string }) => {
    // R36 修复 (low input-validation-asymmetry)：与同项目其它 day-bearing
    // handler (completion:record / completion:daily / completion:total /
    // note-event:record / note-event:daily / pomodoro:daily) 对齐 —— 入参
    // 必须是合法 YYYY-MM-DD。被攻渲染端 / devtools 可注入
    // `{startDate: 'A'.repeat(10_000_000), endDate: '<script>'}` —— SQLite
    // BETWEEN 用 ? 绑定无 SQL 注入，但可让 UI 拿到空数组误判「今天没便签」，
    // 同时消耗 db-worker IPC payload；并且 number/object 可绕过 truthy
    // 检查落到 repo。复用 isValidDayKeyLocal 与 5 处 sibling handler 同源。
    if (typeof args?.startDate !== 'string' || !isValidDayKey(args.startDate)) {
      throw new Error(`${IPC_CHANNELS.STICKY_NOTE_LIST}: startDate must be YYYY-MM-DD and a real calendar date`)
    }
    if (typeof args?.endDate !== 'string' || !isValidDayKey(args.endDate)) {
      throw new Error(`${IPC_CHANNELS.STICKY_NOTE_LIST}: endDate must be YYYY-MM-DD and a real calendar date`)
    }
    return stickyNotesRepo.findByDateRange(args.startDate, args.endDate)
  })

  handle(IPC_CHANNELS.STICKY_NOTE_GET, async (_e, id: IDType) => {
    assertId(id, IPC_CHANNELS.STICKY_NOTE_GET)
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
    assertId(id, IPC_CHANNELS.STICKY_NOTE_DELETE)
    const result = await stickyNotesRepo.remove(id)
    invalidateStickyTitle(id)
    return result
  })

  handle(IPC_CHANNELS.STICKY_NOTE_ADD_STEP, async (_e, args: { noteId: IDType; content: string; order?: number }) => {
    // R34-Corr-1a 修复 (MEDIUM id-no-runtime-validation-sibling)：与
    // STICKY_NOTE_GET/DELETE/REMOVE_STEP/TOGGLE_STARRED 同根问题 —— args.noteId
    // 来自 IPC 信任边界，TS 类型只是装饰，被攻渲染端可注入 number/object/空串；
    // 与 R33-Corr-4 同一处理。
    assertId(args.noteId, IPC_CHANNELS.STICKY_NOTE_ADD_STEP)
    if (typeof args.content !== 'string'
        || Buffer.byteLength(args.content, 'utf8') > MAX_STEP_CONTENT_BYTES) {
      throw new Error(`sticky-note: step content exceeds ${MAX_STEP_CONTENT_BYTES} bytes`)
    }
    return stickyNotesRepo.addStep(args.noteId, args.content, args.order)
  })

  handle(
    IPC_CHANNELS.STICKY_NOTE_UPDATE_STEP,
    async (_e, args: { stepId: IDType; patch: StickyNoteStepPatch }) => {
      // R34-Corr-1a 修复：args.stepId 同上需要 assertId。
      assertId(args.stepId, IPC_CHANNELS.STICKY_NOTE_UPDATE_STEP)
      if (args.patch.content !== undefined
          && (typeof args.patch.content !== 'string'
              || Buffer.byteLength(args.patch.content, 'utf8') > MAX_STEP_CONTENT_BYTES)) {
        throw new Error(`sticky-note: step content exceeds ${MAX_STEP_CONTENT_BYTES} bytes`)
      }
      return stickyNotesRepo.updateStep(args.stepId, args.patch)
    },
  )

  handle(IPC_CHANNELS.STICKY_NOTE_REMOVE_STEP, async (_e, stepId: IDType) => {
    assertId(stepId, IPC_CHANNELS.STICKY_NOTE_REMOVE_STEP)
    return stickyNotesRepo.removeStep(stepId)
  })

  /* ===== 统一后新增 ===== */

  /** 完成便签：status=done + completed_at + 写 completions */
  handle(IPC_CHANNELS.STICKY_NOTE_COMPLETE, async (_e, args: { id: IDType; date?: string }) => {
    // R34-Corr-1a 修复 (MEDIUM id-no-runtime-validation-sibling)：args.id 来自
    // IPC 信任边界 —— 与 STICKY_NOTE_GET 等同根问题，必须 assertId。
    assertId(args.id, IPC_CHANNELS.STICKY_NOTE_COMPLETE)
    // R34-Corr-1b 修复 (MEDIUM complete-date-unvalidated)：args.date 直接
    // 流到 repo INSERT completions.date，repo 层（与 recordCompletion 不同）
    // 此前无 validateDayKey 守卫；被攻渲染端可注入非 YYYY-MM-DD/不存在日期，
    // 写脏 completions 行污染热力图聚合。handler 层先校验（与 R33-Corr-3
    // 校验 input.date 用同款 isValidDayKey），repo 层再加一次纵深防御。
    if (args.date !== undefined && (typeof args.date !== 'string' || !isValidDayKey(args.date))) {
      throw new Error('sticky-note: complete date must be YYYY-MM-DD and a real calendar date')
    }
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

  /** 显式设置状态（不限于 done；可在 todo/done 之间切换） */
  handle(IPC_CHANNELS.STICKY_NOTE_SET_STATUS, async (_e, args: { id: IDType; status: StickyStatus }) => {
    // R34-Corr-1a 修复 (MEDIUM id-no-runtime-validation-sibling)：args.id 同上。
    assertId(args.id, IPC_CHANNELS.STICKY_NOTE_SET_STATUS)
    // R33-Corr-3 补 (MEDIUM set-status-bypass-whitelist)：原版把 args.status 直
    // 传给 stickyNotesRepo.setStatus，没有任何运行时 enum 校验 —— TypeScript
    // 类型只是装饰，IPC 跨越信任边界（被攻渲染端 / devtools / preload / 落后
    // schema 的旧渲染端）可注入任意字符串，被原样写入 SQLite status 列污染下
    // 游 filter / sort / 通知调度。与同文件 STICKY_NOTE_CREATE / UPDATE 用的
    // ALLOWED_STATUS 白名单对齐。repo 层也再加一次纵深防御。
    if (typeof args.status !== 'string' || !ALLOWED_STATUS.has(args.status)) {
      throw new Error(`sticky-note: status must be one of ${[...ALLOWED_STATUS].join(',')}`)
    }
    const result = await stickyNotesRepo.setStatus(args.id, args.status as StickyStatus)
    // R22 修复 (high data integrity)：原版无条件 ackPendingDue(1) —— 当
    // setStatus 因 row 缺失 / archived / 并发 CAS miss 返回 null 时，
    // 计数仍 -1，dock badge / 通知调度计数脱钩（与下方 STICKY_NOTE_COMPLETE
    // 已修过的同根问题）。
    //
    // R29-DI-9 修复补充：setStatus 在「已是 done 同一天」走 skipCompletion
    // 早返回（line 1000 return，finalResult = null）。result 在 status
    // 已变 + 写 completions 时才非 null。仅当 result 真值且本次真的把
    // status 改成 done（args.status 等于 result.status，说明没被早返回吞掉）
    // 才 ack。
    //
    // W2-C③：sticky status 砍到 todo/done，'cancelled' 已下线。ack 守卫的
    // cancelled 分支随之删除（args.status 只剩 'todo'/'done'，'cancelled'
    // 已被白名单拒）。
    if (result && args.status === 'done' && result.status === args.status) {
      ackPendingDue(1)
    }
    return result
  })

  /** 归档 / 取消归档 */
  handle(IPC_CHANNELS.STICKY_NOTE_ARCHIVE, async (_e, args: { id: IDType; archived: boolean }) => {
    // R34-Corr-1a 修复 (MEDIUM id-no-runtime-validation-sibling)：args.id 同上。
    assertId(args.id, IPC_CHANNELS.STICKY_NOTE_ARCHIVE)
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
    assertId(id, IPC_CHANNELS.STICKY_NOTE_TOGGLE_STARRED)
    return stickyNotesRepo.toggleStarred(id)
  })

  /** 模糊搜索（title / description / step content） */
  handle(
    IPC_CHANNELS.STICKY_NOTE_SEARCH,
    async (_e, opts: StickyNoteSearchOptions) => {
      // R43 修复 (MEDIUM input-validation-asymmetry)：handler 层先校验 query
      // byte 长度与 limit 范围；被攻渲染端注入 100MB query 或 NaN-producing
      // limit 会被拦下，与 create/update 用同款 defense-in-depth。
      validateStickySearch(opts)
      return stickyNotesRepo.search(opts as StickyNoteSearchOptions)
    },
  )

  /** 多条件过滤列表（Dashboard / Pomodoro 任务选择 / Stats） */
  handle(IPC_CHANNELS.STICKY_NOTE_LIST_FILTERED, async (_e, filter: StickyNoteFilter) => {
    // R43 修复 (MEDIUM input-validation-asymmetry)：handler 层校验 tags 长度
    // / byte、limit 范围、day-bearing 字段；与 create/update 用同款校验源。
    validateStickyFilter(filter)
    return stickyNotesRepo.listFiltered(filter as StickyNoteFilter)
  })

  /** 单独写入 completions（不更新 status）—— 用于回填或外部触发 */
  handle(IPC_CHANNELS.STICKY_NOTE_RECORD_COMPLETION, async (_e, args: { id: IDType; date: string }) => {
    // R34-Corr-1a 修复 (MEDIUM id-no-runtime-validation-sibling)：args.id 同上。
    assertId(args.id, IPC_CHANNELS.STICKY_NOTE_RECORD_COMPLETION)
    return stickyNotesRepo.recordCompletion(args.id, args.date)
  })
}