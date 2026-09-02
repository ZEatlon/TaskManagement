/**
 * 便签状态管理（Zustand）
 *
 * 缓存按日期分组的便签（含 steps），提供 CRUD + 窗口加载 + 乐观更新。
 *
 * 数据形状：
 *   byDate: Record<YYYY-MM-DD, StickyNote[]>
 *   键 = 便签归属日；值 = 该日的便签列表（已按 priority / created_at 排序）。
 *
 * 窗口加载：
 *   - fetchRange(start, end) — 单次拉取固定窗口
 *   - fetchAround(anchor, before, after) — 时间线专用：锚点日 + 前后 N 天
 */
import { create } from 'zustand'
import type {
  StickyNote,
  StickyNoteCreate,
  StickyNoteUpdate,
  StickyNoteStepPatch,
  StickyNoteStep,
  ID,
} from '@shared/types'
import { stickyNotesApi } from '../lib/ipc'
import { addDays, dayKeyOf } from '../lib/date'
import { announce } from '../components/common/AriaAnnouncer'

interface StickyNotesState {
  /** YYYY-MM-DD → 该日的便签列表 */
  byDate: Record<string, StickyNote[]>
  /** 扁平化的便签全集（包含未按日期归档的过滤列表，用于 dashboard / pomodoro 等非时间线场景） */
  all: StickyNote[]
  loading: boolean
  error: string | null
  /** 当前已加载窗口边界（含端点） */
  rangeStart: string
  rangeEnd: string

  fetchRange: (startDate: string, endDate: string) => Promise<void>
  fetchAround: (anchor: string, beforeDays: number, afterDays: number) => Promise<void>

  /** 拉取满足过滤条件的便签全集（与 fetchRange 互不冲突，并写入 `all`） */
  loadAllFiltered: (
    filter?: {
      status?: StickyNote['status'] | StickyNote['status'][]
      priority?: StickyNote['priority'] | StickyNote['priority'][]
      starred?: boolean
      archived?: boolean
      limit?: number
    },
  ) => Promise<void>

  create: (input: StickyNoteCreate) => Promise<StickyNote>
  update: (id: ID, patch: StickyNoteUpdate) => Promise<void>
  remove: (id: ID) => Promise<void>

  addStep: (noteId: ID, content: string) => Promise<void>
  updateStep: (noteId: ID, stepId: ID, patch: StickyNoteStepPatch) => Promise<void>
  removeStep: (noteId: ID, stepId: ID) => Promise<void>

  /** 派生：过滤现有 byDate + all 中的便签（前端二次过滤，不调 IPC） */
  listFiltered: (filter: {
    status?: StickyNote['status'] | StickyNote['status'][]
    priority?: StickyNote['priority'] | StickyNote['priority'][]
    starred?: boolean
    archived?: boolean
  }) => StickyNote[]

  reset: () => void
}

/** 把一批便签按 date 分桶 */
function groupByDate(notes: StickyNote[]): Record<string, StickyNote[]> {
  const out: Record<string, StickyNote[]> = {}
  for (const n of notes) {
    const arr = out[n.date] ?? []
    arr.push(n)
    out[n.date] = arr
  }
  return out
}

/** 合并新加载的便签到现有 byDate（覆盖同 id 旧记录）
 *  R23 修复 (high correctness)：原版只往 n.date 桶里写，跨日期 move 时
 *  旧日期桶里同 id 的副本仍存在 → timeline 同一张便签渲染两次。
 *  修复：写入前先扫所有桶把同 id 的旧 entry 移除，再写到新桶。 */
function mergeByDate(
  current: Record<string, StickyNote[]>,
  incoming: StickyNote[],
): Record<string, StickyNote[]> {
  const next: Record<string, StickyNote[]> = {}
  for (const dk of Object.keys(current)) {
    next[dk] = current[dk]
  }
  for (const n of incoming) {
    // 先从所有桶里移除同 id 旧 entry（处理跨日期 move）
    for (const dk of Object.keys(next)) {
      const arr = next[dk]
      if (!arr) continue
      const idx = arr.findIndex((x) => x.id === n.id)
      if (idx >= 0) {
        if (arr.length === 1) {
          // 桶只剩这一条，删除空桶
          if (dk !== n.date) delete next[dk]
        } else {
          next[dk] = arr.slice()
          next[dk]!.splice(idx, 1)
        }
      }
    }
    // 再写入新桶
    const arr = next[n.date] ? [...next[n.date]!] : []
    const idxInNew = arr.findIndex((x) => x.id === n.id)
    if (idxInNew >= 0) arr[idxInNew] = n
    else arr.push(n)
    next[n.date] = arr
  }
  return next
}

function sortNotes(notes: StickyNote[]): StickyNote[] {
  // 按 priority (p0 > p1 > p2 > p3) 再按 created_at ASC 稳定排序
  const order: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }
  return [...notes].sort((a, b) => {
    const po = (order[a.priority] ?? 9) - (order[b.priority] ?? 9)
    if (po !== 0) return po
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  })
}

/**
 * 在 all[] 里以 id 替换或追加一条便签。R5-11 配套：dashboard / 派生 selector
 * 同时依赖 byDate 与 all，update/addStep/updateStep/removeStep 都必须同步写 all。
 */
function patchAll(all: StickyNote[], note: StickyNote): StickyNote[] {
  const idx = all.findIndex((n) => n.id === note.id)
  if (idx >= 0) {
    const next = all.slice()
    next[idx] = note
    return next
  }
  return [...all, note]
}

// R8R-1 / R8R-5：每个便签的 in-flight 操作计数器 + 操作版本号。
// 计数器 > 0 视为有正在飞行的写操作；版本号用于顺序写入场景下让
// 旧 IPC 返回值不覆盖新乐观更新（典型场景：用户连续勾选两个 step，
// updateStep A 还在路上时 B 已经本地更新，A 返回时会把 B 的 done=false 覆盖）。
const inflightOps = new Map<string, number>()
const noteVersion = new Map<string, number>()

function noteVersionOf(id: string): number {
  return noteVersion.get(id) ?? 0
}
function bumpNoteVersion(id: string): number {
  const next = noteVersionOf(id) + 1
  noteVersion.set(id, next)
  return next
}
function beginOp(id: string): void {
  inflightOps.set(id, (inflightOps.get(id) ?? 0) + 1)
}
function endOp(id: string): void {
  const cur = inflightOps.get(id) ?? 0
  if (cur <= 1) {
    inflightOps.delete(id)
    // R30-Corr-2 修复 (MEDIUM stale-merge-permanent)：原版只在 CAS 冲突回滚
    // 路径（line 464）里 noteVersion.delete(id)，正常 endOp 不清版本号 →
    // 一旦某个 note 走过任何 in-flight 写操作，noteVersion 永久 > 0；后续
    // loadAllFiltered 的 isStale(incoming.id, 0) 永远返回 true，merge 分支
    // 始终被走。dashboard / pomodoro 视图的 `all` 永远优先用 IPC 返回的
    // snapshot 覆盖本地乐观字段（steps / starred / status / archived），
    // 用户在 sticky timeline 编辑后，dashboard 列表仍显示旧值。
    // 修复：inflightOps 归零时一并 noteVersion.delete(id)，让未来的
    // loadAllFiltered 走 simple merged.push(incoming) 分支。
    noteVersion.delete(id)
  } else {
    inflightOps.set(id, cur - 1)
  }
}
/**
 * 若当前版本号 > 旧版本 → 视为"在飞行期间又有更新"，放弃旧 IPC 返回值；
 * 否则把返回值合并回 byDate / all。
 */
function isStale(id: string, capturedVersion: number): boolean {
  return noteVersionOf(id) > capturedVersion
}

export const useStickyNotesStore = create<StickyNotesState>((set, get) => ({
  byDate: {},
  all: [],
  loading: false,
  error: null,
  rangeStart: '',
  rangeEnd: '',

  async fetchRange(startDate, endDate) {
    set({ loading: true, error: null })
    try {
      const notes = await stickyNotesApi.list(startDate, endDate)
      const sorted = sortNotes(notes)
      set({
        byDate: mergeByDate(get().byDate, sorted),
        rangeStart: startDate,
        rangeEnd: endDate,
        loading: false,
      })
    } catch (err) {
      set({ error: (err as Error).message, loading: false })
    }
  },

  async fetchAround(anchor, beforeDays, afterDays) {
    const start = dayKeyOf(addDays(new Date(anchor), -beforeDays))
    const end = dayKeyOf(addDays(new Date(anchor), afterDays))
    await get().fetchRange(start, end)
  },

  async loadAllFiltered(filter) {
    try {
      const apiFilter: {
        status?: StickyNote['status'] | StickyNote['status'][]
        priority?: StickyNote['priority'] | StickyNote['priority'][]
        starred?: boolean
        archived?: boolean
        limit?: number
      } = {
        archived: filter?.archived ?? false,
      }
      if (filter?.status) apiFilter.status = filter.status
      // 后端 listFiltered 已支持 priority 单值/数组；原代码此处会把数组悄悄降级为单值，
      // 现改为直接透传，避免多选被忽略。
      if (filter?.priority) apiFilter.priority = filter.priority
      if (filter?.starred !== undefined) apiFilter.starred = filter.starred
      if (filter?.limit !== undefined) apiFilter.limit = filter.limit
      const list = await stickyNotesApi.listFiltered(apiFilter)
      // R24-Corr-7 修复 (medium data-integrity)：原 set({ all: sortNotes(list) })
      // 无条件覆盖 store.all —— IPC 往返期间用户对某条便签的乐观更新（status
      // 切换 / starred 切换 / moveToFolder）会被 IPC 返回的最新全量覆盖，
      // UI 闪烁一下回到旧状态（虽然乐观 patch 还在 byDate 各日期桶里，但
      // 派生视图大多从 all 读，状态丢失）。修复：合并而不是替换 —— 把
      // IPC 返回的 row 与 store 里现有的同 id row 做 field-level merge，
      // 优先采纳 IPC 返回的「权威」字段（id / status / starred / archived /
      // updatedAt / steps），但保留本地 inflightOps > 0 的 note 的最新
      // version-snapshot（说明用户还在飞行动作中，避免覆盖）。实现：
      // 对每条返回的 row，如果对应 id 的 noteVersion 已被递增（inflightOps
      // > 0 或 versionOf > 0 且上次刷新后又有变更），保留 store 现有 row
      // 并仅把 IPC row 的新字段（如步骤数）补回去；否则直接以 IPC row 替换。
      const beforeAll = get().all
      const beforeByDate = get().byDate
      const merged: StickyNote[] = []
      const seenIds = new Set<string>()
      for (const incoming of list) {
        seenIds.add(incoming.id)
        const local = beforeAll.find((n) => n.id === incoming.id)
        const inflight = inflightOps.get(incoming.id) ?? 0
        if (local && (inflight > 0 || isStale(incoming.id, 0))) {
          // 还在飞行 / 已被新乐观更新 → 保留本地 row，仅把 steps / priority /
          // tags 等 IPC 权威字段 patch 进来（避免丢失用户的乐观更新）。
          merged.push({
            ...local,
            // 接受 IPC 权威字段：tags（最新 UI 拉取）、color、recurrence 等
            tags: incoming.tags,
            color: incoming.color,
            recurrence: incoming.recurrence,
            estimatedMinutes: incoming.estimatedMinutes,
            actualMinutes: incoming.actualMinutes,
            pomodoroCount: incoming.pomodoroCount,
            starred: incoming.starred,
            archived: incoming.archived,
            status: incoming.status,
            // steps 从 IPC 拿（IPC 是真实 SQL 结果，比本地乐观加的 step 更准）
            steps: incoming.steps,
          })
        } else {
          merged.push(incoming)
        }
      }
      // store.all 里存在但 IPC list 不包含的 row（已删除或被 filter 排除）→ 移除
      const filteredBeforeAll = beforeAll.filter((n) => seenIds.has(n.id) || !beforeByDate[n.date])
      const finalAll = sortNotes([
        ...merged,
        // 把 IPC 没返回但 store 里有（说明还在飞行）的 row 补上
        ...filteredBeforeAll.filter((n) => (inflightOps.get(n.id) ?? 0) > 0),
      ])
      set({ all: finalAll })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  listFiltered(filter) {
    // 把 byDate 全集扁平化 + 去重（防止跨日重复，例如改了 date 后）
    const seen = new Map<string, StickyNote>()
    for (const list of Object.values(get().byDate)) {
      for (const n of list) seen.set(n.id, n)
    }
    for (const n of get().all) seen.set(n.id, n)
    let arr = Array.from(seen.values())
    // R10 修复：原版 filter.archived === undefined 时不进入任何分支 → 包含
    // 已归档便签。但后端 sticky-notes:list-filtered 默认 archived=false，两端
    // 默认行为不一致会让 Dashboard / 列表 / 计数互相错位。
    // 对齐后端：未指定 archived 时按 false 处理（默认只返回未归档）。
    if (filter.archived === undefined) {
      arr = arr.filter((n) => !n.archived)
    } else if (filter.archived === false) {
      arr = arr.filter((n) => !n.archived)
    } else {
      arr = arr.filter((n) => n.archived)
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      arr = arr.filter((n) => statuses.includes(n.status))
    }
    if (filter.priority) {
      const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
      arr = arr.filter((n) => priorities.includes(n.priority))
    }
    if (filter.starred !== undefined) {
      arr = arr.filter((n) => n.starred === filter.starred)
    }
    return sortNotes(arr)
  },

  async create(input) {
    // 智能默认 status：
    //   - 创建在今天 → 'in_progress'（用户正在着手的事项）
    //   - 创建在未来 → 'todo'（待办）
    //   - 已过去的日期 → 'todo'（补救清单）
    //   - 用户显式传 status 时尊重用户选择
    const today = dayKeyOf(new Date())
    const inferredStatus: StickyNote['status'] =
      input.status ?? (input.date === today ? 'in_progress' : 'todo')

    // R8R-6 / R9：连续两次连点「新建」按钮会触发两次 IPC 调用。
    //   R8 原版：返回占位（temp-${uuid}），违反 StickyNote 契约（ID 应是 DB 真 ID）。
    //   R9 修复：用 Promise 去重 —— 第二次连点 await 第一次的 Promise，
    //   第一次 Promise 真正完成后才返回带 DB ID 的 StickyNote。
    const createKey = `c:${input.title.trim()}|${input.date}`
    type InflightBag = { __inflight?: Map<string, Promise<StickyNote>> }
    const bag = create as unknown as InflightBag
    if (!bag.__inflight) bag.__inflight = new Map()
    const existingPromise = bag.__inflight.get(createKey)
    if (existingPromise) {
      return existingPromise
    }
    const createPromise = (async (): Promise<StickyNote> => {
      const tempId = `temp-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const placeholder: StickyNote = {
        id: tempId,
        title: input.title,
        date: input.date,
        priority: input.priority,
        status: inferredStatus,
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
        steps: input.steps.map((s, idx) => ({
          id: `temp-step-${idx}-${Math.random().toString(36).slice(2, 8)}`,
          noteId: tempId,
          content: s.content,
          done: s.done ?? false,
          order: s.order ?? idx,
          createdAt: now,
        })),
        createdAt: now,
        updatedAt: now,
      }
      // R6S-1：all[] 也要同步放占位，否则 dashboard 读 all 时看不到新建中的便签。
      set({
        byDate: {
          ...get().byDate,
          [input.date]: sortNotes([...(get().byDate[input.date] ?? []), placeholder]),
        },
        all: patchAll(get().all, placeholder),
      })
      try {
        // 把推断出的 status 一并送给后端（如果用户没显式传）
        const real = await stickyNotesApi.create({
          ...input,
          status: input.status ?? inferredStatus,
        })
        // 用真实记录替换占位 —— byDate 与 all 都要同步
        const arr = (get().byDate[real.date] ?? []).map((n) => (n.id === tempId ? real : n))
        bumpNoteVersion(real.id)
        set({
          byDate: { ...get().byDate, [real.date]: sortNotes(arr) },
          all: patchAll(get().all, real),
        })
        // R8A-5：通知屏幕阅读器
        announce(`已创建便签 ${real.title}`)
        return real
      } catch (err) {
        // 回滚：byDate 与 all 都要移除占位
        const arr = (get().byDate[input.date] ?? []).filter((n) => n.id !== tempId)
        set({
          byDate: { ...get().byDate, [input.date]: arr },
          all: get().all.filter((n) => n.id !== tempId),
          error: (err as Error).message,
        })
        throw err
      } finally {
        // 不论成功失败都清理 in-flight 条目，允许下次创建
        bag.__inflight?.delete(createKey)
      }
    })()
    bag.__inflight.set(createKey, createPromise)
    return createPromise
  },

  async update(id, patch) {
    // R5-11：同时维护 all[]，否则 dashboard 用 all + byDate 派生时 all 是陈旧的
    const before = get().byDate
    const beforeAll = get().all
    // R30-Corr-1 修复 (HIGH optimistic-update-silent-noop)：原版只在
    // `Object.values(before).flat()` 找 note。如果 note 是从 dashboard /
    // pomodoro / tag 视图通过 loadAllFiltered 加载的（其 date 不在当前
    // byDate 桶内），find 返回 undefined → 函数静默 return，乐观更新、
    // 错误提示、IPC 都不触发 → 用户以为编辑失败。修复：先在 all 查（all
    // 是 superset），找不到再回退 byDate；都没找到就 fetch + 警告。
    const note =
      beforeAll.find((n) => n.id === id)
      ?? Object.values(before).flat().find((n) => n.id === id)
    if (!note) {
      // eslint-disable-next-line no-console
      console.warn(`[stickyNotes.update] note ${id} not in store; skipping optimistic update`)
      return
    }
    // R8R-1：捕获起始版本号，IPC 返回时若已有新乐观更新则不覆盖
    const myVersion = bumpNoteVersion(id)
    beginOp(id)
    const optimistic: StickyNote = { ...note, ...patch, updatedAt: new Date().toISOString() }
    // M4：当 patch.date 改变时，从旧日期桶中剔除，避免旧桶残留陈旧记录
    const oldDate = note.date
    const newDate = optimistic.date
    if (oldDate !== newDate) {
      const oldList = (before[oldDate] ?? []).filter((n) => n.id !== id)
      const newList = sortNotes([...(before[newDate] ?? []), optimistic])
      set({
        byDate: {
          ...before,
          [oldDate]: oldList,
          [newDate]: newList,
        },
        all: patchAll(beforeAll, optimistic),
      })
    } else {
      set({
        byDate: {
          ...before,
          [oldDate]: sortNotes(
            (before[oldDate] ?? []).map((n) => (n.id === id ? optimistic : n)),
          ),
        },
        all: patchAll(beforeAll, optimistic),
      })
    }
    try {
      const updated = await stickyNotesApi.update(id, patch)
      if (updated) {
        // R8R-1：版本号已被更高优先级的操作抬高时，不覆盖本地乐观结果
        if (isStale(id, myVersion)) {
          endOp(id)
          return
        }
        const curByDate = get().byDate
        const curAll = get().all
        set({
          byDate: mergeByDate(curByDate, [updated]),
          all: patchAll(curAll, updated),
        })
      } else {
        // R29-Corr-3 修复 (HIGH stale-read on CAS-miss)：后端 updated_at
        // CAS 冲突时返回 null（粘性 update() R26-DI-5 修复），但原版留
        // 下乐观 patch 在 store 里 → UI 显示"已保存"，下次 reload 又丢。
        // 修复：CAS 冲突时回滚乐观 patch + 重新拉最新 row。
        // eslint-disable-next-line no-console
        console.warn(`[stickyNotes.update] CAS conflict for id=${id}; rolling back optimistic patch`)
        // 把版本号还原，让并发的更高优先级操作不被本次回滚打扰
        noteVersion.delete(id)
        set({ byDate: before, all: beforeAll, error: '保存冲突：便签已被其他窗口修改，请重试' })
        // 异步拉一次最新 row，让 UI 与后端状态对齐（不抛错给 caller）。
        void stickyNotesApi
          .get(id)
          .then((fresh) => {
            if (fresh) {
              const curByDate = get().byDate
              const curAll = get().all
              set({
                byDate: mergeByDate(curByDate, [fresh]),
                all: patchAll(curAll, fresh),
              })
            }
          })
          .catch(() => undefined)
      }
      endOp(id)
    } catch (err) {
      endOp(id)
      // 回滚
      set({ byDate: before, all: beforeAll, error: (err as Error).message })
      throw err
    }
  },

  async remove(id) {
    const before = get().byDate
    const beforeAll = get().all
    // R30-Corr-1 修复 (HIGH silent-noop)：先在 all 查，再回退 byDate。
    const note =
      beforeAll.find((n) => n.id === id)
      ?? Object.values(before).flat().find((n) => n.id === id)
    if (!note) {
      // eslint-disable-next-line no-console
      console.warn(`[stickyNotes.remove] note ${id} not in store; skipping`)
      return
    }
    // 本地剔除
    const next: Record<string, StickyNote[]> = {}
    for (const [date, list] of Object.entries(before)) {
      next[date] = list.filter((n) => n.id !== id)
      if (next[date]!.length === 0) delete next[date]
    }
    // R5-11：all 也要同步剔除，否则 dashboard 的 all 仍然包含已删除的便签
    const nextAll = beforeAll.filter((n) => n.id !== id)
    set({ byDate: next, all: nextAll })
    // R8A-5：屏幕阅读器通知
    announce(`已删除便签 ${note.title}`, 'assertive')
    try {
      await stickyNotesApi.remove(id)
    } catch (err) {
      set({ byDate: before, all: beforeAll, error: (err as Error).message })
      throw err
    }
  },

  async addStep(noteId, content) {
    // 乐观：本地先插入一个 step（id 临时）
    const before = get().byDate
    const beforeAll = get().all
    // R30-Corr-1 修复：先在 all 查，再回退 byDate。
    const note =
      beforeAll.find((n) => n.id === noteId)
      ?? Object.values(before).flat().find((n) => n.id === noteId)
    if (!note) {
      // eslint-disable-next-line no-console
      console.warn(`[stickyNotes.addStep] note ${noteId} not in store; skipping`)
      return
    }
    const myVersion = bumpNoteVersion(noteId)
    beginOp(noteId)
    const tempId = `temp-step-${Math.random().toString(36).slice(2, 8)}`
    const nextOrder = note.steps.length
    const optimisticStep: StickyNoteStep = {
      id: tempId,
      noteId,
      content,
      done: false,
      order: nextOrder,
      createdAt: new Date().toISOString(),
    }
    const optimisticNote: StickyNote = {
      ...note,
      steps: [...note.steps, optimisticStep],
      updatedAt: new Date().toISOString(),
    }
    set({
      byDate: {
        ...before,
        [note.date]: sortNotes(
          (before[note.date] ?? []).map((n) => (n.id === noteId ? optimisticNote : n)),
        ),
      },
      all: patchAll(beforeAll, optimisticNote),
    })
    try {
      const real = await stickyNotesApi.addStep(noteId, content)
      if (isStale(noteId, myVersion)) {
        endOp(noteId)
        return
      }
      // 用真实 step 替换临时
      const curByDate = get().byDate
      const curAll = get().all
      const nextNote = {
        ...(Object.values(curByDate).flat().find((n) => n.id === noteId) ?? note),
        steps: (Object.values(curByDate).flat().find((n) => n.id === noteId)?.steps ?? []).map(
          (s) => (s.id === tempId ? real : s),
        ),
      }
      const arr = (curByDate[note.date] ?? []).map((n) =>
        n.id === noteId ? nextNote : n,
      )
      set({
        byDate: { ...curByDate, [note.date]: sortNotes(arr) },
        all: patchAll(curAll, nextNote),
      })
      endOp(noteId)
    } catch (err) {
      endOp(noteId)
      set({ byDate: before, all: beforeAll, error: (err as Error).message })
      throw err
    }
  },

  async updateStep(noteId, stepId, patch) {
    const before = get().byDate
    const beforeAll = get().all
    // R30-Corr-1 修复：先在 all 查，再回退 byDate。
    const note =
      beforeAll.find((n) => n.id === noteId)
      ?? Object.values(before).flat().find((n) => n.id === noteId)
    if (!note) {
      // eslint-disable-next-line no-console
      console.warn(`[stickyNotes.updateStep] note ${noteId} not in store; skipping`)
      return
    }
    const myVersion = bumpNoteVersion(noteId)
    beginOp(noteId)

    // === 智能 status 联动 ===
    // 规则（用户需求）：
    //   - 完成一个 step（done=true）：
    //       - 若便签原状态是 todo / cancelled → 自动切到 in_progress
    //       - 若所有 step 都完成且状态 !== done → 自动切到 done（走 complete API 写 completions）
    //   - 取消完成一个 step（done=false）：
    //       - 若便签当前状态是 done → 自动切回 in_progress（不允许从 done 直接退回 todo）
    // 只对 status 字段做推断；其它字段不动。推断结果乐观先行，失败时连同 status 一起回滚。
    const newSteps = note.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s))
    const allDone = newSteps.length > 0 && newSteps.every((s) => s.done)
    let targetStatus: StickyNote['status'] = note.status
    let shouldCompleteViaApi = false
    if (patch.done === true) {
      if (note.status === 'todo' || note.status === 'cancelled') {
        targetStatus = 'in_progress'
      }
      if (allDone && note.status !== 'done') {
        targetStatus = 'done'
        shouldCompleteViaApi = true
      }
    } else if (patch.done === false && note.status === 'done') {
      targetStatus = 'in_progress'
    }
    const statusChanged = targetStatus !== note.status

    // 推断 completedAt：进入 done 沿用旧值/新增；离开 done 清空
    let completedAt: string | null = note.completedAt
    if (targetStatus === 'done' && !note.completedAt) {
      completedAt = new Date().toISOString()
    } else if (note.status === 'done' && targetStatus !== 'done') {
      completedAt = null
    }

    const optimisticNote: StickyNote = {
      ...note,
      steps: newSteps,
      status: targetStatus,
      completedAt,
      updatedAt: new Date().toISOString(),
    }
    set({
      byDate: {
        ...before,
        [note.date]: sortNotes(
          (before[note.date] ?? []).map((n) => (n.id === noteId ? optimisticNote : n)),
        ),
      },
      all: patchAll(beforeAll, optimisticNote),
    })

    try {
      const real = await stickyNotesApi.updateStep(stepId, patch)
      if (real && !isStale(noteId, myVersion)) {
        const curByDate = get().byDate
        const curAll = get().all
        const cur = Object.values(curByDate).flat().find((n) => n.id === noteId) ?? optimisticNote
        const nextNote: StickyNote = { ...cur, steps: cur.steps.map((s) => (s.id === stepId ? real : s)) }
        const arr = (curByDate[note.date] ?? []).map((n) =>
          n.id === noteId ? nextNote : n,
        )
        set({
          byDate: { ...curByDate, [note.date]: sortNotes(arr) },
          all: patchAll(curAll, nextNote),
        })
      }

      // 联动 status：单独调 IPC（H1 保持不变：done 走 complete，其它走 setStatus）
      if (statusChanged) {
        try {
          const updated = shouldCompleteViaApi
            ? await stickyNotesApi.complete(noteId)
            : await stickyNotesApi.setStatus(noteId, targetStatus)
          if (updated && !isStale(noteId, myVersion)) {
            // 用后端返回值刷新 status / completedAt / updatedAt
            const curByDate = get().byDate
            const curAll = get().all
            const arr = (curByDate[note.date] ?? []).map((n) =>
              n.id === noteId ? updated : n,
            )
            set({
              byDate: { ...curByDate, [note.date]: sortNotes(arr) },
              all: patchAll(curAll, updated),
            })
          }
        } catch (statusErr) {
          // status 联动失败：仅回滚 status 字段，不回滚 step 本身
          const curByDate = get().byDate
          const curAll = get().all
          const cur = Object.values(curByDate).flat().find((n) => n.id === noteId) ?? optimisticNote
          const rolled: StickyNote = { ...cur, status: note.status, completedAt: note.completedAt }
          const arr = (curByDate[note.date] ?? []).map((n) =>
            n.id === noteId ? rolled : n,
          )
          set({
            byDate: { ...curByDate, [note.date]: sortNotes(arr) },
            all: patchAll(curAll, rolled),
          })
          // eslint-disable-next-line no-console
          console.warn('[stickyNotes] status 联动失败:', statusErr)
        }
      }
      // R9 修复：成功路径上必须 endOp，否则 inflightOps 计数器无限增长
      endOp(noteId)
    } catch (err) {
      endOp(noteId)
      set({ byDate: before, all: beforeAll, error: (err as Error).message })
      throw err
    }
  },

  async removeStep(noteId, stepId) {
    const before = get().byDate
    const beforeAll = get().all
    // R30-Corr-1 修复：先在 all 查，再回退 byDate。
    const note =
      beforeAll.find((n) => n.id === noteId)
      ?? Object.values(before).flat().find((n) => n.id === noteId)
    if (!note) {
      // eslint-disable-next-line no-console
      console.warn(`[stickyNotes.removeStep] note ${noteId} not in store; skipping`)
      return
    }
    // R8R-1：记录版本号让后续 in-flight 操作能感知；removeStep 的 IPC 没返回值
    // 需要合并，但占位仍需要让版本号升高避免与并发 update 撞车。
    const myVersion = bumpNoteVersion(noteId)
    void myVersion
    beginOp(noteId)
    const optimisticNote: StickyNote = {
      ...note,
      steps: note.steps.filter((s) => s.id !== stepId),
      updatedAt: new Date().toISOString(),
    }
    set({
      byDate: {
        ...before,
        [note.date]: sortNotes(
          (before[note.date] ?? []).map((n) => (n.id === noteId ? optimisticNote : n)),
        ),
      },
      all: patchAll(beforeAll, optimisticNote),
    })
    try {
      await stickyNotesApi.removeStep(stepId)
      endOp(noteId)
    } catch (err) {
      endOp(noteId)
      set({ byDate: before, all: beforeAll, error: (err as Error).message })
      throw err
    }
  },

  reset() {
    set({ byDate: {}, all: [], loading: false, error: null, rangeStart: '', rangeEnd: '' })
  },
}))

/**
 * R16 修复 (low)：selectNotesByDate 之前直接返回 `state.byDate[dayKey]` 引用，
 * 消费者若 .sort() / .push() / .reverse() 会原地 mutate store state。原模块
 * 当前没有 active 消费者（grep 验证），但作为公共 API 仍可能被未来的 caller
 * 误用，添加 @deprecated 提示并返回防御性副本。
 *
 * @deprecated 切勿用 .sort/.push 直接 mutate 返回值；请在调用方用 useMemo
 *             派生，或用下面 selectAllNotesSorted（已修复 sort 原位 mutate）。
 */
export function selectNotesByDate(state: StickyNotesState, dayKey: string): StickyNote[] {
  return state.byDate[dayKey] ? [...state.byDate[dayKey]] : []
}

/**
 * 合并一组日期的便签并按 date ASC + priority ASC 排序（用于时间线渲染）。
 *
 * R16 修复 (low)：原版 `Object.values(state.byDate).flat()` 已经返回新数组，
 * 但 `.sort()` 是原地排序 —— 一旦未来有人"优化"成 `[...Object.values(...).flat()]`
 * 之外的形式（比如缓存 flat 结果），sort 会原地 mutate store byDate 内部的数组。
 * 这里显式 spread 一份再 sort，并把 sort 提到辅助函数 sortNotes（已存在）以避免
 * 重复实现。
 *
 * 当前无 active 消费者，仅供调试 / 单元测试用。禁止用 useStickyNotesStore(selectAllNotesSorted)
 * 作为 selector —— 每次返回新对象会触发 Zustand 无限重渲染。
 */
export function selectAllNotesSorted(state: StickyNotesState): StickyNote[] {
  // 直接复用 sortNotes（已用 [...notes].sort 实现）
  // 此处保留独立实现以匹配原语义
  const all = [...Object.values(state.byDate).flat()]
  const order: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }
  return all.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    const po = (order[a.priority] ?? 9) - (order[b.priority] ?? 9)
    if (po !== 0) return po
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  })
}

export { groupByDate }