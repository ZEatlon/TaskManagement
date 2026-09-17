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
import { priorityRankOf } from '@shared/lib/priorities'

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

  /**
   * R-fix-applyServerNote-bypass-wrapped-set (medium perf/correctness)：
   * 暴露一个走 wrapped set 的轻量 action，专供 StickyTimeline.applyServerNote
   * 这种「已知 byDate/all 已重算好」的跨域 patch 使用。直接调
   * `useStickyNotesStore.setState({...})` 会绕过 wrapped set，noteIdIndex
   * 不重建，下游 updateStep/addStep/removeStep/remove 的 lookupNoteById
   * 拿到陈旧 row（un-archive / 跨日 status 改动场景里 Map 与 byDate 视图
   * 永久失同步直到下一次非-applyServerNote 的 set 触发 wrapper）。
   * 走 wrapped set 后 syncNoteIdIndex 总会跑，Map 与 byDate 强一致。
   */
  patchByDateAndAll: (byDate: Record<string, StickyNote[]>, all: StickyNote[]) => void

  /** 派生：过滤现有 byDate + all 中的便签（前端二次过滤，不调 IPC） */
  listFiltered: (filter: {
    status?: StickyNote['status'] | StickyNote['status'][]
    priority?: StickyNote['priority'] | StickyNote['priority'][]
    starred?: boolean
    archived?: boolean
  }) => StickyNote[]

  reset: () => void
}

/** 为 byDate 建一张反向索引：noteId → 当前所在 dayKey。
 *  R36-fix-mergeByDate-reverse-index (high perf)：原版 mergeByDate 对每条
 *  incoming 便签都要线性扫所有桶定位旧桶（O(总桶数 × 桶内便签数) per note）。
 *  改用 Map<id, dayKey> 后单条定位 O(1)；incoming N 条便签总成本从
 *  O(N × 桶 × K) 降到 O(总便签 + N)。同时导出供 StickyTimeline 的
 *  applyServerNote 复用，避免重复建索引。
 *  不在 store state 上挂索引是为了保持 StickyNotesState 形状不变（向后兼容），
 *  调用方每次需要时临时建一次（≤ 600 notes 建 Map < 1ms）。 */
export function buildNoteDayIndex(
  byDate: Record<string, StickyNote[]>,
): Map<string, string> {
  const idx = new Map<string, string>()
  for (const dk of Object.keys(byDate)) {
    const arr = byDate[dk]
    if (!arr) continue
    for (const n of arr) idx.set(n.id, dk)
  }
  return idx
}

/** R39-fix-updateStep-postIPC-merge (high perf)：维护 noteId → 当前 StickyNote
 *  的反向索引，updateStep / addStep / removeStep / remove / update 在做
 *  post-IPC 合并或前置查找时改用 `noteIdIndex.get(id)` 直接 O(1) 拿到当前
 *  note，避免再走 `Object.values(byDate).flat().find()`（O(总桶 × 桶内 K)）。
 *  触发场景：500+ 便签库下连续勾选 checklist step，step toggle 链路每次要
 *  走 2~4 次该扫描，每次都新建临时数组 + GC 压力。
 *
 *  维护策略：每次 set() 后从最新的 byDate + all 重建索引（wrap set 在
 *  create() 边界，零侵入；rebuild 成本 O(N)，但每次调用方只重算一次，与原
 *  版"每次查找都 full-scan"对比是 N vs N×K 量级优化）。
 *
 *  R-fix-syncNoteIdIndex-microtask-defer (low perf)：原版每次 wrapped
 *  set 都同步跑 rebuild。M=500 + K=60 桶时每次 rebuild ≈ 560 Map ops、
 *  ~2-3ms，全部叠在 React render 同一帧里。改为：wrapped set 只置一个
 *  dirty flag 并排一个微任务；连续多次 set 在同一 tick 内只 rebuild 一
 *  次（最后状态胜出），且 rebuild 落在 render 提交之后的微任务队列里，
 *  不再阻塞同步 set → render 路径。
 *  安全性：所有 lookupNoteById 调用点都在 `await` 之后（IPC 回包才取
 *  当前 row），microtask 必然已在 await 间隙跑完，不存在「set 完立刻
 *  lookup 拿到陈旧 row」的场景。 */
const noteIdIndex = new Map<string, StickyNote>()
let noteIdIndexDirty = false

function syncNoteIdIndex(state: Pick<StickyNotesState, 'byDate' | 'all'>): void {
  noteIdIndex.clear()
  // byDate 与 all 都覆盖一遍：loadAllFiltered 只写 all、fetchRange 只写
  // byDate，两路独立；Map.set 后写覆盖，final 值取最后写入者（一般 all 更
  // 新，所以先写 all 再覆盖 byDate 让 byDate 中独有的 row 胜出）。
  for (const n of state.all) noteIdIndex.set(n.id, n)
  for (const list of Object.values(state.byDate)) {
    for (const n of list) noteIdIndex.set(n.id, n)
  }
}

function scheduleNoteIdIndexSync(get: () => StickyNotesState): void {
  if (noteIdIndexDirty) return
  noteIdIndexDirty = true
  queueMicrotask(() => {
    noteIdIndexDirty = false
    syncNoteIdIndex(get())
  })
}

/** 公开 O(1) note 查找 helper（取代 `Object.values(byDate).flat().find()`）。 */
export function lookupNoteById(id: string): StickyNote | undefined {
  return noteIdIndex.get(id)
}

/** 合并新加载的便签到现有 byDate（覆盖同 id 旧记录）
 *  R23 修复 (high correctness)：原版只往 n.date 桶里写，跨日期 move 时
 *  旧日期桶里同 id 的副本仍存在 → timeline 同一张便签渲染两次。
 *  修复：写入前先扫所有桶把同 id 的旧 entry 移除，再写到新桶。
 *  R36-fix (high perf)：用 buildNoteDayIndex 反向索引把「找旧桶」从 O(桶)
 *  降到 O(1)；fast path（同桶替换 / 新桶追加）不触发任何旧桶写入，避免
 *  60-bucket 窗口里 99% 的 incoming 都是同 day re-fetch 时大量空写。 */
function mergeByDate(
  current: Record<string, StickyNote[]>,
  incoming: StickyNote[],
): Record<string, StickyNote[]> {
  const next: Record<string, StickyNote[]> = {}
  for (const dk of Object.keys(current)) {
    next[dk] = current[dk]
  }
  const noteDay = buildNoteDayIndex(next)
  for (const n of incoming) {
    const newDate = n.date
    const curDate = noteDay.get(n.id)
    // Fast path：旧桶 == 新桶 → 仅做桶内按 id 替换 / 追加，零旧桶写入。
    if (curDate === newDate) {
      const arr = next[newDate] ?? []
      const i = arr.findIndex((x) => x.id === n.id)
      if (i >= 0) {
        if (arr[i] !== n) {
          const cloned = arr.slice()
          cloned[i] = n
          next[newDate] = cloned
        }
      } else {
        next[newDate] = [...arr, n]
        noteDay.set(n.id, newDate)
      }
      continue
    }
    // 跨日期 move：先从旧桶 O(1) 定位剔除（保持 R23 的跨日去重语义）
    if (curDate !== undefined) {
      const oldArr = next[curDate]
      if (oldArr) {
        const oi = oldArr.findIndex((x) => x.id === n.id)
        if (oi >= 0) {
          if (oldArr.length === 1) {
            // 桶只剩这一条，删除空桶（与原版语义一致）
            delete next[curDate]
          } else {
            const cloned = oldArr.slice()
            cloned.splice(oi, 1)
            next[curDate] = cloned
          }
        }
      }
    }
    // 再写入新桶
    const newArr = next[newDate] ?? []
    const ni = newArr.findIndex((x) => x.id === n.id)
    if (ni >= 0) {
      const cloned = newArr.slice()
      cloned[ni] = n
      next[newDate] = cloned
    } else {
      next[newDate] = [...newArr, n]
    }
    noteDay.set(n.id, newDate)
  }
  return next
}

function sortNotes(notes: StickyNote[]): StickyNote[] {
  // 按 priority (p0 > p1 > p2 > p3) 再按 created_at ASC 稳定排序
  // R36：内联 `{p0:0,p1:1,p2:2,p3:3}` 收敛到 @shared/lib/priorities，
  // 与 dashboard / timeline / widget 共用唯一权威源。
  return [...notes].sort((a, b) => {
    const po = priorityRankOf(a.priority) - priorityRankOf(b.priority)
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

/**
 * R31 helper (medium structure)：抽出 "byDate[id 桶] sort + all patchAll"
 * 的同步更新公共模板。之前每条乐观更新 / IPC 回写路径都要手抄 7 行
 * （capture byDate, patch entry by id, sortNotes, spread outer, patchAll）。
 * 任何漏写都会让 byDate 视图与派生 all 视图错位（R24-Corr-7 修过的洞）。
 * 本 helper 强制保证 byDate/all 一致性，未来加新 action（如 moveToFolder /
 * setRecurrence）只需一行 `set(applyNotePatch(get, next))`。
 *
 * 仅适用于「同 date 桶内按 id 替换」的写路径；跨日期 move / 纯 insert /
 * 纯 remove / 合并远端 snapshot 的分支（mergeByDate）不在覆盖范围内。
 */
function applyNotePatch(
  get: () => StickyNotesState,
  next: StickyNote,
): Pick<StickyNotesState, 'byDate' | 'all'> {
  const before = get()
  // R37-fix-medium (perf)：先 findIndex 校验 note 是否在目标桶内。
  // dashboard 端通过 loadAllFiltered 触发的 update / addStep / updateStep /
  // removeStep 经常拿到 date 不在当前 byDate 窗口里的便签 —— 旧逻辑仍会
  // 无条件 .map 重建桶（产出与原数组元素相同的新 ref）+ sortNotes 扫整桶。
  // 这些操作会让 StickyTimeline 的 filteredByDate useMemo 因 byDate 浅 ref
  // 变化重跑，即便 note 实际不在窗口里。修复：note 不在桶内 → 仅 patchAll，
  // byDate ref 完全不动；只有 note 本来就在桶内时才走 map + sortNotes。
  const bucket = before.byDate[next.date] ?? []
  const idx = bucket.findIndex((n) => n.id === next.id)
  return {
    byDate:
      idx >= 0
        ? {
            ...before.byDate,
            [next.date]: sortNotes(
              bucket.map((n) => (n.id === next.id ? next : n)),
            ),
          }
        : before.byDate,
    all: patchAll(before.all, next),
  }
}

/**
 * R-fix-update-rollback-concurrent-overwrite (MEDIUM concurrency)：
 * CAS 冲突回滚专用：保留比"无脑 rollback 到 snapshot"更保守的语义——
 * 当且仅当「没有任何其他 in-flight 写操作」时，把本次乐观 patch 从
 * byDate / all 中剥离（基于当前 state 减去本次 patch），其余并发已
 * merge 的状态一律保留。这避免：
 *   (a) 跨窗口并发 update：B 的成功 merge 被 A 的 rollback 误清
 *   (b) 同窗口连续 update：A 的 rollback 把 B 的乐观 patch 也清掉
 *
 * 实现细节：「从当前 state 找 optimistic.id 对应 row，替换为
 * snapshot 里的旧 row；如 snapshot 没有该 id 则从 all / bucket 删除」。
 * 这是 mirror-of-applyNotePatch 的反向 —— applyNotePatch 是把 bucket
 * 里的 oldRow 换成 newRow；本函数把 newRow 换回 snapshot 的 oldRow。
 */
function rollbackOptimisticByDate(
  snapshot: Record<string, StickyNote[]>,
  optimistic: StickyNote,
  cur: Record<string, StickyNote[]>,
): Record<string, StickyNote[]> {
  // 1) 在当前 byDate 里找 optimistic.id 所在桶 ——
  // 跨日期 move 时它可能在 optimistic.date（新桶）或某个旧桶里。
  let foundBucket = ''
  for (const [dk, list] of Object.entries(cur)) {
    if (list.some((n) => n.id === optimistic.id)) {
      foundBucket = dk
      break
    }
  }
  if (!foundBucket) {
    // 找不到乐观 entry，可能并发已把它整体替换。snapshot 是基准，
    // 不动即可。
    return cur
  }
  // 2) 在 snapshot 里找同一 id —— 这是回滚要还原到的「旧值」。
  //    跨日期 move 的特殊场景：optimistic.id 在 snapshot[oldDate] 而
  //    cur 中已跑到 optimistic.date 桶。这里我们能可靠复原的只有
  //    snapshot 里的状态；如果 snapshot 也没记录（极少见，e.g. update
  //    之前的 view 已不含此 note），则仅把该 row 从 cur 中删除。
  let restored: StickyNote | null = null
  for (const list of Object.values(snapshot)) {
    const found = list.find((n) => n.id === optimistic.id)
    if (found) {
      restored = found
      break
    }
  }
  if (restored) {
    const oldArr = cur[foundBucket] ?? []
    // 把乐观 entry 替换回 snapshot 的旧 entry；如果旧 entry 的 date 与
    // foundBucket 不同（跨日期 move 场景），仍保留当前 foundBucket 不动
    // —— 因为我们无法确定其他并发的 move 是否已把它再次迁走。
    const idx = oldArr.findIndex((n) => n.id === optimistic.id)
    if (idx >= 0) {
      const cloned = oldArr.slice()
      cloned[idx] = restored
      return { ...cur, [foundBucket]: cloned }
    }
    return cur
  }
  // snapshot 没记录 —— 从 cur 移除该 row（追加型乐观 patch 的回滚）
  const oldArr = cur[foundBucket] ?? []
  const filtered = oldArr.filter((n) => n.id !== optimistic.id)
  if (filtered.length === oldArr.length) return cur
  if (filtered.length === 0) {
    const next = { ...cur }
    delete next[foundBucket]
    return next
  }
  return { ...cur, [foundBucket]: filtered }
}

function rollbackOptimisticInAll(
  snapshotAll: StickyNote[],
  optimistic: StickyNote,
  curAll: StickyNote[],
): StickyNote[] {
  const idx = curAll.findIndex((n) => n.id === optimistic.id)
  if (idx < 0) return curAll
  // 优先用 snapshot 里的旧 row 还原；其次（snapshot 不含）直接删除
  const restored = snapshotAll.find((n) => n.id === optimistic.id) ?? null
  const cloned = curAll.slice()
  if (restored) {
    cloned[idx] = restored
  } else {
    cloned.splice(idx, 1)
  }
  return cloned
}

/**
 * R32-Corr-1 修复 (HIGH stale-fetch race on timeline rapid paging)：
 * 复用 notes.ts (line 105-114) 的 seq 守卫 + heatmap.ts (line 39-41) 的
 * 「互不冲突的 fetch 路径独立 seq」思路。
 *
 * 触发场景：用户在 StickyTimeline 上先滚动 9/1-9/7（IPC 1 发出），还没
 * 回来就又跳回 8/25-8/31（IPC 2 发出）。若 IPC 1 因 SQLite 慢查询晚到
 * 几百毫秒，它的 stale merged push 会把 IPC 2 已落地的窗口数据覆盖回去
 * （甚至含已被用户删除 / 勾掉的便签）→ lost-update：刚刚成功的删除被 undo。
 *
 * 每路 fetch 各自维护独立 seq：fetchRange 直调与 fetchAround 间接调用
 * 不共享同一计数器，否则 fetchAround 触发的 fetchRange bump 会顺手把
 * 直调的 fetchRange 也判 stale（与 heatmap 三路独立 seq 同思路）。
 */
let fetchRangeSeq = 0
let fetchAroundSeq = 0
let loadAllFilteredSeq = 0

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

export const useStickyNotesStore = create<StickyNotesState>((rawSet, get) => {
  // R39-fix-updateStep-postIPC-merge (high perf)：wrap set 让每次提交都同步
  // noteIdIndex，updateStep / addStep 等 post-IPC 合并可直接 lookupNoteById
  // 拿 O(1) 当前 note。set 签名与 zustand 兼容（partial 或 updater 函数）。
  // R-fix-syncNoteIdIndex-microtask-defer (low perf)：rebuild 改成 microtask
  // 异步执行，多个 set 在同 tick 内只跑一次最终 rebuild，不阻塞 set→render
  // 同步路径。
  const set: typeof rawSet = (((
    partial: Partial<StickyNotesState> | ((state: StickyNotesState) => Partial<StickyNotesState>),
    replace?: boolean,
  ) => {
    ;(rawSet as (p: unknown, r?: boolean) => void)(partial, replace)
    scheduleNoteIdIndexSync(get)
  }) as typeof rawSet)
  return {
  byDate: {},
  all: [],
  loading: false,
  error: null,
  rangeStart: '',
  rangeEnd: '',

  async fetchRange(startDate, endDate) {
    // R32-Corr-1：seq 守卫，回包时若 seq !== fetchRangeSeq 直接丢弃
    const seq = ++fetchRangeSeq
    set({ loading: true, error: null })
    try {
      const notes = await stickyNotesApi.list(startDate, endDate)
      if (seq !== fetchRangeSeq) return
      const sorted = sortNotes(notes)
      set({
        byDate: mergeByDate(get().byDate, sorted),
        rangeStart: startDate,
        rangeEnd: endDate,
        loading: false,
      })
    } catch (err) {
      if (seq !== fetchRangeSeq) return
      set({ error: (err as Error).message, loading: false })
    }
  },

  async fetchAround(anchor, beforeDays, afterDays) {
    // R32-Corr-1：fetchAround 自己独立的 seq 守卫（与 heatmap 同思路）：
    // 内部调用的 fetchRange 已经按 fetchRangeSeq 自身判 stale 丢弃，
    // 这里再在 fetchAround 边界确认本次 fetchAround 仍是最新调用。
    const seq = ++fetchAroundSeq
    const start = dayKeyOf(addDays(new Date(anchor), -beforeDays))
    const end = dayKeyOf(addDays(new Date(anchor), afterDays))
    await get().fetchRange(start, end)
    if (seq !== fetchAroundSeq) return
  },

  async loadAllFiltered(filter) {
    // R32-Corr-1：loadAllFiltered 独立 seq 守卫
    const seq = ++loadAllFilteredSeq
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
      // R32-Corr-1：回包时若已有更新的 loadAllFiltered 触发，直接丢弃
      if (seq !== loadAllFilteredSeq) return
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
      // R13 修复 (medium perf)：把 O(N*M) 的 beforeAll.find 换成 O(1) Map
      // 查找 —— M=2000 全量便签、N=200 IPC rows 时从 400,000 次比较降到 200 次。
      const localById = new Map(beforeAll.map((n) => [n.id, n]))
      const merged: StickyNote[] = []
      const seenIds = new Set<string>()
      for (const incoming of list) {
        seenIds.add(incoming.id)
        const local = localById.get(incoming.id)
        const inflight = inflightOps.get(incoming.id) ?? 0
        // R-Corr fix (high correctness)：之前这里还判了 `isStale(incoming.id, 0)`
        // （即 noteVersionOf(id) > 0）。但 endOp (line 211) 在 inflightOps 归零时
        // 会 noteVersion.delete(id)，IPC 返回时 noteVersion 已被清零 → 永远 false。
        // 这会让 inflight==0 且 endOp 已走的 IPC 回包走 merged.push(incoming) 分支，
        // 309-324 行的 field-level merge 永不执行 → 本地乐观更新被覆盖。
        // 修复：仅依赖 inflightOps 单一判定；保留 isStale 备用，但 caller 必须传
        // 真实的 capturedVersion 才有意义（loadAllFiltered 没有 caller 版本，传 0
        // 永远 false，所以这里直接删掉这一支）。
        if (local && inflight > 0) {
          // 还在飞行 → 保留本地 row，仅把 steps / priority /
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
      // store.all 里存在但 IPC list 不包含的 row（说明还在飞行）→ 补上；
      // 这里只保留「IPC 没返回过且 inflightOps > 0」的 row —— merged 已经
      // 覆盖了 seenIds 里的所有 id，留它们再过 filter 会与 merged 重复进入
      // finalAll，导致下游 widget（今日完成数 / 番茄数 / 归档数）双计入并
      // 渲染两张同 id 的卡。
      const filteredBeforeAll = beforeAll.filter(
        (n) => !seenIds.has(n.id) && (inflightOps.get(n.id) ?? 0) > 0,
      )
      const finalAll = sortNotes([...merged, ...filteredBeforeAll])
      set({ all: finalAll })
    } catch (err) {
      if (seq !== loadAllFilteredSeq) return
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
      // R-fix-loadAllFiltered-vs-create-race (MEDIUM concurrency)：
      // 用 beginOp(tempId) 标记占位为「在飞行中」，让并发触发的
      // loadAllFiltered 在合并时把 placeholder 视为 in-flight 而非直接
      // 丢弃。否则 IPC 返回恰好落在 create 完成之前会让 UI 短暂看不到
      // 这条便签（dashboard 卡闪烁）。
      beginOp(tempId)
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
        // R-fix-create-placeholder-leak (HIGH data-integrity)：原版直接
        // set(applyNotePatch(get, real))。applyNotePatch 内部按 id 找桶内
        // entry —— 但 placeholder 的 id 是 temp-xxx，real id 是新 UUID，桶
        // 内 idx === -1 → byDate 不动、patchAll 追加 real。结果 byDate
        // 留下 [placeholder, real] 两个同 date 的 entry，timeline 渲染
        // 两张卡，dashboard 的 all 同样双计入。修复：先把 tempId 从
        // byDate[input.date] 与 all 都移除，再调 applyNotePatch 让 real
        // 走标准的「同 id 替换」路径。
        const stateBefore = get()
        const bucket = stateBefore.byDate[input.date] ?? []
        const cleanedBucket =
          bucket.findIndex((n) => n.id === tempId) >= 0
            ? bucket.filter((n) => n.id !== tempId)
            : bucket
        const cleanedAll =
          stateBefore.all.findIndex((n) => n.id === tempId) >= 0
            ? stateBefore.all.filter((n) => n.id !== tempId)
            : stateBefore.all
        set({
          byDate:
            cleanedBucket.length === bucket.length
              ? stateBefore.byDate
              : { ...stateBefore.byDate, [input.date]: cleanedBucket },
          all: cleanedAll,
        })
        // 用真实记录替换占位 —— byDate 与 all 都要同步
        bumpNoteVersion(real.id)
        // R-fix-loadAllFiltered-vs-create-race：占位被 real 替换后
        // 把 inflightOps 计数器清零（endOp 会顺带 noteVersion.delete
        // 但 bumpNoteVersion 已写入 real.id 的 version 1，无需清）。
        endOp(tempId)
        set(applyNotePatch(get, real))
        // R8A-5：通知屏幕阅读器
        announce(`已创建便签 ${real.title}`)
        return real
      } catch (err) {
        // 回滚：byDate 与 all 都要移除占位
        // R-fix-loadAllFiltered-vs-create-race：失败路径必须也 endOp
        // 让 inflightOps 归零，否则该 tempId 永远挂在 Map 里占内存。
        endOp(tempId)
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
    // R39-fix-updateStep-postIPC-merge (high perf)：改用 module-level
    // noteIdIndex O(1) 查找，免去 Object.values(before).flat().find() 的
    // 临时数组分配 + 全桶扫描。
    const note = noteIdIndex.get(id)
    if (!note) {

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
      set(applyNotePatch(get, optimistic))
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

        console.warn(`[stickyNotes.update] CAS conflict for id=${id}; rolling back optimistic patch`)
        // R-fix-update-rollback-concurrent-overwrite (MEDIUM concurrency)：
        // 原版直接 `set({ byDate: before, all: beforeAll })` —— 但 `before`
        // 是 beginOp 前捕获的快照，若期间另一条 update 已成功合并（无论是
        // 跨窗口还是同窗口连续编辑），它们的乐观 patch + IPC merge 都会
        // 被本次回滚一刀切掉。把回滚语义改为「从当前状态扣掉本次乐观
        // patch」（仅清除本次 myVersion 引入的 entry 改动），其它 in-flight
        // 已 merge 的状态保留。
        noteVersion.delete(id)
        set({
          byDate: rollbackOptimisticByDate(before, optimistic, get().byDate),
          all: rollbackOptimisticInAll(beforeAll, optimistic, get().all),
          error: '保存冲突：便签已被其他窗口修改，请重试',
        })
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
    // R39-fix-updateStep-postIPC-merge (high perf)：改用 module-level
    // noteIdIndex O(1) 查找。
    const note = noteIdIndex.get(id)
    if (!note) {

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
    // R39-fix-updateStep-postIPC-merge (high perf)：改用 module-level
    // noteIdIndex O(1) 查找。
    const note = noteIdIndex.get(noteId)
    if (!note) {
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
    set(applyNotePatch(get, optimisticNote))
    try {
      const real = await stickyNotesApi.addStep(noteId, content)
      if (isStale(noteId, myVersion)) {
        endOp(noteId)
        return
      }
      // 用真实 step 替换临时
      // R39-fix-updateStep-postIPC-merge (high perf)：noteIdIndex O(1) 查找
      // 当前 note，免去 Object.values().flat().find() 全桶扫描。
      const cur = noteIdIndex.get(noteId) ?? note
      const nextNote = {
        ...cur,
        steps: (cur.steps).map((s) => (s.id === tempId ? real : s)),
      }
      set(applyNotePatch(get, nextNote))
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
    // R39-fix-updateStep-postIPC-merge (high perf)：改用 module-level
    // noteIdIndex O(1) 查找。
    const note = noteIdIndex.get(noteId)
    if (!note) {

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
    set(applyNotePatch(get, optimisticNote))

    try {
      const real = await stickyNotesApi.updateStep(stepId, patch)
      if (real && !isStale(noteId, myVersion)) {
        // R39-fix-updateStep-postIPC-merge (high perf)：noteIdIndex O(1) 查找
        // 当前 note，免去 Object.values().flat().find() 全桶扫描。
        const cur = noteIdIndex.get(noteId) ?? optimisticNote
        const nextNote: StickyNote = { ...cur, steps: cur.steps.map((s) => (s.id === stepId ? real : s)) }
        set(applyNotePatch(get, nextNote))
      }

      // 联动 status：单独调 IPC（H1 保持不变：done 走 complete，其它走 setStatus）
      if (statusChanged) {
        try {
          const updated = shouldCompleteViaApi
            ? await stickyNotesApi.complete(noteId)
            : await stickyNotesApi.setStatus(noteId, targetStatus)
          if (updated && !isStale(noteId, myVersion)) {
            // 用后端返回值刷新 status / completedAt / updatedAt
            set(applyNotePatch(get, updated))
          }
        } catch (statusErr) {
          // status 联动失败：仅回滚 status 字段，不回滚 step 本身
          // R39-fix-updateStep-postIPC-merge (high perf)：noteIdIndex O(1)。
          const cur = noteIdIndex.get(noteId) ?? optimisticNote
          const rolled: StickyNote = { ...cur, status: note.status, completedAt: note.completedAt }
          set(applyNotePatch(get, rolled))

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
    // R39-fix-updateStep-postIPC-merge (high perf)：改用 module-level
    // noteIdIndex O(1) 查找。
    const note = noteIdIndex.get(noteId)
    if (!note) {

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
    set(applyNotePatch(get, optimisticNote))
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

  patchByDateAndAll(byDate, all) {
    // R-fix-applyServerNote-bypass-wrapped-set (medium perf/correctness)：
    // 走 wrapped set 让 noteIdIndex 同步重建，外部 patch（典型：StickyTimeline
    // 的 applyServerNote post-IPC 合并）也能让后续 lookupNoteById 拿到当前 row。
    // 任意一次直接 setState({ all, byDate }) 都会让 Map 静默失同步。
    set({ byDate, all })
  },
  }
})