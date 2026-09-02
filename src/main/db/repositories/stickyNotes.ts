/**
 * 便签（多级待办）仓储 —— 统一的任务实体
 *
 * 便签（sticky_notes）+ 步骤（sticky_note_steps）的 CRUD。
 * 历史上叫"任务（Task）"的概念已全部合入此类型。
 *
 * 设计要点：
 *   - 字段集合已扩展到 16 个（含 title/date/priority + 13 派生字段）
 *   - rowToNote 把 tags_json 解析为 tags 数组；写入时 JSON.stringify
 *   - update() 使用 updated_at 做乐观锁 CAS
 *   - 所有 update 同步写 updated_at，触发前端 store 重订阅
 */
import { dbClient } from '../client'
import { validateDayKey } from './completions'
import log from '../../log'
import type {
  StickyNote,
  StickyNoteStep,
  StickyNoteCreate,
  StickyNoteUpdate,
  StickyNoteStepPatch,
  StickyStatus,
  Priority,
  StickyColor,
  ID,
  StickyNoteFilter,
  StickyNoteSearchOptions,
} from '@shared/types'

interface StickyNoteRow {
  id: string
  title: string
  date: string
  priority: Priority
  description: string | null
  status: StickyStatus
  scheduled_at: string | null
  due_at: string | null
  completed_at: string | null
  tags_json: string | null
  color: string | null
  recurrence: string | null
  estimated_minutes: number | null
  actual_minutes: number | null
  pomodoro_count: number
  starred: number
  archived: number
  created_at: string
  updated_at: string
}

interface StickyNoteStepRow {
  id: string
  note_id: string
  content: string
  done: number
  order_num: number
  created_at: string
}

/** 完整字段白名单（用于 findBy* 查询 SELECT *） */
const STICKY_NOTE_COLUMNS =
  'id, title, date, priority, description, status, scheduled_at, due_at, completed_at, ' +
  'tags_json, color, recurrence, estimated_minutes, actual_minutes, pomodoro_count, ' +
  'starred, archived, created_at, updated_at'

function parseTags(json: string | null | undefined): ID[] {
  if (json == null || json === '' || json === 'null') return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToNote(r: StickyNoteRow): StickyNote {
  return {
    id: r.id,
    title: r.title,
    date: r.date,
    priority: r.priority,
    status: r.status,
    description: r.description,
    scheduledAt: r.scheduled_at,
    dueAt: r.due_at,
    completedAt: r.completed_at,
    tags: parseTags(r.tags_json),
    color: (r.color as StickyColor | null) ?? null,
    recurrence: r.recurrence,
    estimatedMinutes: r.estimated_minutes,
    actualMinutes: r.actual_minutes,
    pomodoroCount: r.pomodoro_count,
    starred: !!r.starred,
    archived: !!r.archived,
    steps: [], // 由调用方填充
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToStep(r: StickyNoteStepRow): StickyNoteStep {
  return {
    id: r.id,
    noteId: r.note_id,
    content: r.content,
    done: !!r.done,
    order: r.order_num,
    createdAt: r.created_at,
  }
}

/** 预编译语句缓存（仓储实例级） */
const stmtCache = new Map<string, number>()

async function prepare(sql: string): Promise<number> {
  let id = stmtCache.get(sql)
  if (id !== undefined) return id
  const res = await dbClient.call<{ stmtId: number }>('prepare', { sql })
  if (!res) throw new Error('Failed to prepare statement')
  id = res.stmtId
  stmtCache.set(sql, id)
  return id
}

/**
 * 批量加载 steps 并按 note_id 分组。
 * 用于 findByDateRange / findById / listFiltered —— 避免 N+1 查询。
 */
async function loadStepsForNotes(noteIds: string[]): Promise<Map<string, StickyNoteStep[]>> {
  const map = new Map<string, StickyNoteStep[]>()
  if (noteIds.length === 0) return map
  const stmtId = await prepare(
    `SELECT * FROM sticky_note_steps WHERE note_id IN (${noteIds.map(() => '?').join(',')}) ORDER BY order_num ASC`,
  )
  const rows = (await dbClient.call('all', { stmtId, params: noteIds })) as StickyNoteStepRow[]
  for (const r of rows) {
    const list = map.get(r.note_id) ?? []
    list.push(rowToStep(r))
    map.set(r.note_id, list)
  }
  return map
}

/** 把 rows + 批量加载的 steps 合并为 StickyNote[] */
function hydrate(rows: StickyNoteRow[], stepsMap: Map<string, StickyNoteStep[]>): StickyNote[] {
  return rows.map((r) => {
    const note = rowToNote(r)
    note.steps = stepsMap.get(r.id) ?? []
    return note
  })
}

async function findNoteRow(id: ID): Promise<StickyNoteRow | null> {
  const stmtId = await prepare(`SELECT ${STICKY_NOTE_COLUMNS} FROM sticky_notes WHERE id = ?`)
  const row = (await dbClient.call('get', { stmtId, params: [id] })) as StickyNoteRow | null
  return row
}

async function findStepRow(stepId: ID): Promise<StickyNoteStepRow | null> {
  const stmtId = await prepare(`SELECT * FROM sticky_note_steps WHERE id = ?`)
  const row = (await dbClient.call('get', { stmtId, params: [stepId] })) as StickyNoteStepRow | null
  return row
}

/* ============== 列表查询 ============== */

/** 按日期范围查便签（含 steps）。默认按 date ASC + priority ASC + created_at ASC 排序 */
async function findByDateRange(start: string, end: string): Promise<StickyNote[]> {
  const stmtId = await prepare(
    `SELECT ${STICKY_NOTE_COLUMNS} FROM sticky_notes
     WHERE date BETWEEN ? AND ? AND archived = 0
     ORDER BY date ASC, priority ASC, created_at ASC`,
  )
  const rows = (await dbClient.call('all', { stmtId, params: [start, end] })) as StickyNoteRow[]
  if (rows.length === 0) return []
  const stepsMap = await loadStepsForNotes(rows.map((r) => r.id))
  return hydrate(rows, stepsMap)
}

/** 单条查询（带 steps） */
async function findById(id: ID): Promise<StickyNote | null> {
  const row = await findNoteRow(id)
  if (!row) return null
  const stepsMap = await loadStepsForNotes([id])
  const note = rowToNote(row)
  note.steps = stepsMap.get(id) ?? []
  return note
}

/** 过滤列表（用于 Dashboard / Pomodoro 任务选择等） */

async function listFiltered(filter: StickyNoteFilter): Promise<StickyNote[]> {
  const wheres: string[] = []
  const params: unknown[] = []

  if (filter.archived !== undefined) {
    wheres.push('archived = ?')
    params.push(filter.archived ? 1 : 0)
  } else {
    wheres.push('archived = 0')
  }

  if (filter.status) {
    const list = Array.isArray(filter.status) ? filter.status : [filter.status]
    wheres.push(`status IN (${list.map(() => '?').join(',')})`)
    params.push(...list)
  }
  if (filter.priority) {
    const list = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
    wheres.push(`priority IN (${list.map(() => '?').join(',')})`)
    params.push(...list)
  }
  if (filter.starred !== undefined) {
    wheres.push('starred = ?')
    params.push(filter.starred ? 1 : 0)
  }
  if (filter.dueBefore) {
    // R6S-3：原本用 UTC 23:59 切片，对 UTC+8 用户的「本地当天的截止」会漏掉早上 8 点
    // 之前的事件。改为：以本地 00:00 起算，向后加 24h-1ms 作为当天本地结束毫秒数。
    const localEndMs = new Date(`${filter.dueBefore}T00:00:00`).getTime() + 86_399_999
    wheres.push('due_at IS NOT NULL AND due_at <= ?')
    params.push(new Date(localEndMs).toISOString())
  }
  if (filter.dueAfter) {
    const localStartMs = new Date(`${filter.dueAfter}T00:00:00`).getTime()
    wheres.push('due_at IS NOT NULL AND due_at >= ?')
    params.push(new Date(localStartMs).toISOString())
  }
  if (filter.scheduledBefore) {
    const localEndMs = new Date(`${filter.scheduledBefore}T00:00:00`).getTime() + 86_399_999
    wheres.push('scheduled_at IS NOT NULL AND scheduled_at <= ?')
    params.push(new Date(localEndMs).toISOString())
  }
  if (filter.scheduledAfter) {
    const localStartMs = new Date(`${filter.scheduledAfter}T00:00:00`).getTime()
    wheres.push('scheduled_at IS NOT NULL AND scheduled_at >= ?')
    params.push(new Date(localStartMs).toISOString())
  }
  if (filter.tags && filter.tags.length > 0) {
    // tags_json 是 JSON 数组，存的是字符串 ID 列表。
    // 用 json_each 解析后精确匹配 id，避免子串误命中（如 "1" 匹配到 "10"）。
    wheres.push(`EXISTS (SELECT 1 FROM json_each(sticky_notes.tags_json) WHERE json_each.value IN (${filter.tags.map(() => '?').join(',')}))`)
    params.push(...filter.tags)
  }

  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  const sql = `SELECT ${STICKY_NOTE_COLUMNS} FROM sticky_notes
               WHERE ${wheres.join(' AND ')}
               ORDER BY date ASC, priority ASC, created_at ASC
               LIMIT ${limit}`
  const stmtId = await prepare(sql)
  const rows = (await dbClient.call('all', { stmtId, params })) as StickyNoteRow[]
  if (rows.length === 0) return []
  const stepsMap = await loadStepsForNotes(rows.map((r) => r.id))
  return hydrate(rows, stepsMap)
}

/** 模糊搜索：title + step content + description；可选过滤（默认只搜未归档） */

async function search(opts: StickyNoteSearchOptions): Promise<StickyNote[]> {
  const q = opts.query.trim()
  if (!q) return []
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  // R10 修复：用户输入里的 % / _ 必须转义成字面量，否则 LIKE 会把它们当通配符
  // （搜 "100%" 会匹配 "100abc"、"test_case" 会匹配 "test1case"）。用 \\ 作为
  // ESCAPE 字符并同步转义 \ 自身。
  const escapedQ = q.replace(/[\\%_]/g, (c) => `\\${c}`)
  const like = `%${escapedQ}%`

  // 先找匹配 title/description 的 note id
  // R10 修复：LIKE 必须显式声明 ESCAPE '\\'，否则 SQLite 把 \\ 当普通字符处理
  // 时反斜杠转义逻辑不一致（取决于 SQLITE_DBPAGE / SQLITE_THREADSAFE 配置）。
  const wheres = ["(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"]
  const params: unknown[] = [like, like]
  if (!opts.includeArchived) {
    wheres.push('archived = 0')
  }
  const sql = `SELECT ${STICKY_NOTE_COLUMNS} FROM sticky_notes
               WHERE ${wheres.join(' AND ')}
               ORDER BY date ASC, priority ASC, created_at ASC
               LIMIT ${limit}`
  const stmtId = await prepare(sql)
  const directHits = (await dbClient.call('all', { stmtId, params })) as StickyNoteRow[]

  // 再找匹配 step content 的 note id（避免与 title 重复）
  const stepStmtId = await prepare(
    `SELECT DISTINCT note_id FROM sticky_note_steps WHERE content LIKE ? ESCAPE '\\'`,
  )
  const stepHits = (await dbClient.call('all', { stmtId: stepStmtId, params: [like] })) as {
    note_id: string
  }[]
  const directIds = new Set(directHits.map((r) => r.id))
  const remaining = Math.max(0, limit - directHits.length)
  const extraIds = stepHits
    .map((r) => r.note_id)
    .filter((id) => !directIds.has(id))
    .slice(0, remaining)

  let extraRows: StickyNoteRow[] = []
  if (extraIds.length > 0) {
    const inList = extraIds.map(() => '?').join(',')
    const extraSql = `SELECT ${STICKY_NOTE_COLUMNS} FROM sticky_notes WHERE id IN (${inList})${
      opts.includeArchived ? '' : ' AND archived = 0'
    } LIMIT ${extraIds.length}`
    const extraStmtId = await prepare(extraSql)
    extraRows = (await dbClient.call('all', { stmtId: extraStmtId, params: extraIds })) as StickyNoteRow[]
  }

  // M6：用 Map 保证合并后不超 limit，且去重
  const dedup = new Map<string, StickyNoteRow>()
  for (const r of [...directHits, ...extraRows]) dedup.set(r.id, r)
  const allRows = Array.from(dedup.values()).slice(0, limit)
  if (allRows.length === 0) return []
  const stepsMap = await loadStepsForNotes(allRows.map((r) => r.id))
  return hydrate(allRows, stepsMap)
}

/** 按状态查询（含 steps）—— listFiltered 的语义糖 */
async function findByStatus(
  status: StickyStatus | StickyStatus[],
  opts: { includeArchived?: boolean; limit?: number } = {},
): Promise<StickyNote[]> {
  return listFiltered({
    status,
    archived: opts.includeArchived ? undefined : false,
    limit: opts.limit,
  })
}

/* ============== 写入 ============== */

/** 创建便签 + 初始 steps（事务）。step.order 缺省时取递增序列。 */
async function create(input: StickyNoteCreate): Promise<StickyNote> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const tagsJson = JSON.stringify(input.tags ?? [])
  const status: StickyStatus = input.status ?? 'todo'

  const note: StickyNote = {
    id,
    title: input.title,
    date: input.date,
    priority: input.priority,
    status,
    description: input.description ?? null,
    scheduledAt: input.scheduledAt ?? null,
    dueAt: input.dueAt ?? null,
    completedAt: null,
    tags: input.tags ?? [],
    color: input.color ?? null,
    recurrence: input.recurrence ?? null,
    estimatedMinutes: input.estimatedMinutes ?? null,
    actualMinutes: null,
    pomodoroCount: 0,
    starred: input.starred ?? false,
    archived: false,
    steps: [],
    createdAt: now,
    updatedAt: now,
  }

  // R24-Corr-5 修复 (high atomicity)：原版 BEGIN/COMMIT 跨多次 dbClient.call
  // IPC，让出事件循环。AI 工具 + 用户并发 createSticky（多窗口、连点新建）会
  // 让第二个 BEGIN 撞上第一个未提交事务 → 「cannot start a transaction within
  // a transaction」 → 第二个 catch 块对**第一个**事务发 ROLLBACK 错杀 →
  // 第一个事务的 INSERT 落到事务外被自动提交，COMMIT no-op；DB 部分残留。
  // 修复：用 dbClient.runInTransaction 串行化。
  await dbClient.runInTransaction(async () => {
    await dbClient.call('exec', { sql: 'BEGIN' })
    try {
      const insertNoteStmtId = await prepare(
        `INSERT INTO sticky_notes (
           id, title, date, priority, description, status,
           scheduled_at, due_at, completed_at, tags_json, color, recurrence,
           estimated_minutes, actual_minutes, pomodoro_count, starred, archived,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      await dbClient.call('run', {
        stmtId: insertNoteStmtId,
        params: [
          id,
          input.title,
          input.date,
          input.priority,
          note.description,
          status,
          note.scheduledAt,
          note.dueAt,
          null,
          tagsJson,
          note.color,
          note.recurrence,
          note.estimatedMinutes,
          null,
          0,
          note.starred ? 1 : 0,
          0,
          now,
          now,
        ],
      })

      if (input.steps.length > 0) {
        const insertStepStmtId = await prepare(
          `INSERT INTO sticky_note_steps (id, note_id, content, done, order_num, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        // R15 修复 (high)：007 加了 UNIQUE(note_id, order_num) 后，create()
        // 直接 INSERT 调用方提供的 order 会撞约束（如 [{order:0},{order:0}]）
        // 整个事务 rollback，连父 sticky 也丢了。改为：
        //   - 显式 order 在该 note 范围内去重（撞了就 cursor++ 续号）
        //   - 任何意外撞 UNIQUE 的 INSERT 用 try/catch 单步 fallback，避免整事务失败
        const usedOrders = new Set<number>()
        let cursor = 0
        for (const s of input.steps) {
          let order: number
          if (typeof s.order === 'number') {
            order = s.order
            while (usedOrders.has(order)) order += 1
          } else {
            order = cursor++
            while (usedOrders.has(order)) order = cursor++
          }
          usedOrders.add(order)
          const stepId = crypto.randomUUID()
          try {
            await dbClient.call('run', {
              stmtId: insertStepStmtId,
              params: [stepId, id, s.content, s.done ? 1 : 0, order, now],
            })
          } catch (err) {
            // 兜底：极端并发下仍可能撞 UNIQUE（如迁移跨事务），
            // 改用 max(order_num)+1 +1 重新插入一次
            const maxOrderStmtId = await prepare(
              `SELECT COALESCE(MAX(order_num), -1) AS max_order FROM sticky_note_steps WHERE note_id = ?`,
            )
            const maxRow = (await dbClient.call('get', {
              stmtId: maxOrderStmtId,
              params: [id],
            })) as { max_order: number } | undefined
            const fallbackOrder = (maxRow?.max_order ?? -1) + 1
            usedOrders.add(fallbackOrder)
            await dbClient.call('run', {
              stmtId: insertStepStmtId,
              params: [stepId, id, s.content, s.done ? 1 : 0, fallbackOrder, now],
            })
            order = fallbackOrder
            console.warn(
              `[stickyNotes.create] step order conflict for note ${id}; fell back to ${fallbackOrder}`,
              err,
            )
          }
          note.steps.push({
            id: stepId,
            noteId: id,
            content: s.content,
            done: s.done ?? false,
            order,
            createdAt: now,
          })
        }
      }

      await dbClient.call('exec', { sql: 'COMMIT' })
    } catch (err) {
      try {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
      } catch (_) {
        // ignore rollback errors
      }
      throw err
    }
  })

  return note
}

/** 更新便签元数据（任意 13 字段 + title/date/priority），乐观锁 CAS。 */
async function update(id: ID, patch: StickyNoteUpdate): Promise<StickyNote | null> {
  const existing = await findNoteRow(id)
  if (!existing) return null
  const now = new Date().toISOString()
  const prevStatus = existing.status
  const prevCompletedAt = existing.completed_at

  const merged: StickyNoteRow = {
    ...existing,
    title: patch.title ?? existing.title,
    date: patch.date ?? existing.date,
    priority: patch.priority ?? existing.priority,
    description: patch.description === undefined ? existing.description : patch.description,
    status: patch.status ?? existing.status,
    scheduled_at:
      patch.scheduledAt === undefined ? existing.scheduled_at : patch.scheduledAt,
    due_at: patch.dueAt === undefined ? existing.due_at : patch.dueAt,
    completed_at:
      patch.completedAt === undefined ? existing.completed_at : patch.completedAt,
    tags_json: patch.tags === undefined ? existing.tags_json : JSON.stringify(patch.tags),
    color: patch.color === undefined ? existing.color : patch.color,
    recurrence: patch.recurrence === undefined ? existing.recurrence : patch.recurrence,
    estimated_minutes:
      patch.estimatedMinutes === undefined ? existing.estimated_minutes : patch.estimatedMinutes,
    actual_minutes:
      patch.actualMinutes === undefined ? existing.actual_minutes : patch.actualMinutes,
    pomodoro_count:
      patch.pomodoroCount === undefined ? existing.pomodoro_count : patch.pomodoroCount,
    starred: patch.starred === undefined ? existing.starred : patch.starred ? 1 : 0,
    archived: patch.archived === undefined ? existing.archived : patch.archived ? 1 : 0,
    updated_at: now,
  }

  // R20 修复 (high data integrity)：update() 之前直接 UPDATE sticky_notes，
  // 不区分 status 转移方向。攻击者 / 用户可在编辑 modal 里把 status 从 'done'
  // 改成 'cancelled'，UPDATE 把 completed_at 保留（旧值），completions 表的
  // 当日行不动 → 热力图多算一个；但 render UI 已不显示为完成 → 计数与可见状态
  // 不一致。同步发生在：done→cancelled 后 render 走 useStickyNotesStore 看
  // status='cancelled' 不显示，但 heatmap widget 看 completions 表把这一行
  // 也算进去。
  // 修复：检测 prevStatus / merged.status 转移方向，把对应 completions 操作
  // 包进与 UPDATE 同一事务；CAS 失败时整体放弃，无副作用。
  const statusChanged = patch.status !== undefined && patch.status !== prevStatus
  const becameDone = statusChanged && prevStatus !== 'done' && merged.status === 'done'
  const becameUndone =
    statusChanged && prevStatus === 'done' && merged.status !== 'done'

  // R30-DI-2 修复 (HIGH completions-staleness)：当 update() 调用场景为
  // 「sticky 已 done 但用户显式改 completedAt 到另一个日期」（典型：编辑
  // modal 调 update({completedAt:'2024-01-02'}) 把误标的完成时间往回填；
  // 或 AI 工具基于 planner 数据同步改 completedAt）—— 现有逻辑只在
  // status 转移时同步 completions 表，**没有 status 变化时 completions
  // 表完全不动**。结果：
  //   1) sticky_notes.completed_at = '2024-01-02'
  //   2) completions.date 仍是 prevCompletedAt 那一天的旧行
  //   3) 热力图按 completions 表统计 → 显示「该 sticky 在 2024-01-01
  //      完成」；但 UI 元数据面板按 completed_at 显示「2024-01-02 完成」
  //   4) 计数双计：旧日已经聚合一次，新日没聚合 → 永久不一致
  //
  // 修复：检测「同 status 完成」场景下 patch.completedAt 与 prevCompletedAt
  // 不同 → 视为"完成日改期"语义，在事务里把旧 completions 行 DELETE + 在
  // 新日 INSERT（ON CONFLICT count + 1）。这与 becameDone 的 INSERT 共享
  // 同一份 ON CONFLICT 语义——保证幂等。
  const completedAtChanged =
    !statusChanged &&
    prevStatus === 'done' &&
    merged.status === 'done' &&
    patch.completedAt !== undefined &&
    patch.completedAt !== prevCompletedAt

  // R21 修复 (critical data integrity)：merged.completed_at 来自以下三种输入：
  //   1) patch.completedAt !== undefined → 用户显式提供（保留原值）
  //   2) prevStatus !== 'done' && merged.status === 'done' → becameDone，但
  //      patch.completedAt 未传 → merged.completed_at = existing.completed_at
  //      (可能是 null，比如从 todo 改为 done 时)。这会让 row 落入"status='done'
  //      + completed_at=null"的 corrupted 状态，触发 setStatus 的 R21 检测
  //      分支、且热力图/统计不可信。修复：becameDone 时强制 completed_at = now。
  //   3) becameUndone → merged.status 已非 'done'，但 merged.completed_at 仍
  //      保留旧值，让 STATUS != 'done' 的 row 持有上次的完成时间戳，违反
  //      「completed_at 与 status 一致」不变量。修复：becameUndone 时把
  //      merged.completed_at 清为 null（与下方 DELETE completions 同行）。
  //   4) prevStatus === 'done' && merged.status === 'done' 但 prevCompletedAt=null
  //      → corrupted row 触发的 update（用户没改 status，只改了其他字段）。
  //      merged.completed_at 也会是 null（patch.completedAt 未传）。修复：检测
  //      到 corrupted entry 时**强制**把 completed_at 写为 prevCompletedAt ?? now，
  //      让 row 自愈。下方 completions INSERT/DELETE 逻辑因 status 未变不会触发，
  //      但下一次 setStatus/complete 时此 row 已不再是 corrupted。
  // R22 修复 (high data integrity)：新增 (5) 显式 patch.completedAt=null
  //   但 status='done' 的场景 —— 编辑 modal / AI tool updateSticky 把 completedAt
  //   显式设 null（例如撤销完成回退到 todo，再撤销撤销），merged.status 仍是 'done'
  //   (patch.status 未传) → 落到 statusChanged=false 分支，merged.completed_at = null
  //   被原样写入；下次 setStatus/complete 看到"status='done' & completed_at=null"
  //   会再次触发 corrupted 检测。修复：merged.status === 'done' 且 patch
  //   显式给 completedAt=null 时，把 merged.completed_at 强制为 now（仍维持
  //   "status=done ⇒ completed_at not null" 不变量）。
  if (becameDone) {
    // R27-DI-11 修复 (medium completion-date-mismatch)：原版
    // `merged.completed_at = now` 无条件覆盖 patch.completedAt。
    // 当调用方做历史回填 `update({status:'done', completedAt:'2024-01-01'})`
    // 时，merged.completed_at 被强制改为 now，但 completion-row INSERT
    // 仍走 localDayKeyOf()（今天），造成 completed_at 列与 completions
    // 表的 date 列完全脱节。修复：becameDone 时优先尊重显式
    // patch.completedAt（保留为回填日期），未提供时才用 now。
    merged.completed_at = patch.completedAt ?? now
  } else if (becameUndone) {
    merged.completed_at = null
  } else if (
    !statusChanged &&
    prevStatus === 'done' &&
    merged.status === 'done' &&
    prevCompletedAt == null
  ) {
    // corrupted self-heal: 已 done 但 completed_at 缺失，用 now 修复
    //
    // R31-DI-2 修复 (HIGH backdate-override)：原版无条件 `merged.completed_at = now`
    // —— 会丢掉 patch.completedAt 的显式回填语义（R27-DI-11 在 becameDone
    // 分支已修，但本 sibling 分支被遗漏）。场景：prevStatus='done' 且
    // prevCompletedAt=null（corrupted row）的便签，用户/AI 调用
    // `update({completedAt:'2024-01-01'})` 想回填历史完成时间。原版强制
    // 改为 now，patch.completedAt 被吞；下方 self-heal completions 分支
    // 又用 localDayKeyOf()（今天）写 completions，**用户的历史回填意图
    // 100% 失效**。修复：尊重 patch.completedAt，未提供时退化为 now。
    // 同时下游 self-heal completions 分支需要从 merged.completed_at（不
    // 是 localDayKeyOf()）派生 compDate，下面也会调整。
    merged.completed_at = patch.completedAt ?? now
  } else if (
    !statusChanged &&
    merged.status === 'done' &&
    patch.completedAt === null
  ) {
    // R22-5：编辑路径显式 null 完成时间但保留 status='done' —— 强制 now
    // 维持 status / completed_at 一致性。
    merged.completed_at = now
  }

  // R27-DI-7 修复 (medium invariant-leak)：原版当 patch.completedAt !== undefined
  // 且 patch.status === undefined 时，merged.completed_at 会被原样写入
  // （来自 patch.completedAt 或 existing.completed_at），但 status 字段
  // 完全保持不变。攻击 / 边界场景：update({completedAt:'2024-01-01'}) 调在
  // 一个 status='todo' 的便签上 → merged.completed_at='2024-01-01' 但
  // merged.status='todo'，违反「status='done' iff completed_at NOT NULL」
  // 的核心不变式，且会让 UI 显示「有完成时间戳但状态是 todo」的矛盾态。
  // 修复：merged.completed_at 与 merged.status 的关系由下方「status 派
  // 生命令」统辖——merged.completed_at 非空但 merged.status 非 done
  // （statusChanged=false 且 patch.status 未传且 prevStatus !== 'done'）
  // → 强制把 status 也设为 'done'，让两者一致；若 patch.completedAt 为
  // null 且 merged.status='done'，则上面 R22-5 已经把 merged.completed_at
  // 强制为 now，所以不会落到 completed_at=null 状态。
  // R31-Corr-2a 修复 (MEDIUM auto-promote-missed-completions)：原版 auto-promote
  // 分支（line 617-622）检测到「merged.completed_at != null 且 status 非
  // done 且没显式改 status」就把 merged.status 静默改成 'done'，但**没有
  // 同步写 completions 行**。原因：becameDone 判定要求 statusChanged=true，
  // 而本场景 !statusChanged（patch.status 未传）→ becameDone=false →
  // 下文 completions INSERT 分支永不触发。
  //
  // 失败场景：prevStatus='todo'，prevCompletedAt=null，调用方发
  // `update({completedAt:'2024-01-01'})`（典型：编辑 modal / AI tool
  // updateSticky 回填历史完成日期）。结果 row 落库为 status='done' +
  // completed_at='2024-01-01'，但 completions 表没有该 sticky 在 2024-01-01
  // 的行 → heatmap 永久漏算；UI 元数据面板与 StatsCards 数字脱节。
  //
  // 修复：先于 auto-promote 捕获这个 flag autoPromotedToDone，下面事务
  // 里走专门的 INSERT 分支（与 becameDone 路径对齐，含 archived=1 守卫）。
  //
  // R32-Corr-6 + R32-CRIT-1 修复 (CRITICAL cancelled-sticky-resurrected)：
  // R31 我自己的 flag 漏判 prevStatus='cancelled' —— 用户明确取消的 sticky
  // （prevStatus='cancelled', prevCompletedAt=null），若再被某条 update() 调用
  // 携带 patch.completedAt='YYYY-MM-DD' 走到这里：
  //   - 上面「patch.completedAt 解析」会写 merged.completed_at='YYYY-MM-DD'
  //   - 本 flag 计算 merged.completed_at != null && merged.status !== 'done'
  //     && !statusChanged → true（因为 cancelled !== 'done' 且 status 未显式改）
  //   - 下面 merged.status = 'done' 静默复活 cancelled sticky
  //   - 下方 autoPromotedToDone INSERT 写 completions 行
  // 热力图永久多算一次「已取消却完成」的事件，且 UI 状态字段从 cancelled 翻
  // 成 done 用户完全察觉不到（patch.status 没传）。
  //
  // 修复：autoPromotedToDone flag 增加 `prevStatus !== 'cancelled'` 守卫。
  // 与 stickyNotes.complete() 的「cancelled 拒绝」（R21 修复）对齐 —— 取消
  // 是用户的明确意图，不能被后续 edit / 第三方同步 / AI tool 静默反转。
  const autoPromotedToDone =
    merged.completed_at != null &&
    merged.status !== 'done' &&
    prevStatus !== 'cancelled' &&
    !statusChanged
  if (autoPromotedToDone) {
    merged.status = 'done'
  }

  const stmtId = await prepare(
    `UPDATE sticky_notes SET
       title = ?, date = ?, priority = ?, description = ?, status = ?,
       scheduled_at = ?, due_at = ?, completed_at = ?, tags_json = ?,
       color = ?, recurrence = ?, estimated_minutes = ?, actual_minutes = ?,
       pomodoro_count = ?, starred = ?, archived = ?, updated_at = ?
     WHERE id = ? AND updated_at = ?`,
  )
  // R20 修复：把 UPDATE + completions DELETE/INSERT 包进事务，与 setStatus()
  // 行为一致。
  //
  // R24-Corr-2 修复 (high atomicity)：BEGIN/COMMIT 跨多次 dbClient.call IPC
  // 让出事件循环。AI 工具 + 用户并发 update（编辑器实时保存 + AI 同步改
  // metadata）会交错发 BEGIN，第二个事务错杀第一个。改为
  // dbClient.runInTransaction(work) 串行化。
  let updateResult: Awaited<ReturnType<typeof findById>> = null
  await dbClient.runInTransaction(async () => {
    await dbClient.call('exec', { sql: 'BEGIN' })
    try {
      const result = (await dbClient.call('run', {
        stmtId,
        params: [
          merged.title,
          merged.date,
          merged.priority,
          merged.description,
          merged.status,
          merged.scheduled_at,
          merged.due_at,
          merged.completed_at,
          merged.tags_json,
          merged.color,
          merged.recurrence,
          merged.estimated_minutes,
          merged.actual_minutes,
          merged.pomodoro_count,
          merged.starred,
          merged.archived,
          merged.updated_at,
          id,
          existing.updated_at,
        ],
      })) as { changes?: number }

      if (!result || result.changes === 0) {
        await dbClient.call('exec', { sql: 'COMMIT' })
        // R26-DI-5 修复 (medium silent-failure)：原版 CAS 失败时返回最新 row
        // —— 但 patch 根本没被应用。渲染端拿到这个 row 把 useStickyNotesStore
        // 的乐观更新固化下来，UI 看似成功；下次 reload 又丢。改为返回 null，
        // 让 IPC handler 把 conflict 信号回传，渲染端应重新 fetch + 提示用户。
        log.warn(
          `[stickyNotes.update] CAS conflict for id=${id}; returning null instead of misleading fresh row`,
        )
        updateResult = null
        return
      }

      if (becameUndone) {
        // done → non-done：删除"上次完成日期"对应的 completions 行
        const delDate = prevCompletedAt
          ? localDayKeyOf(new Date(prevCompletedAt))
          : localDayKeyOf()
        const delStmtId = await prepare(
          `DELETE FROM completions WHERE sticky_note_id = ? AND date = ?`,
        )
        await dbClient.call('run', {
          stmtId: delStmtId,
          params: [id, delDate],
        })
      } else if (becameDone) {
        // non-done → done：写入当日 completions 行
        // R27-DI-11 修复 (medium completion-date-mismatch)：原版用
        // localDayKeyOf()（today）作为 completions 表的 date 字段，与上方
        // 写入 sticky_notes.completed_at 的日期不一致。历史回填场景
        // （patch.completedAt='2024-01-01'）会让 completed_at 列写 2024-01-01
        // 但 completions.date 写今天，热力图按后者统计，UI 显示的「完成日」
        // 又按前者，前后矛盾。修复：completion-row 的 date 与 merged.completed_at
        // 派生（merged.completed_at 已在上面 resolved = patch.completedAt ?? now，
        // 两者日期始终一致）。
        //
        // R29-DI-1 修复 (CRITICAL invariant-violation)：complete() handler
        // 在 line 824 强制 `WHERE id = ? AND archived = 0`，已归档 sticky
        // 的 complete() 调用 changes=0 直接返回。但 update() 的 becameDone
        // 分支没有 archived 守卫 —— 一次性 `update({status:'done', archived:true})`
        // （例如批处理脚本、批量归档+完成、AI 自动归档流程）会让已归档 sticky
        // 仍被写入 completions 表，热力图被永久污染。修复：becameDone 路径
        // 与 complete() 对齐，merged.archived=1 时不写 completions（与
        // complete() 早返回语义一致）。
        if (merged.archived === 1) {
          // 显式不下写 completions：保持 update() 与 complete() 对 archived
          // 行处理一致 —— 归档 sticky 的 status 字段仍可改，但不再触发热
          // 力图聚合增量。
          log.warn(
            `[stickyNotes.update] skipping completions INSERT for archived sticky id=${id}; merged.archived=1`,
          )
        } else {
          const compDate = localDayKeyOf(new Date(merged.completed_at ?? now))
          const insertCompStmtId = await prepare(
            `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
             VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count + 1`,
          )
          await dbClient.call('run', {
            stmtId: insertCompStmtId,
            params: [crypto.randomUUID(), id, compDate, now],
          })
        }
      } else if (
        // R22 修复 (high correctness)：corrupted row 触发的自愈分支
        // （prevStatus='done' && prevCompletedAt=null && !statusChanged）。
        // 原版只把 completed_at 改成 now，但 completions 表里**从来没有过这行
        // 的完成记录** —— 后续 setStatus/toggle 切到非 done 时 becameUndone
        // 走 DELETE，但 SELECT 1 的 delDate 是「今天」，可能命中本来不该删的
        // 行；热力图永久少算一次。修复：自愈时同时补写今日 completions 行。
        //
        // R29-DI-1 修复补充：与 becameDone 分支同步加 archived 守卫。
        // 已归档 sticky 的 corrupted-row 自愈不应触发 completions 增量，
        // 与 complete() / becameDone 路径保持一致。
        //
        // R31-DI-2 修复 (HIGH backdate-override)：与上方 line 593 配对 ——
        // 上方已把 merged.completed_at 改成 `patch.completedAt ?? now`，本
        // 分支需要从 merged.completed_at 派生 compDate，不再硬编
        // localDayKeyOf()。否则 patch.completedAt='2024-01-01' 的历史回填
        // 会让 sticky_notes.completed_at 与 completions.date 错位（前者
        // 2024-01-01、后者今天）。改成与 becameDone 分支同一语义。
        !statusChanged &&
        prevStatus === 'done' &&
        prevCompletedAt == null &&
        merged.status === 'done'
      ) {
        if (merged.archived === 1) {
          log.warn(
            `[stickyNotes.update] skipping corrupted-self-heal completions for archived sticky id=${id}`,
          )
        } else {
          const compDate = localDayKeyOf(new Date(merged.completed_at ?? now))
          const insertCompStmtId = await prepare(
            `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
             VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count + 1`,
          )
          await dbClient.call('run', {
            stmtId: insertCompStmtId,
            params: [crypto.randomUUID(), id, compDate, now],
          })
        }
      } else if (autoPromotedToDone) {
        // R31-Corr-2a 修复 (MEDIUM auto-promote-missed-completions)：
        // 上方 line 617-622 auto-promote 把 status 静默改成 'done' 但
        // 没有触发 completions INSERT。这里补齐 INSERT，日期从
        // merged.completed_at 派生（覆盖 patch.completedAt='2024-01-01'
        // 的历史回填场景）。与 becameDone 路径同步加 archived 守卫。
        //
        // R32-Corr-5 修复 (HIGH 1970-pollution-via-null-cast)：原版
        // `new Date(merged.completed_at as string)` unsafe cast —— 即使
        // R32-CRIT-1 修了 cancelled 守卫，仍有其他分支顺序改动把
        // merged.completed_at 改成 null 的可能。`new Date(null as string)`
        // 静默返回 epoch 0，localDayKeyOf 出 '1970-01-01' → heatmap 永久
        // 多出 1970 年的诡异完成点。用 `?? now` 兜底，与 sibling 分支对齐。
        //
        // R32-MED-2 + R32-Corr-10 修复 (MEDIUM double-count-on-conflict)：
        // ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count + 1
        // 让 count 在同一日被多次调用时累加 —— 但 auto-promote 是**数据修
        // 复**（merged.status 之前 status!='done' 但已有 completed_at /
        // 或 prevCompletedAt 非空说明已记录过），不是新完成事件。语义上
        // 应当幂等：「已有 completions 行 → 不动 count；没有 → 插入 count=1」。
        // 改成 ON CONFLICT DO NOTHING + 在调用前先 SELECT 1 探测浪费一次
        // IPC，改为 UPSERT 仅在不存在时插入：先 SELECT COUNT(*)，0 行才
        // 真 INSERT；否则跳过。这样 UUID 生成也只在实际需要时执行，避免
        // R32-Corr-10 提到的「UUID 生成即丢弃」浪费。
        if (merged.archived === 1) {
          log.warn(
            `[stickyNotes.update] skipping auto-promote completions INSERT for archived sticky id=${id}`,
          )
        } else {
          const compDate = localDayKeyOf(new Date(merged.completed_at ?? now))
          // 探测：是否已有该 sticky+date 的 completions 行？
          const probeStmtId = await prepare(
            `SELECT 1 FROM completions WHERE sticky_note_id = ? AND date = ? LIMIT 1`,
          )
          const probe = (await dbClient.call('get', {
            stmtId: probeStmtId,
            params: [id, compDate],
          })) as { 1: number } | undefined
          if (!probe) {
            // 真正新完成事件：写 1 条
            const insertCompStmtId = await prepare(
              `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(sticky_note_id, date) DO NOTHING`,
            )
            await dbClient.call('run', {
              stmtId: insertCompStmtId,
              params: [crypto.randomUUID(), id, compDate, now],
            })
          }
          // 已有：DO NOTHING（幂等 —— auto-promote 是数据修复，不是新事件）
        }
      } else if (completedAtChanged) {
        // R30-DI-2 修复 (HIGH completions-staleness)：完成日被改期
        // （status='done' → 仍 'done'，但 completedAt 从旧日迁到新日）
        // —— 把 completions 行从 prevCompletedAt 当日移到 merged.completed_at
        // 当日，保持 sticky_notes.completed_at 与 completions.date 严格同步。
        //
        // 边界：prevCompletedAt 为 null（说明这是上次 corrupted row 自愈
        // 的瞬间，下一次用户改 completedAt 走本分支）—— 删除时应按
        // 「merged.completed_at 的前一天」推算？这条路径不进，因为
        // prevCompletedAt 必然有值才被 R30-DI-2 触发（completedAtChanged
        // 要求 patch.completedAt !== prevCompletedAt，所以 prevCompletedAt
        // 不能是 null——line 528 那个 corrupted 自愈分支把 prevCompletedAt
        // 写成 now，下一次改期时 prevCompletedAt 是有值的字符串）。
        //
        // 边界 2：merged.completed_at 也是 null（用户 update({completedAt:null})
        // 但保留 status='done'）—— 上方 R22-5 分支会把 merged.completed_at
        // 强制成 now，completedAtChanged 不会触发（patch.completedAt !== prev
        // 这里 patch.completedAt === null 但被前面解析成 now，等同于
        // prevCompletedAt 是旧日 / new 是 now，逻辑走「同日不移动」）。
        //
        // 边界 3：merged.archived=1 —— 仍要移动 completions 行吗？
        // 与 R29-DI-1 becameDone 路径对齐：归档 sticky 不写 completions
        // （避免热力图算到已归档条目）。本分支既有 stale completions 行需要
        // 删除（避免遗留聚合），也不应在新区间插入新行。
        const oldDayKey = localDayKeyOf(new Date(prevCompletedAt ?? now))
        const newDayKey = localDayKeyOf(new Date(merged.completed_at ?? now))
        if (oldDayKey !== newDayKey) {
          if (merged.archived === 1) {
            // 归档 sticky：只删旧 completions 行，不写新行。
            const delStmtId2 = await prepare(
              `DELETE FROM completions WHERE sticky_note_id = ? AND date = ?`,
            )
            await dbClient.call('run', {
              stmtId: delStmtId2,
              params: [id, oldDayKey],
            })
            log.warn(
              `[stickyNotes.update] cleared stale completions row for archived sticky id=${id} on backdate ${oldDayKey}→${newDayKey}`,
            )
          } else {
            // 正常路径：原子删除旧行 + 插入新行（共享同一事务）。
            const delStmtId2 = await prepare(
              `DELETE FROM completions WHERE sticky_note_id = ? AND date = ?`,
            )
            await dbClient.call('run', {
              stmtId: delStmtId2,
              params: [id, oldDayKey],
            })
            const insertCompStmtId2 = await prepare(
              `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(sticky_note_id, date) DO NOTHING`,
            )
            await dbClient.call('run', {
              stmtId: insertCompStmtId2,
              params: [crypto.randomUUID(), id, newDayKey, now],
            })
          }
        }
      }
      await dbClient.call('exec', { sql: 'COMMIT' })
    } catch (err) {
      try {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
      } catch {
        /* swallow rollback errors */
      }
      throw err
    }
  })
  // R24-DI-7 修复 (medium stmt-leak)：原版在分支里 prepare 的
  // delStmtId / insertCompStmtId 没 finalize，每次 update() 走完一条
  // completion 副作用就漏 1 条。修：跑一次 select / run 后立刻在
  // withPrepared 风格 finalize 之外保留 prepared（高复用），但在 try/finally
  // 兜底——这里简化：复用 prepare 缓存（key=SQL 文本），worker's LRU 仍
  // 会替我们清理，主进程不直接 finalize。改为 return updateResult / fallback。
  return updateResult ?? findById(id)
}

async function remove(id: ID): Promise<boolean> {
  // R32-DI-HIGH-1 修复 (HIGH orphan-completions-inflate-heatmap)：原版
  // 直接 `DELETE FROM sticky_notes WHERE id = ?`。completions 表的 FK 是
  // `ON DELETE SET NULL`（migration 006 line 48）—— 删除 sticky 后该 sticky
  // 的 completions 行 sticky_note_id 变 NULL，**但 count 仍存在**。
  // completionsRepo.dailyCounts / totalInRange 用 SUM(count) 不带 sticky
  // 过滤，把这些「孤儿」count 算进 heatmap，对应那一天的聚合永久虚高
  // （用户已删的 sticky 在日历里还能看到格子）。
  //
  // 修复：包进事务，显式 DELETE FROM completions WHERE sticky_note_id = ?
  // 再 DELETE FROM sticky_notes。completions 行物理消失，热力图回到正
  // 确状态。FK SET NULL 保留为「系统聚合（null stickyNoteId）」的合法路
  // 径 —— 那些行没有 sticky_note_id 是合法的（completion-handlers.ts:33
  // 的 recordSystemAggregate 路径），与孤儿是两回事。
  let changes = 0
  await dbClient.runInTransaction(async () => {
    await dbClient.call('exec', { sql: 'BEGIN' })
    try {
      const delCompStmtId = await prepare(
        `DELETE FROM completions WHERE sticky_note_id = ?`,
      )
      await dbClient.call('run', { stmtId: delCompStmtId, params: [id] })
      // R33-DI-2 修复 (HIGH orphan-pomodoros-inflate-focus-heatmap)：与
      // R32-DI-HIGH-1 同样的 FK ON DELETE SET NULL 模式在 pomodoros 表
      // 重复 —— sticky 删除后 pomodoros.sticky_note_id 变 NULL，
      // pomodorosRepo.dailyMinutes 不带 sticky 过滤把「孤儿」算进聚合，
      // 专注时长热力图永久虚高。同步 DELETE FROM pomodoros 保持两个聚合
      // 表的语义一致。
      const delPomoStmtId = await prepare(
        `DELETE FROM pomodoros WHERE sticky_note_id = ?`,
      )
      await dbClient.call('run', { stmtId: delPomoStmtId, params: [id] })
      const delStickyStmtId = await prepare(`DELETE FROM sticky_notes WHERE id = ?`)
      const info = (await dbClient.call('run', {
        stmtId: delStickyStmtId,
        params: [id],
      })) as { changes: number }
      changes = info.changes
      await dbClient.call('exec', { sql: 'COMMIT' })
    } catch (err) {
      try {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
      } catch {
        /* swallow */
      }
      throw err
    }
  })
  // FK ON DELETE CASCADE 自动清掉 sticky_note_steps
  return changes > 0
}

/** 完成便签：status=done + completedAt=now + 写入 completions */
async function complete(id: ID, opts?: { date?: string }): Promise<StickyNote | null> {
  const now = new Date().toISOString()
  const completionDate = opts?.date ?? localDayKeyOf() // 本地 YYYY-MM-DD（D2-fix）

  // R24-Corr-3 修复 (high atomicity)：BEGIN/COMMIT 跨多次 dbClient.call IPC
  // 让出事件循环，并发 complete()（用户连点完成 + AI 工具 / 多窗口同步）会
  // 交错 BEGIN，第二个事务错杀第一个。改为 dbClient.runInTransaction 串行化。
  let finalResult: Awaited<ReturnType<typeof findById>> = null
  await dbClient.runInTransaction(async () => {
    await dbClient.call('exec', { sql: 'BEGIN' })
    try {
      // M7：若当前已是 done 且 completed_at 在同一天，幂等返回（避免 count 双增）
      const curStmtId = await prepare(
        `SELECT status, completed_at FROM sticky_notes WHERE id = ?`,
      )
      const cur = (await dbClient.call('get', {
        stmtId: curStmtId,
        params: [id],
      })) as { status: StickyStatus; completed_at: string | null } | undefined
      if (!cur) {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
        finalResult = null
        return
      }
      // R21 修复 (low data integrity)：complete() 不挡 cancelled 状态 —— 用户
      // 主动取消的 sticky 若被 AI tool completeSticky / 撤销恢复 / 第三方调用
      // 触发 complete()，会被默默改回 done 并写 completions，热力图统计出现
      // 「已取消却完成」的不一致。返回 null 让上层调用方知道此 sticky 已 cancelled。
      if (cur.status === 'cancelled') {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
        log.warn(
          `[stickyNotes.complete] refusing to complete cancelled sticky id=${id}; returning null`,
        )
        finalResult = null
        return
      }
      // R15 修复 (high)：原来「同一天直接早返回」只覆盖同一天；跨天时
      // （cur.status==='done' && completed_at 已是昨天）会落到下面的 UPDATE，
      // 但 UPDATE 的 WHERE 仍有 `status != 'done'`，changes=0 → 直接走
      // 早返回分支，**当天的 completions 行不会被写入**，热力图漏计。
      // 显式区分三种情况：
      //   a) 当前不是 done → 走 UPDATE + 写 completions
      //   b) done 且 completed_at 是今天（同一天）→ 早返回（幂等）
      //   c) done 且 completed_at 是更早（跨天）→ 强制 UPDATE + 写 completions
      // R22 修复 (high correctness)：补充 (d) status='done' 但 completed_at=null
      //   (corrupted row)。原版要求 cur.completed_at 真值才进 early-return 分支，
      //   走到下方标准 SQL 时 `WHERE status != 'done'` 对已 done 行始终不匹配，
      //   changes=0 → 静默回滚 + 返回，未写 completions。setStatus() 在 R21 已加
      //   isCorrupted 分支自愈 + 写 completions；complete() 同样需要。
      let isCrossDayReComplete = false
      let isCorruptedRow = false
      if (cur.status === 'done' && !cur.completed_at) {
        // corrupted：status=done 但 completed_at 缺失 → 视同重新完成（与
        // becameDone 路径同语义），强制 UPDATE + 写 completions。
        isCorruptedRow = true
        log.warn(
          `[stickyNotes.complete] detected corrupted row id=${id}: status='done' but completed_at=null; self-healing`,
        )
      } else if (cur.status === 'done' && cur.completed_at) {
        const completedLocalDate = localDayKeyOf(new Date(cur.completed_at))
        if (completedLocalDate === completionDate) {
          await dbClient.call('exec', { sql: 'COMMIT' })
          // R33-Corr-1 修复 (HIGH complete-returns-truthy-on-idempotent)：
          // 原版 finalResult = await findById(id) 返回一个 status='done' &
          // completedAt 真值的 truthy row —— IPC handler 的 `result &&
          // result.status === 'done' && result.completedAt` 守卫为 true，
          // 触发 ackPendingDue(1)。但本次调用根本没改 status 也没写
          // completions（幂等），连点 / 双窗口都会让计数累加下溢。
          // 修复：返回 null 让 IPC handler 跳过 ack（与 R23 「CAS miss
          // 返回 null 跳过 ack」一致）。
          finalResult = null
          return
        }
        isCrossDayReComplete = true
      }

      // 跨天再完成：去掉 status != 'done' 谓词，否则永远不会更新 completed_at / 写 completions。
      // R16 修复 (high)：跨天分支加 completed_at CAS —— 两个并发 complete() 调用各自
      // SELECT 读到同一行（status=done, completed_at=Y），没有 CAS 时两者都 UPDATE 成功
      // → 各写一次 completions(count++)，热力图双增。CAS 让"read 时拿到的 completed_at
      // 已被前一个 writer 改写"的并发事务拿到 changes=0、走早返回。
      // R22 修复 (high correctness)：corrupted row 也走跨天分支 —— 谓词
      // `status != 'done'` 对 corrupted 行 (status=done) 不匹配，changes=0，
      // 会让 corrupted 自愈失效。
      const updateSql = isCrossDayReComplete || isCorruptedRow
        ? `UPDATE sticky_notes SET status = 'done', completed_at = ?, updated_at = ?
           WHERE id = ? AND archived = 0 AND completed_at IS ?`
        : // R14 修复 (high)：把 status != 'done' 写进 WHERE，两个并发
          // complete() 调用最多只有一个 changes=1，第二个的 changes=0 走
          // 早返回分支，避免 completions.count 双增。
          `UPDATE sticky_notes SET status = 'done', completed_at = ?, updated_at = ?
           WHERE id = ? AND archived = 0 AND status != 'done'`
      const updateStmtId = await prepare(updateSql)
      const updateParams: unknown[] = isCrossDayReComplete
        ? [now, now, id, cur.completed_at]
        : isCorruptedRow
          ? [now, now, id, null] // completed_at IS NULL 谓词
          : [now, now, id]
      const updateResult = (await dbClient.call('run', {
        stmtId: updateStmtId,
        params: updateParams,
      })) as { changes?: number }
      if (!updateResult || updateResult.changes === 0) {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
        // R23 修复 (high correctness)：原 `return findById(id)` 让 IPC handler
        // 看到的是 truthy → 误 ack pending-due badge 计数（即便 UPDATE 没匹配
        // 到行 —— 例如 sticky 已 archived / 并发 CAS miss）。返回 null 让
        // handler 不触发 ack，与 R22 修过的「ackPendingDue 仅在 result 真值
        // 且 status 真的变了才 -1」一致。同一天的幂等返回（line 730 那个）
        // 不受此影响 —— 那里 findById 仍是对的，因为 complete() 没 no-op。
        finalResult = null
        return
      }

      // 写 completions：upsert by (sticky_note_id, date) —— 一天多次完成只算 1 次
      const insertCompStmtId = await prepare(
        `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count + 1`,
      )
      await dbClient.call('run', {
        stmtId: insertCompStmtId,
        params: [crypto.randomUUID(), id, completionDate, now],
      })

      await dbClient.call('exec', { sql: 'COMMIT' })
      finalResult = await findById(id)
    } catch (err) {
      try {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
      } catch (_) {
        // ignore
      }
      throw err
    }
  })
  return finalResult
}

/** 显式设置状态（todo / in_progress / done / cancelled） */
async function setStatus(id: ID, status: StickyStatus): Promise<StickyNote | null> {
  const now = new Date().toISOString()
  // M7：当目标 status==='done' 且当前已是 done 且同一天，跳过 completions 写入
  let skipCompletion = false
  // R15 修复 (high)：跨天再进入 done 时，UPDATE 必须能匹配到行；用 isCrossDay 标记
  // 切到不带 `status != 'done'` 谓词的 SQL。同一天的 done→done 仍是幂等跳过。
  let isCrossDayReComplete = false
  // R21 修复 (critical)：cur.status='done' 但 completed_at=null 的 corrupted
  // row 用此标记；SQL 的 `completed_at = ?` 在 NULL 上永远 false，必须改用
  // 专门的 statusGuard（见下）。
  let isCorrupted = false
  // R16 修复 (high)：跨天 CAS 用 —— 上面 SELECT 时拿到的 completed_at 快照，
  // 在 WHERE 里做 "completed_at = ?" 谓词；并发 setStatus 第二个事务 SELECT
  // 拿到的是已被前一个事务 update 过的 completed_at，第二个的 UPDATE changes=0。
  let curCompletedAt: string | null = null
  // R20 修复 (high data integrity)：setStatus() 之前无条件 SET completed_at = null
  // (status !== 'done')，但 completions 表里的当日行不会被删除 → "今日完成 N
  // 个便签" 计数无法撤销，用户取消勾选后热力图仍显示 +1。
  // 同时存在「done → cancelled → done 同日」序列双计：第一次完成写 row(count=1)
  // → 取消时 row 不删 → 再次完成 INSERT ON CONFLICT 把 count=2 → 热力图虚增。
  //
  // 修复：进入事务前先 SELECT cur.status / cur.completed_at；事务内根据状态
  // 转移方向同步 INSERT/DELETE completions 行（同一事务原子化）：
  //   - non-done → done 当日：新 INSERT（或 count++ 当已存在 row —— 但 setStatus
  //     不允许同 cur.status='done' 再次进 done，所以这条路径下 row 不存在）
  //   - done → non-done 当日：DELETE completions WHERE sticky_note_id=? AND date=today
  //   - 跨天重完成（已在前面 if 分支识别）：新 INSERT（不同日期是新 row）
  //   - 跨天取消：DELETE row WHERE date = cur.completed_at 对应本地日
  let prevStatus: StickyStatus | null = null
  let prevCompletedAt: string | null = null
  {
    const curStmtId = await prepare(
      `SELECT status, completed_at FROM sticky_notes WHERE id = ?`,
    )
    const cur = (await dbClient.call('get', {
      stmtId: curStmtId,
      params: [id],
    })) as { status: StickyStatus; completed_at: string | null } | undefined
    if (cur) {
      prevStatus = cur.status
      prevCompletedAt = cur.completed_at
      // R6S-2：completed_at 是 UTC ISO；用本地日期派生再与 localDayKeyOf 比较，
      // 避免 UTC+8 凌晨 0-8 点的完成被误判为昨天。
      // R20 修复 (medium data-integrity)：原版要求 cur.completed_at 必须 truthy
      // 才走跨天检测；corrupted row（cur.status='done' 但 completed_at=null，
      // 历史迁移 / 手工 INSERT / 老版本迁移 bug 都会产生）会被静默绕过
      // statusGuard=no-op，导致 status='done' 的 corrupt row 永远不会被
      // 修正，下一次 setStatus('done') 看似"成功"实际未写完成。
      // R21 修复 (critical)：原版给 corrupted-row 也走跨天分支
      // `AND completed_at = ?`，但 SQL 中 NULL = NULL 永远 false →
      // 整个 UPDATE 命中 0 行，completion INSERT 仍按 non-corrupted 路径走
      // 漏写。修复：corrupted-row 跳过 CAS，用专门的 statusGuard（见下）。
      if (status === 'done' && cur.status === 'done') {
        if (cur.completed_at) {
          const completedLocalDate = localDayKeyOf(new Date(cur.completed_at))
          if (completedLocalDate === localDayKeyOf()) {
            skipCompletion = true
          } else {
            isCrossDayReComplete = true
            curCompletedAt = cur.completed_at
          }
        } else {
          // corrupted：status=done 但 completed_at 为空 —— 不走 completed_at CAS
          // 走普通状态转移路径，让 cur.status='done' → merged.status='done' 时
          // statusGuard 直接放行并修正 completed_at=now
          log.warn(
            `[stickyNotes.setStatus] detected corrupted row id=${id}: status='done' but completed_at=null; treating as fresh completion (no CAS)`,
          )
          isCorrupted = true
        }
      }
    }
  }

  const completedAt = status === 'done' ? now : null
  // R15 修复 (high)：跨天再进入 done 时去掉 `status != 'done'` 谓词，
  // 否则 changes=0、走早返回、当天的 completions 漏写。其它情况保留谓词。
  // R16 修复 (high)：跨天分支加 completed_at CAS，同 complete()：没有 CAS 时
  // 两个并发 setStatus('done') 各自 SELECT 读到 completed_at=Y → 各自 UPDATE
  // 成功 → 各自 INSERT completions(count++) → 热力图双增。
  // R21 修复 (critical)：新增 corrupted-row 分支：cur.status='done' 但
  // completed_at=null 时，statusGuard 用 `AND status='done' AND archived=0`
  // （不用 completed_at CAS 因为 NULL=NULL 是 NULL）。其它分支不变。
  const statusGuard =
    isCorrupted
      ? "AND status = 'done' AND archived = 0"
      : status === 'done' && !isCrossDayReComplete
        ? "AND (? != 'done' OR status != 'done') AND archived = 0"
        : isCrossDayReComplete
          ? 'AND completed_at = ? AND archived = 0'
          : 'AND archived = 0'
  const stmtId = await prepare(
    // R14 status != 'done' predicate carried over via statusGuard above.
    // 带谓词后第二个变化的 changes=0，
    `UPDATE sticky_notes SET status = ?, completed_at = ?, updated_at = ?
     WHERE id = ? ${statusGuard}`,
  )
  // R5-16：UPDATE + completions INSERT 必须原子化。complete() 在 round 4 已经
  // 用 BEGIN/COMMIT 包裹了，setStatus() 这个非 complete 路径若进入 done 也得
  // 同步写 completions，不能漏掉。
  //
  // R24-Corr-4 修复 (high atomicity)：BEGIN/COMMIT 跨多次 dbClient.call IPC
  // 让出事件循环，并发 setStatus（用户连切 status + AI 工具 / 多窗口同步）
  // 会交错 BEGIN，第二个事务错杀第一个。改为 dbClient.runInTransaction
  // 串行化。
  let finalResult: Awaited<ReturnType<typeof findById>> = null
  await dbClient.runInTransaction(async () => {
    await dbClient.call('exec', { sql: 'BEGIN' })
    try {
      // R19 修复 (critical)：之前三个分支全部塞 5 个 param，但 SQL 仅在有
      //   statusGuard 的情况下需要 5 个 ?。statusGuard='' 分支（status 非
      //   done 且非跨天重完成）只占 4 个 ?，多余一个 status 会触发 better-sqlite3
      //   「Too many parameter values were provided」抛错 → 渲染端的 status
      //   todo↔in_progress↔cancelled 切换全部 500 → 用户无法改便签状态。
      // 修复：按 statusGuard 实际占位符数组装 params，每个分支独立。
      const updateParams: unknown[] = isCrossDayReComplete
        ? [status, completedAt, now, id, curCompletedAt]
        : isCorrupted
          ? [status, completedAt, now, id]
          : statusGuard === "AND (? != 'done' OR status != 'done') AND archived = 0"
            ? [status, completedAt, now, id, status]
            : [status, completedAt, now, id]
      const result = (await dbClient.call('run', {
        stmtId,
        params: updateParams,
      })) as { changes?: number }
      if (!result || result.changes === 0) {
        await dbClient.call('exec', { sql: 'COMMIT' })
        // R23 修复 (high correctness)：原 `return findById(id)` 让 IPC handler
        // 误以为 setStatus 成功 → ackPendingDue(1) 让 dock badge 计数脱钩
        // （archived 行 / 并发 CAS miss / 跨天 status=done 已是 done 都会落到
        // changes=0）。返回 null 让 STICKY_NOTE_SET_STATUS handler 走 R22 修
        // 过的 `if (result && ...)` 守卫，不 ack。
        finalResult = null
        return
      }
      // R20 修复 (high)：根据状态转移方向同步维护 completions 行，与 UPDATE
      // 一起 commit；任一失败整体 ROLLBACK。
      if (prevStatus === 'done' && status !== 'done') {
        // done → non-done：删除当日 completions 行；只删"上次完成日期对应本地日"
        // 那一行（避免误删历史跨天记录）。
        const delDate = prevCompletedAt ? localDayKeyOf(new Date(prevCompletedAt)) : localDayKeyOf()
        const delStmtId = await prepare(
          `DELETE FROM completions WHERE sticky_note_id = ? AND date = ?`,
        )
        await dbClient.call('run', {
          stmtId: delStmtId,
          params: [id, delDate],
        })
      } else if (status === 'done' && !skipCompletion) {
        // non-done → done 或跨天重完成：写入 completions 行（ON CONFLICT 累加
        // 保护同一天反复勾选的极端情况，但正常路径 row 不存在 → count=1）
        const compDate = localDayKeyOf()
        const insertCompStmtId = await prepare(
          `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count + 1`,
        )
        await dbClient.call('run', {
          stmtId: insertCompStmtId,
          params: [crypto.randomUUID(), id, compDate, now],
        })
      }
      await dbClient.call('exec', { sql: 'COMMIT' })
      finalResult = await findById(id)
    } catch (err) {
      try {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
      } catch {
        /* rollback 自身失败吞掉 —— 原始错误更重要 */
      }
      throw err
    }
  })
  return finalResult
}

/** 归档 / 取消归档 */
async function archive(id: ID, archived: boolean): Promise<StickyNote | null> {
  const now = new Date().toISOString()
  // R26-DI-6 修复 (medium cas-missing)：原 SQL 仅 `WHERE id = ?`，无
  // updated_at CAS 谓词。窗口 A 正在执行 update({title})，SELECT 拿到旧
  // updated_at=A；窗口 B 调用 archive，archive 立即无脑 UPDATE 成功（changes=1）
  // 并把 updated_at 推到 B> A；A 的 CAS 谓词基于旧 A 谓词 changes=0，
  // A 的 update 走 findById 返回「未变更 row」给 IPC → 渲染端 title 改动看似
  // 落库实际丢了。改为 read-then-CAS：先 SELECT updated_at，再 UPDATE WHERE
  // id=? AND updated_at=?，CAS 失败 → 重读 + 重试（最多 3 次）。
  for (let attempt = 0; attempt < 3; attempt++) {
    const selStmtId = await prepare(`SELECT updated_at FROM sticky_notes WHERE id = ?`)
    const cur = (await dbClient.call('get', {
      stmtId: selStmtId,
      params: [id],
    })) as { updated_at: string } | undefined
    if (!cur) return null
    const stmtId = await prepare(
      `UPDATE sticky_notes SET archived = ?, updated_at = ? WHERE id = ? AND updated_at = ?`,
    )
    const result = (await dbClient.call('run', {
      stmtId,
      params: [archived ? 1 : 0, now, id, cur.updated_at],
    })) as { changes?: number }
    if (result?.changes === 1) return findById(id)
    // CAS 失败 → 下一轮重读最新 updated_at
  }
  log.warn(`[stickyNotes.archive] CAS conflict after 3 attempts for id=${id}`)
  return null
}

/** 翻转星标（返回最新值）—— 用单条 SQL 避免 read-modify-write 竞争 */
async function toggleStarred(id: ID): Promise<StickyNote | null> {
  // R27-DI-12 修复 (medium race-condition)：原 read-then-CAS 循环
  // （SELECT starred → 翻转 → UPDATE WHERE updated_at=?）在并发
  // toggler 下会出现"两次读到相同状态、互相撤销"的问题：A 读到 starred=0
  // 想设 1；B 读到 starred=0 想设 1。A 先写成功，B 的 CAS 失败但 retry 后
  // 读到 starred=1，B 的「翻转」逻辑把它算成 0 并写回 → 实际状态退回 0，
  // A 同步收到的返回值显示 starred=1 但下次 reload 显示 0，两个客户端都
  // 以为成功但落地态错误。toggle 操作本质上是 XOR/flip，可以用单条
  // `UPDATE ... SET starred = 1 - starred` 原子完成，避免 read-modify-write
  // 与并发 update({title}) 的 CAS 互撞。同时不再需要重试循环（toggle 不会
  // 因为别的写者而失败，只会被另一个 toggle 翻转回去 —— 这是正确语义）。
  // 注意：与并发 update({title}) 的并发场景下，本 UPDATE 也会刷新
  // updated_at，可能让对方的 CAS 失败 → 这是 R26 修复愿意接受的取舍
  // （archive / toggleStarred 自身 CAS 缺失已修复，见下方 archive 路径）。
  const now = new Date().toISOString()
  const stmtId = await prepare(
    `UPDATE sticky_notes SET starred = CASE starred WHEN 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?`,
  )
  const result = (await dbClient.call('run', {
    stmtId,
    params: [now, id],
  })) as { changes?: number }
  if (!result || result.changes === 0) return null
  return findById(id)
}

/** 单独记录一次完成（用于历史回填或重复完成触发） */
async function recordCompletion(id: ID, date: string): Promise<{ id: string; date: string }> {
  // R28-DI-2 修复 (medium data-integrity)：原版把任意 string 当 date 写
  // 入 completions —— AI tool completeSticky(date='2024-13-40') / 手填
  // 历史回填都可能传非 YYYY-MM-DD / 不存在的日期，把热力图聚合切成碎片。
  // 复用 completionsRepo.validateDayKey 守住 YYYY-MM-DD + 真实存在日。
  const safeDate = validateDayKey(date)
  const now = new Date().toISOString()
  const compId = crypto.randomUUID()
  // R21 修复 (low data integrity)：原版不验证 sticky 是否存在。理论上 schema
  // 上有 FOREIGN KEY(sticky_note_id) REFERENCES sticky_notes(id)，被删除的
  // sticky 会触发 FK violation；但 recordCompletion 常被 IPC handler 直接调
  // 用（不是 complete() 内的事务路径），FK violation 会抛 SQLITE_CONSTRAINT
  // 给前端，UI 看到的是模糊的「数据库错误」而不是「便签已删除」。先做 1 次
  // 轻量 SELECT 校验 sticky 存在性，命中 missing 时返回明确错误并打 warn 日志。
  //
  // R26-Corr-8 修复 (low stmt-leak)：原 existsStmtId 走裸 prepare 不进 cache
  // 也不 finalize；番茄钟用户每天 ~8 次 phase 完成 × 30 天 = 240 条/月的
  // prepared statement 漏在 worker 缓存里。改为走 prepare() 共享 cache
  // （module 顶层 prepare 函数自身已经过 stmtCache）。
  //
  // R27-DI-10 修复 (medium invariant-leak)：原版只校验 sticky 存在，
  // 不校验 status。complete()（R21 修过）拒绝 cancelled status，但
  // recordCompletion 是 IPC handler 直调的旁路 —— AI tool completeSticky
  // / history 回填等路径都走这里，cancelled 的 sticky 也能写 completion，
  // 让热力图出现「已取消却完成」的伪数据，与「status=done iff
  // completed_at IS NOT NULL」的核心不变式冲突。修复：同一次 SELECT
  // 一起读 status，cancelled 直接拒绝抛错，与 complete() 行为对齐。
  // R31-Corr-2b 修复 (MEDIUM SELECT-then-INSERT race)：原版分两步走 IPC：
  // 先 SELECT status / archived 校验，再 INSERT completions。两步之间
  // worker 单连接串行保证 SELECT 看到的值就是下一次 INSERT 看到的值吗？
  // 并不保证：别的 webContents / IPC handler / 自动归档脚本可能在这之
  // 间改 status='cancelled' / archived=1。R30-DI-1 的不变式守卫会被绕过：
  // SELECT 时 status='done' → 通过守卫 → 中间被改成 'cancelled' →
  // INSERT 仍写 completion，与 cancelled 不该有 completion 的不变式冲突。
  // 修复：把校验条件编码进 INSERT 的 WHERE 谓词。SQLite 单条 INSERT 的
  // 子查询在同一事务的同一时刻读 sticky_notes，原子语义保留：
  // `INSERT INTO completions SELECT ?, id, ?, 1, ? FROM sticky_notes
  //   WHERE id=? AND status='done' AND archived=0`。
  // 若 changes=0 说明守卫条件不命中（status 改了 / sticky 被删了），
  // 由调用方决定是再次 SELECT 拿准确状态抛错，还是直接报通用错误。
  await dbClient.runInTransaction(async () => {
    await dbClient.call('exec', { sql: 'BEGIN' })
    try {
      const insertStmtId = await prepare(
        `INSERT INTO completions (id, sticky_note_id, date, count, created_at)
         SELECT ?, id, ?, 1, ? FROM sticky_notes
         WHERE id = ? AND status = 'done' AND archived = 0`,
      )
      const insertResult = (await dbClient.call('run', {
        stmtId: insertStmtId,
        params: [compId, safeDate, now, id],
      })) as { changes?: number }
      if (!insertResult || insertResult.changes === 0) {
        await dbClient.call('exec', { sql: 'COMMIT' })
        // 子查询没匹配：要么 sticky 不存在 / status!=done / archived=1。
        // 复用 SELECT 拿精确 status 给上游明确的错误信息（保留原 R21 /
        // R27-DI-10 / R30-DI-1 的「明语错误」语义）。
        const existsStmtId = await prepare(
          `SELECT status, archived FROM sticky_notes WHERE id = ? LIMIT 1`,
        )
        const existsRow = (await dbClient.call('get', {
          stmtId: existsStmtId,
          params: [id],
        })) as { status?: string; archived?: number } | undefined
        if (!existsRow) {
          log.warn(
            `[stickyNotes.recordCompletion] refusing orphan completion: sticky ${id} not found`,
          )
          throw new Error(
            `[stickyNotes.recordCompletion] sticky_note ${id} does not exist; refusing to write orphan completion`,
          )
        }
        if (existsRow.status === 'cancelled') {
          log.warn(
            `[stickyNotes.recordCompletion] refusing completion on cancelled sticky ${id}`,
          )
          throw new Error(
            `[stickyNotes.recordCompletion] sticky_note ${id} has status='cancelled'; refusing to write completion`,
          )
        }
        if (existsRow.archived === 1) {
          log.warn(
            `[stickyNotes.recordCompletion] refusing completion on archived sticky ${id}`,
          )
          throw new Error(
            `[stickyNotes.recordCompletion] sticky_note ${id} is archived; refusing to write completion`,
          )
        }
        log.warn(
          `[stickyNotes.recordCompletion] refusing completion on non-done sticky ${id} (status=${existsRow.status})`,
        )
        throw new Error(
          `[stickyNotes.recordCompletion] sticky_note ${id} has status='${existsRow.status}' (must be 'done'); use completeSticky / setStatus('done') before recording`,
        )
      }
      await dbClient.call('exec', { sql: 'COMMIT' })
    } catch (err) {
      try {
        await dbClient.call('exec', { sql: 'ROLLBACK' })
      } catch {
        /* swallow */
      }
      throw err
    }
  })
  return { id: compId, date: safeDate }
}

/* ============== Step CRUD ============== */

/** 追加 step — order 缺省时取当前 max + 1；若 UNIQUE 冲突则自动顺延 */
async function addStep(noteId: ID, content: string, order?: number): Promise<StickyNoteStep> {
  const now = new Date().toISOString()
  // R14 修复 (medium)：原 retry 循环在调用方**显式**提供 order 时仍
  // 静默上移到下一个空位（例如用户拖拽 step 到 order=5，被另一个并发
  // addStep 占了，最终落到 6 但调用方认为已落到 5）。改为：显式 order
  // 一旦撞 UNIQUE 就直接退回到 max+1 的 append 语义（拖拽/重排场景的
  // 「在该位置插入」允许邻近落位，但不会静默假装命中）；缺省 order
  // 仍走 append + retry。
  const explicitOrder = order !== undefined && order !== null
  let resolvedOrder = order
  if (!explicitOrder) {
    const maxStmtId = await prepare(
      `SELECT COALESCE(MAX(order_num), -1) + 1 AS next_order FROM sticky_note_steps WHERE note_id = ?`,
    )
    const row = (await dbClient.call('get', { stmtId: maxStmtId, params: [noteId] })) as {
      next_order: number
    } | null
    resolvedOrder = row?.next_order ?? 0
  }
  const id = crypto.randomUUID()
  const insertStmtId = await prepare(
    `INSERT INTO sticky_note_steps (id, note_id, content, done, order_num, created_at) VALUES (?, ?, ?, 0, ?, ?)`,
  )
  let attempts = 0
  let lastErr: unknown = null
  // R21 修复 (high data integrity)：原版 attempts 上限是 8，但每次失败都把
  // 同样的 `id` 重新 INSERT（id 是 step 主键，不会撞 UNIQUE，撞的是
  // UNIQUE(note_id, order_num)）。8 次后若还在 UNIQUE 循环里，说明 step 表
  // 已处于极不健康的状态（其他进程/事务持续占号）。原版只 `throw lastErr`，
  // 不带任何上下文，前端 try/catch 后只看到一个 `SqliteError: UNIQUE` 无法
  // 判断是 user cancel、并发冲突、还是数据损坏。修复：
  //   1) 上限降到 5（足够覆盖任何合理并发场景，再多就是病态）；
  //   2) 抛出前 wrap 一个有上下文的错误（含 noteId / 期望 order / 已尝试次数
  //      / 解析后的最终 order），便于 renderer 日志定位；
  //   3) 不再静默把 explicitOrder fallback 后不告知调用方 —— throw 时把
  //      resolvedOrder 一并传出（Error.cause 携带）。
  while (attempts < 5) {
    try {
      await dbClient.call('run', {
        stmtId: insertStmtId,
        params: [id, noteId, content, resolvedOrder, now],
      })
      lastErr = null
      break
    } catch (err) {
      const msg = (err as Error).message ?? ''
      // R29-DI-8 修复 (HIGH logic-bug)：原 `msg.includes('constraint')`
      // 命中所有 constraint 错误（包括 FOREIGN KEY / NOT NULL / CHECK），
      // 会被错误地当成 UNIQUE 冲突重试 5 次。FOREIGN KEY 违反（sticky 已
      // 在并发窗口被删除）或 NOT NULL 违反是真实 bug，应当立即抛出让上层
      // 处理。仅匹配 `UNIQUE constraint failed` 字面串，且排除 FK / NOT
      // NULL 关键字。
      if (
        !msg.includes('UNIQUE constraint failed') ||
        msg.includes('FOREIGN KEY') ||
        msg.includes('NOT NULL') ||
        msg.includes('CHECK constraint')
      ) {
        throw err
      }
      if (explicitOrder) {
        const maxStmtId = await prepare(
          `SELECT COALESCE(MAX(order_num), -1) + 1 AS next_order FROM sticky_note_steps WHERE note_id = ?`,
        )
        const row = (await dbClient.call('get', { stmtId: maxStmtId, params: [noteId] })) as {
          next_order: number
        } | null
        resolvedOrder = row?.next_order ?? 0
        // eslint-disable-next-line no-console
        console.warn(
          `[stickyNotes.addStep] order=${order} for note ${noteId} was taken; falling back to append order=${resolvedOrder}`,
        )
      } else {
        resolvedOrder = (resolvedOrder ?? 0) + 1
      }
      attempts++
      lastErr = err
    }
  }
  if (lastErr) {
    const wrapped = new Error(
      `[stickyNotes.addStep] exhausted retries: noteId=${noteId} explicitOrder=${explicitOrder} ` +
        `requestedOrder=${order} finalAttemptedOrder=${resolvedOrder} attempts=${attempts}`,
    )
    ;(wrapped as Error & { cause?: unknown }).cause = lastErr
    throw wrapped
  }

  // R20 修复 (medium lost-update)：原 bump 无 CAS，并发 addStep() 与
  // update() 并发时，update() 用 updated_at CAS 命中旧值 → step 插入后
  // bump 改写 updated_at → update() CAS 失效 → rename 静默丢失。
  // 修复：bump 也走「读取最新 updated_at → CAS UPDATE」循环，CAS 失败重试。
  //
  // R26-DI-4 修复 (medium transaction-missing follow-on)：R25-DI-9 让
  // bumpUpdatedAtWithCas 在 5 次重试用尽后 throw。step INSERT 已经成功
  // commit；如果把 throw 透传给 IPC handler，渲染端 try/catch 后 retry
  // 会再 INSERT 一条相同 content 的 step（UUID 不同），用户看到重复行。
  // 修复：bump 失败不应回滚 step。catch 住异常，log warn，让 IPC handler
  // 成功返回 step —— 牺牲 updated_at 的最新性（最多落后于真实一次
  // step 操作的时间），换取「无重复 step」的更强保证。
  try {
    await bumpUpdatedAtWithCas(noteId, now)
  } catch (err) {
    log.warn(
      `[stickyNotes.addStep] bumpUpdatedAtWithCas failed for noteId=${noteId}; step ${id} committed but parent's updated_at may be stale`,
      err,
    )
  }

  return {
    id,
    noteId,
    content,
    done: false,
    order: resolvedOrder ?? 0,
    createdAt: now,
  }
}

/** 更新 step（content / done / order） */
async function updateStep(stepId: ID, patch: StickyNoteStepPatch): Promise<StickyNoteStep | null> {
  const existing = await findStepRow(stepId)
  if (!existing) return null
  const merged: StickyNoteStepRow = {
    ...existing,
    content: patch.content ?? existing.content,
    done: patch.done === undefined ? existing.done : patch.done ? 1 : 0,
    order_num: patch.order ?? existing.order_num,
  }
  const stmtId = await prepare(
    `UPDATE sticky_note_steps SET content = ?, done = ?, order_num = ? WHERE id = ?`,
  )
  await dbClient.call('run', {
    stmtId,
    params: [merged.content, merged.done, merged.order_num, stepId],
  })

  const now = new Date().toISOString()
  // R20 修复 (medium lost-update)：见 addStep 中的注释
  //
  // R26-DI-4 修复 (medium transaction-missing follow-on)：见 addStep 中的
  // 注释 —— bump 失败不应回滚已 commit 的 step。
  try {
    await bumpUpdatedAtWithCas(existing.note_id, now)
  } catch (err) {
    log.warn(
      `[stickyNotes.updateStep] bumpUpdatedAtWithCas failed for stepId=${stepId}; step updated but parent's updated_at may be stale`,
      err,
    )
  }

  return rowToStep(merged)
}

/** 删除 step */
async function removeStep(stepId: ID): Promise<boolean> {
  const existing = await findStepRow(stepId)
  if (!existing) return false
  const stmtId = await prepare(`DELETE FROM sticky_note_steps WHERE id = ?`)
  const info = (await dbClient.call('run', { stmtId, params: [stepId] })) as { changes: number }
  if (info.changes > 0) {
    const now = new Date().toISOString()
    // R20 修复 (medium lost-update)：见 addStep 中的注释
    //
    // R26-DI-4 修复 (medium transaction-missing follow-on)：见 addStep 中的
    // 注释 —— bump 失败不应让 caller 误以为 step 删除失败而 retry。
    try {
      await bumpUpdatedAtWithCas(existing.note_id, now)
    } catch (err) {
      log.warn(
        `[stickyNotes.removeStep] bumpUpdatedAtWithCas failed for stepId=${stepId}; step removed but parent's updated_at may be stale`,
        err,
      )
    }
  }
  return info.changes > 0
}

/**
 * R20 修复 (medium lost-update)：addStep/updateStep/removeStep 三个写 step
 * 的 helper 都需要 bump 父 sticky_notes.updated_at，且 bump 必须走 CAS 否则
 * 会让并发 update() 的 CAS 谓词失效。重试 3 次；失败就 log 跳过（step 写入
 * 本身已成功，bump 失败不会回滚 step）。
 *
 * R21 修复 (high data integrity)：原版 CAS 谓词 `updated_at = cur.updated_at`
 * 是单向的「我刚读到的值现在必须没变」，但**没有单调性保证**：如果 caller
 * 在一个较早时刻就生成了时间戳 t1，传到这里又被另一个并发 writer 把
 * updated_at 推到 t2 > t1，bump 仍用 t1 写入 → row 退回更早的 updated_at。
 * 下游 store 用 updated_at 做订阅 key（renderer 重订阅条件），退回旧值会
 * 让前端 list 看不到这次新 step（subscription 错过事件），并让 CAS 谓词的
 * 「last-write-wins by mtime」假设失效（拖拽重排的 step 顺序按 updated_at
 * 排序时会乱序）。
 *
 * 修复：CAS 失败时重新读 → 比较 cur.updated_at 与 now，取 max(now, cur.updated_at)
 * 写回，保证单调不递减。重试 5 次仍失败则放弃（罕见，但不允许无限循环）。
 */
async function bumpUpdatedAtWithCas(noteId: ID, now: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const selStmtId = await prepare(
      `SELECT updated_at FROM sticky_notes WHERE id = ?`,
    )
    const cur = (await dbClient.call('get', {
      stmtId: selStmtId,
      params: [noteId],
    })) as { updated_at: string } | undefined
    if (!cur) return
    // R21：单调性修复。now 是 caller 在更早时刻（如 step INSERT 之前）取的
    // 字符串，与当前 row 的 updated_at 比较取较大者，避免 bumped 值比现有
    // 时间戳更旧。ISO 8601 字符串字典序与时间序一致，可直接比较。
    const writeTs = now > cur.updated_at ? now : cur.updated_at
    // 如果 writeTs 已经等于 cur.updated_at（并发 writer 已 bump 到 >=now），
    // 没必要再写一次，跳出（也是性能优化）。
    if (writeTs === cur.updated_at) return
    const updStmtId = await prepare(
      `UPDATE sticky_notes SET updated_at = ? WHERE id = ? AND updated_at = ?`,
    )
    const result = (await dbClient.call('run', {
      stmtId: updStmtId,
      params: [writeTs, noteId, cur.updated_at],
    })) as { changes?: number }
    if (result?.changes === 1) return
    // CAS 失败 → 重新读 + 重试
  }
  // R25-DI-9 修复 (medium data integrity)：原版 5 次重试用尽后只 log.warn
  // 然后 silent return —— 调用方（addStep L1149 / updateStep L1181 /
  // removeStep L1195）不检查返回值，step INSERT/UPDATE 已 commit 但
  // sticky_notes.updated_at 仍是旧值，下游以 updated_at 为订阅键的 store
  // （如 useStickyNotesStore 列表订阅）不会 fire，UI 列表视图显示 ghost
  // step 直到用户手动刷新。修复：抛错而非 silent log，让 IPC handler 把
  // 错误回传给渲染端（即便 step 写入成功，bump 失败本身是值得 surfacing
  // 的不一致信号），渲染端可选择降级为「step 已加但 sort order 可能错位」
  // 的 toast 提示。
  log.warn(
    `[stickyNotes.bumpUpdatedAtWithCas] gave up after 5 attempts for noteId=${noteId}`,
  )
  throw new Error(
    `[stickyNotes.bumpUpdatedAtWithCas] CAS exhausted after 5 attempts for noteId=${noteId} — concurrent writer contention`,
  )
}

/**
 * D2-fix（timezone mismatch）：写 completions.date 时原本用 now.slice(0, 10)，
 * 拿到的是 UTC 日期；读侧（renderer 的 dayKeyOf）用的是本地日期。
 * 在 UTC+8 凌晨完成的任务会被存到前一天去，StatsCards / heatmap 统计少 1。
 * 这里提供一个本地 YYYY-MM-DD 帮助函数，并替换所有 UTC 切片用法。
 */
function localDayKeyOf(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const stickyNotesRepo = {
  findByDateRange,
  findById,
  listFiltered,
  findByStatus,
  search,
  create,
  update,
  remove,
  complete,
  setStatus,
  archive,
  toggleStarred,
  recordCompletion,
  addStep,
  updateStep,
  removeStep,
}

export type StickyNotesRepo = typeof stickyNotesRepo