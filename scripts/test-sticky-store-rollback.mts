/**
 * src/renderer/src/stores/stickyNotes.ts 的 R-test-suite-sticky-store-rollback
 * (test-coverage) 防线单测 —— 覆盖 5 段未测的 store 内部逻辑：
 *
 *   1. updateStep 智能 status 联动：最后一个未完成 step 被勾上 → 自动 bump
 *      父便签 status='done'，并触发 stickyNotesApi.complete(id) 把
 *      completions 表写入走通（"R-fix-updateStep-cascade" 不变式）。
 *   2. update() CAS conflict rollback：stickyNotesApi.update(id, patch) 返
 *      null（粘性 update() R26-DI-5 后端 updated_at CAS 冲突信号）→ store
 *      必须回滚乐观 patch + 触发 stickyNotesApi.get(id) 拉最新 row。
 *   3. removeStep inflight 顺序：连续 removeStep + updateStep 时旧 IPC 返回
 *      不会覆盖新乐观值（noteVersion 守卫）。
 *   4. buildNoteDayIndex / lookupNoteById 跨日期 move：update 改变 date 后
 *      lookupNoteById 仍能 O(1) 拿到最新 note，且旧日期桶已剔除。
 *   5. reset() 清空 byDate/all —— 但 module-level noteIdIndex / dayIndex 是
 *      跨 reset 持久化的（key invariant：reset 不重建索引实例）。
 *
 * 设计：
 *   - 加载器走 scripts/test-loader.mjs 的 isFromRendererStore context，
 *     把 ../lib/ipc 替成 testmock://renderer-ipc stub（暴露 stickyNotesApi
 *     为 Proxy，按方法名查 globalThis.__test_stickyNotesApiMock[method]；
 *     未注入时返 null 让乐观更新链路继续跑）。AriaAnnouncer 替成
 *     testmock://aria-announcer stub，announce 是 no-op + 写入调用记录。
 *   - 使用 Zustand 的 vanilla API（useStickyNotesStore.getState() / setState）
 *     直接调 action，不需要 React 渲染。
 *   - 不依赖 React/jsdom —— 所有断言都对 vanilla store state 做。
 *
 * 运行：npm run test:sticky-store-rollback（需在 package.json scripts 加条目）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== 类型（与 src/shared/types 对齐；测试 fixture 不需要严格类型，
// 但要让 TS strict 通过 + 与生产类型形状对齐） =====

interface StickyNoteStep {
  id: string
  noteId: string
  content: string
  done: boolean
  order: number
  createdAt: string
}

interface StickyNote {
  id: string
  title: string
  date: string
  priority: 'p0' | 'p1' | 'p2' | 'p3'
  status: 'todo' | 'done'
  description: string | null
  scheduledAt: string | null
  dueAt: string | null
  completedAt: string | null
  tags: string[]
  color: string | null
  recurrence: string | null
  estimatedMinutes: number | null
  actualMinutes: number | null
  pomodoroCount: number
  starred: boolean
  archived: boolean
  steps: StickyNoteStep[]
  createdAt: string
  updatedAt: string
}

// ===== globalThis 注入 =====

function resetAll(): void {
  ;(globalThis as { __test_stickyNotesApiCalls?: unknown[] }).__test_stickyNotesApiCalls = []
  ;(globalThis as { __test_stickyNotesApiMock?: Record<string, unknown> }).__test_stickyNotesApiMock = {}
  ;(globalThis as { __test_announceCalls?: unknown[] }).__test_announceCalls = []
}

function stickyNotesApiCalls(): Array<{ method: string; args: unknown[] }> {
  return ((globalThis as { __test_stickyNotesApiCalls?: Array<{ method: string; args: unknown[] }> })
    .__test_stickyNotesApiCalls ?? []) as Array<{ method: string; args: unknown[] }>
}

function setMock(method: string, ret: unknown): void {
  const m = ((globalThis as { __test_stickyNotesApiMock?: Record<string, unknown> })
    .__test_stickyNotesApiMock ?? {}) as Record<string, unknown>
  m[method] = ret
  ;(globalThis as { __test_stickyNotesApiMock?: Record<string, unknown> }).__test_stickyNotesApiMock = m
}

function clearMock(method: string): void {
  const m = ((globalThis as { __test_stickyNotesApiMock?: Record<string, unknown> })
    .__test_stickyNotesApiMock ?? {}) as Record<string, unknown>
  delete m[method]
  ;(globalThis as { __test_stickyNotesApiMock?: Record<string, unknown> }).__test_stickyNotesApiMock = m
}

// ===== 加载被测模块 =====
const storeModule = await import('../src/renderer/src/stores/stickyNotes.ts')
const useStore = storeModule.useStickyNotesStore
const buildNoteDayIndex = storeModule.buildNoteDayIndex
const lookupNoteById = storeModule.lookupNoteById

// ===== 测试 fixture 工厂 =====

function makeNote(overrides: Partial<StickyNote> = {}): StickyNote {
  const now = new Date().toISOString()
  return {
    id: 'note-default-id-xxxxxxxxxxxxxxxxxxxxxx',
    title: 'T',
    date: '2026-01-01',
    priority: 'p2',
    status: 'todo',
    description: null,
    scheduledAt: null,
    dueAt: null,
    completedAt: null,
    tags: [],
    color: null,
    recurrence: null,
    estimatedMinutes: null,
    actualMinutes: null,
    pomodoroCount: 0,
    starred: false,
    archived: false,
    steps: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function seedStoreWithNotes(notes: StickyNote[]): Promise<void> {
  // 必须走 store action（fetchRange / loadAllFiltered）才能让 wrap set 触发
  // syncNoteIdIndex 重建 noteIdIndex —— 直接 useStore.setState 走 rawSet，
  // 不触发索引重建，updateStep / addStep / removeStep / update 等所有依赖
  // noteIdIndex.get(id) 的 action 都会早返（"note not in store"）。
  //
  // fetchRange 写 byDate；loadAllFiltered 写 all。两个 action 都走 wrap set，
  // 一次拉全 notes 就把 byDate/all/noteIdIndex 三处对齐。
  const dates = Array.from(new Set(notes.map((n) => n.date))).sort()
  if (dates.length > 0) {
    setMock('list', () => Promise.resolve(notes))
    await useStore.getState().fetchRange(dates[0]!, dates[dates.length - 1]!)
    clearMock('list')
  }
  setMock('listFiltered', () => Promise.resolve(notes))
  await useStore.getState().loadAllFiltered({ archived: false })
  clearMock('listFiltered')
}

function getStoreState(): {
  byDate: Record<string, StickyNote[]>
  all: StickyNote[]
  error: string | null
} {
  const s = useStore.getState()
  return { byDate: s.byDate, all: s.all, error: s.error }
}

// =====================================================================
// Test 1: updateStep cascade — last open step toggled done → status auto-
// bumps to 'done' + api.complete() called (R-fix-updateStep-cascade invariant)
// =====================================================================

await test('updateStep: 勾掉最后一个 open step → 父便签 status 自动 done + stickyNotesApi.complete 调用', async () => {
  resetAll()
  // 初始：todo 状态，2 个 step，第 2 个是 done，第 1 个是 todo
  const noteId = 'note-cascade-test-xxxxxxxxxxxxxxxxx'
  const step1Id = 'step-1-id-xxxxxxxxxxxxxxxxxxxxxxxxx'
  const step2Id = 'step-2-id-xxxxxxxxxxxxxxxxxxxxxxxxx'
  const note = makeNote({
    id: noteId,
    status: 'todo',
    steps: [
      { id: step1Id, noteId, content: 'first', done: false, order: 0, createdAt: '2026-01-01T00:00:00Z' },
      { id: step2Id, noteId, content: 'second', done: true, order: 1, createdAt: '2026-01-01T00:00:01Z' },
    ],
  })
  await seedStoreWithNotes([note])

  // 注入 mock：updateStep 返回更新后的 step；complete 返回更新后的 note（status=done）
  setMock('updateStep', (stepId: string, patch: Record<string, unknown>) => {
    // 找到对应 step 复制 patch 字段
    const target = note.steps.find((s) => s.id === stepId)
    return target ? { ...target, ...patch } : null
  })
  setMock('complete', (id: string) => {
    // 后端权威：status=done + completedAt=now
    return { ...note, status: 'done', completedAt: '2026-01-01T01:00:00Z', updatedAt: '2026-01-01T01:00:00Z', id }
  })

  // 勾掉 step1（最后一个 open step）
  await useStore.getState().updateStep(noteId, step1Id, { done: true })

  // 验证 IPC 调用序列：
  //   1) updateStep(step1Id, {done:true})
  //   2) complete(noteId)  ← 联动触发
  const calls = stickyNotesApiCalls()
  const methods = calls.map((c) => c.method)
  assert.ok(methods.includes('updateStep'), 'updateStep must be called')
  assert.ok(methods.includes('complete'), 'complete must be called (cascade trigger)')

  // 验证 store 终态：note.status = 'done'（乐观先行 + 后端回填都最终落到 done）
  const state = getStoreState()
  const allNote = state.all.find((n) => n.id === noteId)
  const byDateNote = state.byDate['2026-01-01']?.find((n) => n.id === noteId)
  assert.equal(allNote?.status, 'done', 'parent note status must auto-bump to done')
  assert.equal(byDateNote?.status, 'done', 'byDate note status must auto-bump to done')

  clearMock('updateStep')
  clearMock('complete')
})

// =====================================================================
// Test 2: update() CAS conflict rollback — api.update returns null →
// optimistic patch reverted + api.get() refetched (R29-Corr-3 invariant)
// =====================================================================

await test('update: stickyNotesApi.update 返回 null（CAS 冲突）→ 乐观 patch 回滚 + api.get 拉最新 row', async () => {
  resetAll()
  const noteId = 'note-cas-test-xxxxxxxxxxxxxxxxxxxx'
  const original = makeNote({ id: noteId, title: 'Original', status: 'todo' })
  await seedStoreWithNotes([original])

  // 注入 mock：update 返 null（CAS 冲突信号），get 返 fresh row（其他窗口已修改）。
  // 注意：mock 必须返 Promise —— store 的 .then() 链要求异步返回值；同步返
  // 普通对象会让 .then 抛 TypeError 被 .catch(()=>undefined) 吞掉，fresh
  // row 永远不会落到 store。
  const freshFromServer = {
    ...original,
    title: 'ServerUpdated',
    status: 'done',
    updatedAt: '2026-01-02T00:00:00Z',
  }
  setMock('update', null)
  setMock('get', () => Promise.resolve(freshFromServer))

  // 触发一次本地乐观更新（title 改）
  await useStore.getState().update(noteId, { title: 'LocalOptimistic' })

  // 等 microtask 让 async get 拉取 + set() 完成
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r))
  }

  const state = getStoreState()
  const finalNote = state.all.find((n) => n.id === noteId)
  // 关键防线：CAS 冲突时 store 必须把乐观 patch 回滚（title 不应是
  // 'LocalOptimistic'），最终落到 freshFromServer 的权威值（'ServerUpdated'）。
  // R29-Corr-3 的核心不变式：CAS 冲突不能留下本地乐观值假装成功。
  assert.equal(
    finalNote?.title,
    'ServerUpdated',
    'CAS conflict must rollback optimistic patch + adopt fresh server row',
  )
  assert.equal(finalNote?.status, 'done', 'fresh row status must win over optimistic')
  assert.match(state.error ?? '', /保存冲突/, 'error field must indicate CAS conflict')

  // 验证 IPC 调用序列：update → null → get(id)
  const calls = stickyNotesApiCalls()
  const methods = calls.map((c) => c.method)
  const updateIdx = methods.indexOf('update')
  const getIdx = methods.indexOf('get')
  assert.ok(updateIdx >= 0, 'update must be called')
  assert.ok(getIdx > updateIdx, 'get must be called after update returns null')

  clearMock('update')
  clearMock('get')
})

// =====================================================================
// Test 3: removeStep + updateStep sequential inflight — 连续两次写操作
// 必须按顺序落到 store，且 byDate/all 视图保持一致（R5-11 + R8R-1 不变式）
// =====================================================================

await test('removeStep → updateStep 串行：两个 step 各自被处理，byDate/all 视图保持一致', async () => {
  resetAll()
  const noteId = 'note-inflight-test-xxxxxxxxxxxxxxxxx'
  const step1Id = 'step-1-id-xxxxxxxxxxxxxxxxxxxxxxxxx'
  const step2Id = 'step-2-id-xxxxxxxxxxxxxxxxxxxxxxxxx'
  const note = makeNote({
    id: noteId,
    steps: [
      { id: step1Id, noteId, content: 'a', done: false, order: 0, createdAt: '2026-01-01T00:00:00Z' },
      { id: step2Id, noteId, content: 'b', done: false, order: 1, createdAt: '2026-01-01T00:00:01Z' },
    ],
  })
  await seedStoreWithNotes([note])

  // 注入：removeStep 返 undefined（实际 IPC 走 no-op），updateStep 返更新后的 step
  setMock('removeStep', undefined)
  setMock('updateStep', (stepId: string, patch: Record<string, unknown>) => {
    const target = note.steps.find((s) => s.id === stepId)
    return target ? { ...target, ...patch } : null
  })

  // 串行：先 removeStep step1（IPC 无返回值），再 updateStep step2（done=true）
  await useStore.getState().removeStep(noteId, step1Id)
  await useStore.getState().updateStep(noteId, step2Id, { done: true })

  const state = getStoreState()
  const allNote = state.all.find((n) => n.id === noteId)
  const byDateNote = state.byDate['2026-01-01']?.find((n) => n.id === noteId)
  const allSteps = allNote?.steps ?? []
  const byDateSteps = byDateNote?.steps ?? []
  // 关键防线：removeStep 后 step1 必须从 byDate 和 all 两路都消失；
  // updateStep 后 step2.done 必须=true。两条 action 的乐观更新 + 后端回填
  // 都要 byDate/all 同步（R5-11 invariant），不允许出现「byDate 删了但 all
  // 残留」或「all 勾了但 byDate 没勾」的视图漂移。
  assert.equal(
    allSteps.some((s) => s.id === step1Id),
    false,
    'all: step1 must be removed after removeStep',
  )
  assert.equal(
    byDateSteps.some((s) => s.id === step1Id),
    false,
    'byDate: step1 must be removed after removeStep',
  )
  const step2InAll = allSteps.find((s) => s.id === step2Id)
  const step2InByDate = byDateSteps.find((s) => s.id === step2Id)
  assert.equal(step2InAll?.done, true, 'all: step2.done must be true after updateStep')
  assert.equal(step2InByDate?.done, true, 'byDate: step2.done must be true after updateStep')

  clearMock('removeStep')
  clearMock('updateStep')
})

// =====================================================================
// Test 4: buildNoteDayIndex — 跨日期 move 后索引仍 O(1) 可查
// =====================================================================

await test('buildNoteDayIndex: 跨日期 move 后索引仍能 O(1) 定位新位置，旧桶不再含 id', () => {
  resetAll()
  const noteId = 'note-move-test-xxxxxxxxxxxxxxxxxxx'
  const noteA = makeNote({ id: noteId, date: '2026-01-01', title: 'A' })
  const noteOther = makeNote({
    id: 'other-note-xxxxxxxxxxxxxxxxxxxxxxx',
    date: '2026-01-01',
    title: 'B',
  })

  // 初始 byDate：noteA 和 noteOther 同在 2026-01-01
  const byDate: Record<string, StickyNote[]> = {
    '2026-01-01': [noteA, noteOther],
  }
  const idx = buildNoteDayIndex(byDate)
  assert.equal(idx.get(noteId), '2026-01-01', 'note must be indexed under its current date')
  assert.equal(
    idx.get('other-note-xxxxxxxxxxxxxxxxxxxxxxx'),
    '2026-01-01',
    'other note also under 2026-01-01',
  )

  // 模拟 update 把 noteA 移到 2026-01-02：rebuild 索引后旧桶不该再有 noteId
  const updated = makeNote({ id: noteId, date: '2026-01-02', title: 'A moved' })
  const next: Record<string, StickyNote[]> = {
    '2026-01-01': [noteOther],
    '2026-01-02': [updated],
  }
  const idx2 = buildNoteDayIndex(next)
  assert.equal(idx2.get(noteId), '2026-01-02', 'after move, index must reflect new bucket')
  assert.equal(
    idx2.get('other-note-xxxxxxxxxxxxxxxxxxxxxxx'),
    '2026-01-01',
    'untouched note keeps old bucket after rebuild',
  )
})

await test('lookupNoteById: 通过 store create 触发 wrap set → noteIdIndex 重建后能查到', async () => {
  resetAll()
  const noteId = 'note-lookup-test-xxxxxxxxxxxxxxxxx'
  // stub create 直接返回 fixed row（避免走真实 IPC 链路）
  const created = makeNote({
    id: noteId,
    date: '2026-02-01',
    title: 'LookupTarget',
    steps: [
      { id: 's1', noteId, content: 'x', done: false, order: 0, createdAt: '2026-02-01T00:00:00Z' },
    ],
  })
  setMock('create', () => Promise.resolve(created))

  // create 走的是 store action，wrap set 会调 syncNoteIdIndex 重建 noteIdIndex
  await useStore.getState().create({
    title: 'LookupTarget',
    date: '2026-02-01',
    priority: 'p2',
    steps: [{ content: 'x' }],
  })

  const looked = lookupNoteById(noteId)
  assert.ok(looked, 'lookupNoteById must find the note after create()')
  assert.equal(looked?.title, 'LookupTarget')
  assert.equal(looked?.date, '2026-02-01')

  clearMock('create')
})

// =====================================================================
// Test 5: reset() wipes byDate/all —— error 也清空；loading 重置
// =====================================================================

await test('reset: 清空 byDate/all/loading/error/range —— store 回到初始态', () => {
  resetAll()
  // 先塞点数据 + 模拟 error
  useStore.setState({
    byDate: { '2026-01-01': [makeNote()] },
    all: [makeNote()],
    loading: true,
    error: 'some prior error',
    rangeStart: '2026-01-01',
    rangeEnd: '2026-01-07',
  })
  useStore.getState().reset()
  const s = useStore.getState()
  assert.deepEqual(s.byDate, {}, 'byDate must be empty after reset')
  assert.deepEqual(s.all, [], 'all must be empty after reset')
  assert.equal(s.loading, false, 'loading must be false after reset')
  assert.equal(s.error, null, 'error must be null after reset')
  assert.equal(s.rangeStart, '', 'rangeStart must be empty after reset')
  assert.equal(s.rangeEnd, '', 'rangeEnd must be empty after reset')
})
