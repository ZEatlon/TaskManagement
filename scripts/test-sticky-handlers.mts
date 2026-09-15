/**
 * sticky-note-handlers.ts 的 IPC 信任边界 + 副作用收口单测 —— 不引第三方
 * runner，直接用 Node 内置的 ESM loader (scripts/test-loader.mjs) + node:test。
 *
 * 覆盖：
 *   1. R33-Corr-3 (high)：validateStickyInput 的 12 个守卫分支 ——
 *      5 个字节上限（title 500B / description 50_000B / steps 200 /
 *      step.content 2_000B / tags 100）+ 7 个 enum/format（priority /
 *      status / recurrence 白名单 / color ^#[0-9a-fA-F]{6}$ / date
 *      YYYY-MM-DD 真日历日 / scheduledAt ISO / dueAt ISO）。每条失败路径
 *      断言 IPC 抛错 + stickyNotesRepo 对应函数 NOT called。
 *   2. R33-Corr-4 / R34-Corr-1a/b (medium)：assertId(id, channel) ——
 *      10 条带 id 入参的通道（GET/DELETE/ADD_STEP/UPDATE_STEP/REMOVE_STEP
 *      /TOGGLE_STARRED/COMPLETE/SET_STATUS/ARCHIVE/RECORD_COMPLETION）
 *      对 null / undefined / number / empty / whitespace / object 全部
 *      抛 "id must be non-empty string"。COMPLETE 通道额外校验 date
 *      isValidDayKey（拒绝 '2025-02-30' / 非 YYYY-MM-DD）。
 *   3. R20 / R22 / R33-Corr-2 / R29-DI-9 (high)：ackPendingDue 条件
 *      ack 逻辑 —— complete 仅 result && result.status==='done' &&
 *      result.completedAt 才 ack（缺一不可）；setStatus 仅 args.status
 *      ∈ {done, cancelled} 且 result 真值且 result.status === args.status
 *      才 ack；archive 仅 args.archived === true 且 result 真值且
 *      result.archived === args.archived 才 ack。用 globalThis
 *      __test_ackPendingDueCalls 数组断言。
 *
 * 设计：
 *   - scripts/test-loader.mjs 把 sticky-note-handlers.ts 的依赖
 *     （./channels / ../db/repositories/stickyNotes /
 *      ../pomodoro/pomodoroService / ../notifications/notify）替换成
 *     in-memory stub。registerStickyNoteHandlers() 调用时所有 handler 被
 *     写到 globalThis.__test_ipcHandlers —— 测试按 channel 名取出，直接
 *     合成 IpcMainInvokeEvent 调用，断言返回值 + repo 副作用 + ackPendingDue
 *     调用计数。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== globalThis 注入 =====
//
// 注册前先清，避免上一次 run 残留（--test 进程内复用 module 缓存）。
;(globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers = {}
;(globalThis as { __test_stickyShCalls?: Record<string, unknown[]> }).__test_stickyShCalls = {}
;(globalThis as { __test_ackPendingDueCalls?: number[] }).__test_ackPendingDueCalls = []
;(globalThis as { __test_ackPendingDueCount?: number }).__test_ackPendingDueCount = 0
;(globalThis as { __test_invalidateStickyTitleCalls?: string[] }).__test_invalidateStickyTitleCalls = []

function getHandlers(): Record<string, (event: unknown, payload: unknown) => Promise<unknown>> {
  return (globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers ?? {}
}
function getShCalls(): Record<string, unknown[]> {
  return (globalThis as { __test_stickyShCalls?: Record<string, unknown[]> }).__test_stickyShCalls ?? {}
}
function getAckCalls(): number[] {
  return (globalThis as { __test_ackPendingDueCalls?: number[] }).__test_ackPendingDueCalls ?? []
}
function getInvalidateTitleCalls(): string[] {
  return (globalThis as { __test_invalidateStickyTitleCalls?: string[] }).__test_invalidateStickyTitleCalls ?? []
}

function resetAll(): void {
  ;(globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers = {}
  ;(globalThis as { __test_stickyShCalls?: Record<string, unknown[]> }).__test_stickyShCalls = {}
  ;(globalThis as { __test_ackPendingDueCalls?: number[] }).__test_ackPendingDueCalls = []
  ;(globalThis as { __test_ackPendingDueCount?: number }).__test_ackPendingDueCount = 0
  ;(globalThis as { __test_invalidateStickyTitleCalls?: string[] }).__test_invalidateStickyTitleCalls = []
  // reset all configurable return values
  delete (globalThis as Record<string, unknown>).__test_stickyCompleteReturn
  delete (globalThis as Record<string, unknown>).__test_stickySetStatusReturn
  delete (globalThis as Record<string, unknown>).__test_stickyArchiveReturn
  delete (globalThis as Record<string, unknown>).__test_stickyUpdateReturn
  delete (globalThis as Record<string, unknown>).__test_stickyRemoveReturn
  delete (globalThis as Record<string, unknown>).__test_stickyFindById
  delete (globalThis as Record<string, unknown>).__test_stickyCreateReturn
}

function calls(fnName: string): unknown[] {
  return getShCalls()[fnName] ?? []
}

// ===== 加载被测模块 =====

const handlers = await import('../src/main/ipc/sticky-note-handlers.ts')
handlers.registerStickyNoteHandlers()

const WC_ID = 1
const fakeEvent = () => ({ sender: { id: WC_ID } })

function getHandler(channel: string) {
  const h = getHandlers()[channel]
  assert.ok(typeof h === 'function', `handler for ${channel} must be registered`)
  return h as (event: unknown, payload: unknown) => Promise<unknown>
}

// ===== Tests: validateStickyInput 字节上限 =====
//
// 5 个分支：title 500B / description 50_000B / steps 200 /
// step.content 2_000B / tags 100。每条边界：N 通过 / N+1 拒绝。
// 失败路径断言：repo.create NOT called。

await test('validateStickyInput: title at 500B boundary accepted; at 501B rejected', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  // 500 ASCII chars = 500 bytes → pass
  const at500 = 'a'.repeat(500)
  await create(fakeEvent(), { title: at500, date: '2026-09-10', priority: 'p3', steps: [] })
  assert.equal(calls('create').length, 1, 'title=500B must reach repo.create')

  // 501 ASCII chars = 501 bytes → reject
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create2 = getHandler('sticky-note:create')
  const at501 = 'a'.repeat(501)
  await assert.rejects(
    () => create2(fakeEvent(), { title: at501, date: '2026-09-10', priority: 'p3', steps: [] }),
    /title exceeds 500 bytes/,
  )
  assert.equal(calls('create').length, 0, 'title=501B must not reach repo.create')
})

await test('validateStickyInput: description at 50_000B boundary accepted; at 50_001B rejected', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  const desc50000 = 'a'.repeat(50_000)
  await create(fakeEvent(), {
    title: 'ok',
    description: desc50000,
    date: '2026-09-10',
    priority: 'p3',
    steps: [],
  })
  assert.equal(calls('create').length, 1, 'description=50000B must reach repo.create')

  resetAll()
  handlers.registerStickyNoteHandlers()
  const create2 = getHandler('sticky-note:create')
  const desc50001 = 'a'.repeat(50_001)
  await assert.rejects(
    () => create2(fakeEvent(), {
      title: 'ok',
      description: desc50001,
      date: '2026-09-10',
      priority: 'p3',
      steps: [],
    }),
    /description exceeds 50000 bytes/,
  )
  assert.equal(calls('create').length, 0, 'description=50001B must not reach repo.create')
})

await test('validateStickyInput: steps array at 200 boundary accepted; at 201 rejected', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  const steps200 = Array.from({ length: 200 }, (_, i) => ({ content: `step-${i}` }))
  await create(fakeEvent(), { title: 'ok', date: '2026-09-10', priority: 'p3', steps: steps200 })
  assert.equal(calls('create').length, 1, 'steps=200 must reach repo.create')

  resetAll()
  handlers.registerStickyNoteHandlers()
  const create2 = getHandler('sticky-note:create')
  const steps201 = Array.from({ length: 201 }, (_, i) => ({ content: `step-${i}` }))
  await assert.rejects(
    () => create2(fakeEvent(), { title: 'ok', date: '2026-09-10', priority: 'p3', steps: steps201 }),
    /steps length exceeds 200/,
  )
  assert.equal(calls('create').length, 0, 'steps=201 must not reach repo.create')
})

await test('validateStickyInput: step.content at 2000B boundary accepted; at 2001B rejected', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  await create(fakeEvent(), {
    title: 'ok',
    date: '2026-09-10',
    priority: 'p3',
    steps: [{ content: 'a'.repeat(2000) }],
  })
  assert.equal(calls('create').length, 1, 'step.content=2000B must reach repo.create')

  resetAll()
  handlers.registerStickyNoteHandlers()
  const create2 = getHandler('sticky-note:create')
  await assert.rejects(
    () => create2(fakeEvent(), {
      title: 'ok',
      date: '2026-09-10',
      priority: 'p3',
      steps: [{ content: 'a'.repeat(2001) }],
    }),
    /step content must be string <= 2000 bytes/,
  )
  assert.equal(calls('create').length, 0, 'step.content=2001B must not reach repo.create')
})

await test('validateStickyInput: tags array at 100 boundary accepted; at 101 rejected', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  const tags100 = Array.from({ length: 100 }, (_, i) => `tag-${i}`)
  await create(fakeEvent(), {
    title: 'ok',
    date: '2026-09-10',
    priority: 'p3',
    steps: [],
    tags: tags100,
  })
  assert.equal(calls('create').length, 1, 'tags=100 must reach repo.create')

  resetAll()
  handlers.registerStickyNoteHandlers()
  const create2 = getHandler('sticky-note:create')
  const tags101 = Array.from({ length: 101 }, (_, i) => `tag-${i}`)
  await assert.rejects(
    () => create2(fakeEvent(), {
      title: 'ok',
      date: '2026-09-10',
      priority: 'p3',
      steps: [],
      tags: tags101,
    }),
    /tags must be array, length <= 100/,
  )
  assert.equal(calls('create').length, 0, 'tags=101 must not reach repo.create')
})

// ===== Tests: validateStickyInput enum/format =====

await test('validateStickyInput: priority whitelist enforced (p9 / weird rejected)', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  for (const bad of ['p9', 'weird', 'P1', '']) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await assert.rejects(
      () => h(fakeEvent(), { title: 'ok', date: '2026-09-10', priority: bad, steps: [] }),
      /priority must be one of/,
      `priority=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('create').length, 0)
  }
})

await test('validateStickyInput: status whitelist enforced', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  for (const bad of ['weird', 'TODO', 'Doing', '', 'archived']) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await assert.rejects(
      () => h(fakeEvent(), {
        title: 'ok',
        date: '2026-09-10',
        priority: 'p3',
        status: bad,
        steps: [],
      }),
      /status must be one of/,
      `status=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('create').length, 0)
  }
})

await test('validateStickyInput: recurrence whitelist enforced (hourly rejected)', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  for (const bad of ['hourly', 'yearly', 'biweekly', '']) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await assert.rejects(
      () => h(fakeEvent(), {
        title: 'ok',
        date: '2026-09-10',
        priority: 'p3',
        recurrence: bad,
        steps: [],
      }),
      /recurrence must be one of/,
      `recurrence=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('create').length, 0)
  }
})

await test('validateStickyInput: color hex format enforced', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  for (const bad of ['red', '#FFF', '#12345', '#GGGGGG', ' #AABBCC', 123]) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await assert.rejects(
      () => h(fakeEvent(), {
        title: 'ok',
        date: '2026-09-10',
        priority: 'p3',
        color: bad as unknown,
        steps: [],
      }),
      /color must match/,
      `color=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('create').length, 0)
  }
})

await test('validateStickyInput: date must be YYYY-MM-DD and real calendar date', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  for (const bad of ['2026-02-30', '2026-13-01', '2026-2-1', 'tomorrow', '20260201', 12345, null]) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await assert.rejects(
      () => h(fakeEvent(), {
        title: 'ok',
        date: bad as unknown,
        priority: 'p3',
        steps: [],
      }),
      /date must be YYYY-MM-DD/,
      `date=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('create').length, 0)
  }
})

await test('validateStickyInput: scheduledAt must be parseable ISO or null/empty', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  for (const bad of ['tomorrow', 'not-iso', 12345, {}]) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await assert.rejects(
      () => h(fakeEvent(), {
        title: 'ok',
        date: '2026-09-10',
        priority: 'p3',
        scheduledAt: bad as unknown,
        steps: [],
      }),
      /scheduledAt must be parseable ISO/,
      `scheduledAt=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('create').length, 0)
  }

  // null / undefined / 空串 / 合法 ISO 都该通过校验（repo 是否接受是另一回事）
  for (const ok of [null, undefined, '', '2026-09-10T10:00:00.000Z']) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await h(fakeEvent(), {
      title: 'ok',
      date: '2026-09-10',
      priority: 'p3',
      scheduledAt: ok as unknown,
      steps: [],
    })
    assert.equal(calls('create').length, 1, `scheduledAt=${JSON.stringify(ok)} must pass validation`)
  }
})

await test('validateStickyInput: dueAt must be parseable ISO or null/empty', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const create = getHandler('sticky-note:create')

  for (const bad of ['tomorrow', 'not-iso', 12345, {}]) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const h = getHandler('sticky-note:create')
    await assert.rejects(
      () => h(fakeEvent(), {
        title: 'ok',
        date: '2026-09-10',
        priority: 'p3',
        dueAt: bad as unknown,
        steps: [],
      }),
      /dueAt must be parseable ISO/,
      `dueAt=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('create').length, 0)
  }
})

await test('validateStickyInput: STICKY_NOTE_UPDATE patch is also validated (defense-in-depth)', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const update = getHandler('sticky-note:update')

  await assert.rejects(
    () => update(fakeEvent(), { id: 'x', patch: { priority: 'p9' } }),
    /priority must be one of/,
  )
  assert.equal(calls('update').length, 0, 'invalid UPDATE patch must not reach repo.update')

  // update also runs invalidateStickyTitle only AFTER validate passes
  assert.equal(getInvalidateTitleCalls().length, 0)
})

// ===== Tests: assertId =====
//
// 10 条带 id 入参的通道：GET/DELETE/ADD_STEP/UPDATE_STEP/REMOVE_STEP
// /TOGGLE_STARRED/COMPLETE/SET_STATUS/ARCHIVE/RECORD_COMPLETION
// bad id（null/undefined/number/empty/whitespace/object/array）→ 抛错 + repo NOT called。

const BAD_IDS = [
  ['null', null],
  ['undefined', undefined],
  ['number', 123],
  ['zero', 0],
  ['empty string', ''],
  ['whitespace', '   '],
  ['object', {}],
  ['array', []],
  ['boolean', true],
] as const

type IdArgSpec = {
  channel: string
  payload: unknown
  repoMethod: string
}

// 各通道的"有效"参数模板 —— id 部分会用 BAD_IDS 替换
const channelSpecs: IdArgSpec[] = [
  { channel: 'sticky-note:get', payload: 'valid-id', repoMethod: 'findById' },
  { channel: 'sticky-note:delete', payload: 'valid-id', repoMethod: 'remove' },
  {
    channel: 'sticky-note:add-step',
    payload: { noteId: 'valid-id', content: 'c' },
    repoMethod: 'addStep',
  },
  {
    channel: 'sticky-note:update-step',
    payload: { stepId: 'valid-id', patch: {} },
    repoMethod: 'updateStep',
  },
  { channel: 'sticky-note:remove-step', payload: 'valid-id', repoMethod: 'removeStep' },
  { channel: 'sticky-note:toggle-starred', payload: 'valid-id', repoMethod: 'toggleStarred' },
  { channel: 'sticky-note:complete', payload: { id: 'valid-id' }, repoMethod: 'complete' },
  {
    channel: 'sticky-note:set-status',
    payload: { id: 'valid-id', status: 'done' },
    repoMethod: 'setStatus',
  },
  {
    channel: 'sticky-note:archive',
    payload: { id: 'valid-id', archived: true },
    repoMethod: 'archive',
  },
  {
    channel: 'sticky-note:record-completion',
    payload: { id: 'valid-id', date: '2026-09-10' },
    repoMethod: 'recordCompletion',
  },
]

for (const spec of channelSpecs) {
  for (const [label, badId] of BAD_IDS) {
    await test(`assertId: ${spec.channel} rejects bad id (${label})`, async () => {
      resetAll()
      handlers.registerStickyNoteHandlers()
      const handler = getHandler(spec.channel)

      // 把 spec.payload 里出现的 'valid-id' 替换成 badId
      // payload 可能是 string 或 object{ id/noteId/stepId: string }
      let badPayload: unknown
      if (typeof spec.payload === 'string') {
        badPayload = badId
      } else {
        badPayload = JSON.parse(JSON.stringify(spec.payload), (_k, v) => {
          if (v === 'valid-id') return badId
          return v
        })
      }

      await assert.rejects(
        () => handler(fakeEvent(), badPayload),
        /id must be non-empty string/,
        `${spec.channel} with id=${label} must reject`,
      )
      assert.equal(
        calls(spec.repoMethod).length,
        0,
        `${spec.repoMethod} must not be called when id is invalid`,
      )
    })
  }
}

await test('assertId: valid id passes through to repo', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  const handler = getHandler('sticky-note:get')
  await handler(fakeEvent(), 'valid-id-123')
  assert.equal(calls('findById').length, 1)
})

// ===== Tests: STICKY_NOTE_COMPLETE date validation (R34-Corr-1b) =====

await test('STICKY_NOTE_COMPLETE: invalid date rejected; repo.complete NOT called', async () => {
  for (const bad of ['2025-02-30', '2026-13-01', 'not-a-date', 123, null, {}]) {
    resetAll()
    handlers.registerStickyNoteHandlers()
    const handler = getHandler('sticky-note:complete')
    await assert.rejects(
      () => handler(fakeEvent(), { id: 'valid-id', date: bad as unknown }),
      /complete date must be YYYY-MM-DD/,
      `date=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(calls('complete').length, 0)
    assert.equal(getAckCalls().length, 0, 'ackPendingDue must NOT be called when date is invalid')
  }
})

await test('STICKY_NOTE_COMPLETE: valid date passes; ack fires only on actual completion', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()

  // repo 返回 row 状态为 done + completedAt 真值 → ack 应该被调
  ;(globalThis as Record<string, unknown>).__test_stickyCompleteReturn = {
    id: 'valid-id',
    status: 'done',
    completedAt: '2026-09-10T10:00:00.000Z',
  }

  const handler = getHandler('sticky-note:complete')
  await handler(fakeEvent(), { id: 'valid-id', date: '2026-09-10' })
  assert.equal(calls('complete').length, 1)
  assert.equal(getAckCalls().length, 1, 'ack must fire when result is real completion')
})

// ===== Tests: ackPendingDue 条件守卫 =====
//
// (1) complete 仅当 result && result.status==='done' && result.completedAt 才 ack
// (2) setStatus 仅当 args.status ∈ {done,cancelled} && result 真值 && result.status === args.status 才 ack
// (3) archive 仅当 args.archived === true && result 真值 && result.archived === args.archived 才 ack

await test('ack: complete with null result → NOT acked', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyCompleteReturn = null
  await getHandler('sticky-note:complete')(fakeEvent(), { id: 'valid-id' })
  assert.equal(getAckCalls().length, 0, 'null result must not trigger ack')
})

await test('ack: complete with result.status !== "done" → NOT acked', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyCompleteReturn = {
    id: 'valid-id',
    status: 'todo',
    completedAt: null,
  }
  await getHandler('sticky-note:complete')(fakeEvent(), { id: 'valid-id' })
  assert.equal(getAckCalls().length, 0, 'status!=done must not trigger ack')
})

await test('ack: complete with missing completedAt → NOT acked', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyCompleteReturn = {
    id: 'valid-id',
    status: 'done',
    completedAt: null,
  }
  await getHandler('sticky-note:complete')(fakeEvent(), { id: 'valid-id' })
  assert.equal(getAckCalls().length, 0, 'completedAt null must not trigger ack')
})

await test('ack: complete idempotent (R29-DI-9 同一天幂等 → repo 返回 null) → NOT acked', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  // 同一天幂等调用：repo.complete 返回 null（与 stickyNotes.ts R33-Corr-1
  // 修复语义对齐 —— same-day early-return 让 IPC handler 跳过 ack）
  ;(globalThis as Record<string, unknown>).__test_stickyCompleteReturn = null
  const handler = getHandler('sticky-note:complete')
  await handler(fakeEvent(), { id: 'valid-id' })
  await handler(fakeEvent(), { id: 'valid-id' }) // 第二次同 row
  assert.equal(getAckCalls().length, 0, 'idempotent same-day complete must not ack twice')
})

await test('ack: complete natural new completion → ack fired once', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyCompleteReturn = {
    id: 'valid-id',
    status: 'done',
    completedAt: '2026-09-10T10:00:00.000Z',
  }
  await getHandler('sticky-note:complete')(fakeEvent(), { id: 'valid-id' })
  assert.equal(getAckCalls().length, 1)
})

// setStatus

await test('ack: setStatus null result → NOT acked', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickySetStatusReturn = null
  await getHandler('sticky-note:set-status')(fakeEvent(), { id: 'valid-id', status: 'done' })
  assert.equal(getAckCalls().length, 0)
})

await test('ack: setStatus result.status !== args.status → NOT acked', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickySetStatusReturn = {
    id: 'valid-id',
    status: 'todo',
  }
  await getHandler('sticky-note:set-status')(fakeEvent(), { id: 'valid-id', status: 'done' })
  assert.equal(getAckCalls().length, 0)
})

await test('ack: setStatus args.status === "in_progress" → NOT acked (not in done/cancelled set)', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickySetStatusReturn = {
    id: 'valid-id',
    status: 'in_progress',
  }
  await getHandler('sticky-note:set-status')(fakeEvent(), { id: 'valid-id', status: 'in_progress' })
  assert.equal(getAckCalls().length, 0, 'in_progress must not trigger ack')
})

await test('ack: setStatus args.status === "done" && result.status === "done" → ack fired', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickySetStatusReturn = {
    id: 'valid-id',
    status: 'done',
  }
  await getHandler('sticky-note:set-status')(fakeEvent(), { id: 'valid-id', status: 'done' })
  assert.equal(getAckCalls().length, 1)
})

await test('ack: setStatus args.status === "cancelled" && result.status === "cancelled" → ack fired', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickySetStatusReturn = {
    id: 'valid-id',
    status: 'cancelled',
  }
  await getHandler('sticky-note:set-status')(fakeEvent(), { id: 'valid-id', status: 'cancelled' })
  assert.equal(getAckCalls().length, 1)
})

// archive

await test('ack: archive null result → NOT acked', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyArchiveReturn = null
  await getHandler('sticky-note:archive')(fakeEvent(), { id: 'valid-id', archived: true })
  assert.equal(getAckCalls().length, 0)
})

await test('ack: archive result.archived !== args.archived → NOT acked (CAS miss / 状态没变)', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyArchiveReturn = {
    id: 'valid-id',
    archived: false, // CAS 重试耗尽 → row 状态没变 → handler 必须不 ack
  }
  await getHandler('sticky-note:archive')(fakeEvent(), { id: 'valid-id', archived: true })
  assert.equal(getAckCalls().length, 0)
})

await test('ack: archive args.archived === false → NOT acked (handler 守卫只在 archive=true 时 ack)', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyArchiveReturn = {
    id: 'valid-id',
    archived: false,
  }
  await getHandler('sticky-note:archive')(fakeEvent(), { id: 'valid-id', archived: false })
  assert.equal(getAckCalls().length, 0, 'unarchive must not ack')
})

await test('ack: archive args.archived === true && result.archived === true → ack fired', async () => {
  resetAll()
  handlers.registerStickyNoteHandlers()
  ;(globalThis as Record<string, unknown>).__test_stickyArchiveReturn = {
    id: 'valid-id',
    archived: true,
  }
  await getHandler('sticky-note:archive')(fakeEvent(), { id: 'valid-id', archived: true })
  assert.equal(getAckCalls().length, 1)
})
