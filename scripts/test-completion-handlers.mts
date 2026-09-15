/**
 * src/main/ipc/completion-handlers.ts 的 IPC 信任边界 + R40 防线单测
 *
 * 覆盖：
 *   1. R40 (medium completion-record-id-unvalidated) ——
 *      completion:record / note-event:record handler 层的 assertUuidId
 *      守卫。非空 string + RFC 4122 UUID 才放行；number / 空串 / 路径穿
 *      越 / 对象 / 含 NUL 字符的 string 全部抛错 + repo NOT called。
 *   2. R40 DAY_KEY_RE ——
 *      date 字段必须命中 /^\d{4}-\d{2}-\d{2}$/，否则抛错。覆盖
 *      '2025-02-30' / '2026-13-01' / 'tomorrow' / 非字符串类型。
 *   3. R40 ALLOWED_NOTE_EVENT_TYPES ——
 *      note-event:record 的 type 字段必须命中 {create,edit,delete} 白
 *      名单；任意字符串（含 'override' / 空 / 数字 / 对象）抛错。
 *   4. count 防御性夹紧 —— handler 走 sticky 路径固定 count=1；走
 *      completionsRepo.record 路径（null stickyNoteId）用 Math.min/max
 *      把 [1, 1000] 范围外的值夹紧。
 *   5. completion:backfill → runAllBackfills 入参透传 + 返回值 re-export。
 *
 * 设计：
 *   - scripts/test-loader.mjs 把 completion-handlers.ts 的 4 个依赖
 *     （./channels / ../db/repositories/completions / ../db/repositories/
 *     stickyNotes / ../db/backfill）替换成 in-memory stub。register
 *     CompletionHandlers() 调用时所有 handler 被写到
 *     globalThis.__test_ipcHandlers —— 测试按 channel 名取出，直接合成
 *     IpcMainInvokeEvent 调用，断言返回值 + repo 副作用。
 *   - 不直接 import 真 repos / 真 backfill，避免 ESM 路径不命中 stub
 *     规则把真模块拖进来（真模块会拉一堆 dbClient / settings 依赖）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== globalThis 注入 =====
//
// 注册前先清，避免上一次 run 残留（--test 进程内复用 module 缓存）。
;(globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers = {}
;(globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls = []
;(globalThis as { __test_completionsDailyCountsCalls?: unknown[] }).__test_completionsDailyCountsCalls = []
;(globalThis as { __test_completionsTotalCalls?: unknown[] }).__test_completionsTotalCalls = []
;(globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls = []
;(globalThis as { __test_noteEventsDailyCountsCalls?: unknown[] }).__test_noteEventsDailyCountsCalls = []
;(globalThis as { __test_stickyRecordCompletionCalls?: unknown[] }).__test_stickyRecordCompletionCalls = []
;(globalThis as { __test_runAllBackfillsCalls?: unknown[] }).__test_runAllBackfillsCalls = []

type HandlerFn = (event: unknown, payload: unknown) => Promise<unknown>
function getHandlers(): Record<string, HandlerFn> {
  return (globalThis as { __test_ipcHandlers?: Record<string, HandlerFn> }).__test_ipcHandlers ?? {}
}
function resetAll(): void {
  ;(globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers = {}
  ;(globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls = []
  ;(globalThis as { __test_completionsDailyCountsCalls?: unknown[] }).__test_completionsDailyCountsCalls = []
  ;(globalThis as { __test_completionsTotalCalls?: unknown[] }).__test_completionsTotalCalls = []
  ;(globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls = []
  ;(globalThis as { __test_noteEventsDailyCountsCalls?: unknown[] }).__test_noteEventsDailyCountsCalls = []
  ;(globalThis as { __test_stickyRecordCompletionCalls?: unknown[] }).__test_stickyRecordCompletionCalls = []
  ;(globalThis as { __test_runAllBackfillsCalls?: unknown[] }).__test_runAllBackfillsCalls = []
  delete (globalThis as Record<string, unknown>).__test_completionsRecordReturn
  delete (globalThis as Record<string, unknown>).__test_completionsDailyCountsReturn
  delete (globalThis as Record<string, unknown>).__test_completionsTotalReturn
  delete (globalThis as Record<string, unknown>).__test_noteEventsDailyCountsReturn
  delete (globalThis as Record<string, unknown>).__test_runAllBackfillsReturn
  delete (globalThis as Record<string, unknown>).__test_runAllBackfills
}

// ===== 加载被测模块 =====

const completionHandlers = await import('../src/main/ipc/completion-handlers.ts')
completionHandlers.registerCompletionHandlers()

const WC_ID = 11
const fakeEvent = () => ({ sender: { id: WC_ID } })

function getHandler(channel: string) {
  const h = getHandlers()[channel]
  assert.ok(typeof h === 'function', `handler for ${channel} must be registered`)
  return h as HandlerFn
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

// =====================================================================
// completion:record — R40 assertUuidId
// =====================================================================

await test('completion:record: valid UUID stickyNoteId + valid date → ok:true, stickyNotesRepo.recordCompletion called', async () => {
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler = getHandler('completion:record')

  const result = await handler(fakeEvent(), {
    stickyNoteId: VALID_UUID,
    date: '2026-09-10',
  })
  assert.deepEqual(result, {
    ok: true,
    count: 1,
    stickyNoteId: VALID_UUID,
    date: '2026-09-10',
  })

  // sticky 路径必须走到 stickyNotesRepo.recordCompletion，不走 completionsRepo.record
  const stickyCalls = (globalThis as { __test_stickyRecordCompletionCalls?: unknown[] })
    .__test_stickyRecordCompletionCalls ?? []
  assert.equal(stickyCalls.length, 1)
  assert.deepEqual(stickyCalls[0], { id: VALID_UUID, date: '2026-09-10' })
  assert.equal(
    ((globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls ?? []).length,
    0,
    'sticky path must NOT touch completionsRepo.record',
  )
})

await test('completion:record: null stickyNoteId → system aggregation path, completionsRepo.record called', async () => {
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler = getHandler('completion:record')

  const result = await handler(fakeEvent(), { stickyNoteId: null, date: '2026-09-10', count: 3 })
  assert.deepEqual(result, {
    ok: true,
    id: 'mock-completion-1',
    stickyNoteId: null,
    date: '2026-09-10',
    count: 3,
    createdAt: result.createdAt,
  })

  // 系统级聚合路径走 completionsRepo.record
  const repoCalls = (globalThis as { __test_completionsRecordCalls?: unknown[] })
    .__test_completionsRecordCalls ?? []
  assert.equal(repoCalls.length, 1)
  assert.deepEqual(repoCalls[0], { stickyNoteId: null, date: '2026-09-10', count: 3 })
  assert.equal(
    ((globalThis as { __test_stickyRecordCompletionCalls?: unknown[] }).__test_stickyRecordCompletionCalls ?? []).length,
    0,
    'null path must NOT touch stickyNotesRepo.recordCompletion',
  )
})

await test('completion:record: path-traversal stickyNoteId → rejected, repo NOT called', async () => {
  for (const evil of [
    '../../../etc/passwd',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'foo/bar',
  ]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('completion:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          stickyNoteId: evil,
          date: '2026-09-10',
        }),
      /id must be a non-empty UUID string/,
      `path-traversal ${JSON.stringify(evil)} must be rejected`,
    )
    assert.equal(
      ((globalThis as { __test_stickyRecordCompletionCalls?: unknown[] }).__test_stickyRecordCompletionCalls ?? []).length,
      0,
    )
    assert.equal(
      ((globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls ?? []).length,
      0,
    )
  }
})

await test('completion:record: non-UUID-format string stickyNoteId → rejected', async () => {
  for (const evil of [
    'not-a-uuid',
    '550e8400-e29b-41d4-a716', // 截断
    '550e8400-e29b-41d4-a716-44665544000Z', // 末位不是 hex
    '550e8400e29b41d4a716446655440000', // 缺 dash
    'AAAA-AAAA-AAAA-AAAA-AAAA', // 非 hex
  ]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('completion:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          stickyNoteId: evil,
          date: '2026-09-10',
        }),
      /id must be a non-empty UUID string/,
      `non-UUID ${JSON.stringify(evil)} must be rejected`,
    )
  }
})

await test('completion:record: non-string stickyNoteId → rejected (number / object / array / boolean)', async () => {
  for (const evil of [123, 0, { id: VALID_UUID }, [VALID_UUID], true, false]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('completion:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          stickyNoteId: evil,
          date: '2026-09-10',
        } as unknown),
      /id must be a non-empty UUID string/,
      `non-string ${JSON.stringify(evil)} must be rejected`,
    )
  }
})

await test('completion:record: empty/whitespace stickyNoteId → rejected', async () => {
  for (const evil of ['', '   ', '\t', '\n']) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('completion:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          stickyNoteId: evil,
          date: '2026-09-10',
        }),
      /id must be a non-empty UUID string/,
      `empty/whitespace ${JSON.stringify(evil)} must be rejected`,
    )
  }
})

// =====================================================================
// completion:record — R40 DAY_KEY_RE
// =====================================================================

await test('completion:record: malformed date rejected; repo NOT called', async () => {
  for (const bad of [
    '2026-2-1', // 月份/日期未补零
    '20260201', // 缺 dash
    '2026/09/10', // 错误分隔符
    'tomorrow', // 非日期
    'not-a-date',
    '', // 空串
    '2026-09-10T10:00:00.000Z', // 多了时间分量
    // 注意：handler 只用 DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/ 字面校验；
    // '2025-02-30' / '2026-13-01' 字面通过（月份 13、日期 30 在字面 regex
    // 里被允许），真实日历校验在 repo 层 isValidDayKey 做。handler 层
    // 守门目标是「拒绝垃圾字符串」而不是「拒绝真实日历错误」。
    'abcd-ef-gh', // 全错
    12345, // 非字符串
    null, // null
    {}, // 对象
  ]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('completion:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          stickyNoteId: VALID_UUID,
          date: bad as unknown,
        }),
      /invalid date for completion:record/,
      `date=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(
      ((globalThis as { __test_stickyRecordCompletionCalls?: unknown[] }).__test_stickyRecordCompletionCalls ?? []).length,
      0,
      `date=${JSON.stringify(bad)} must not reach stickyNotesRepo`,
    )
  }
})

await test('completion:record: valid YYYY-MM-DD date passes', async () => {
  for (const ok of ['2026-09-10', '2025-02-28', '2024-12-31', '2026-01-01']) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('completion:record')
    await handler(fakeEvent(), { stickyNoteId: VALID_UUID, date: ok })
    assert.equal(
      ((globalThis as { __test_stickyRecordCompletionCalls?: unknown[] }).__test_stickyRecordCompletionCalls ?? []).length,
      1,
      `date=${JSON.stringify(ok)} must reach stickyNotesRepo`,
    )
  }
})

// =====================================================================
// completion:record — count clamping
// =====================================================================

await test('completion:record: null path clamps count to [1, 1000] (Math.min/max floor)', async () => {
  // count = 0 → clamp 到 1
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler = getHandler('completion:record')
  await handler(fakeEvent(), { stickyNoteId: null, date: '2026-09-10', count: 0 })
  const calls1 = (globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls ?? []
  assert.equal(calls1[0]?.count, 1, 'count=0 must clamp to 1')

  // count = -5 → clamp 到 1
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler2 = getHandler('completion:record')
  await handler2(fakeEvent(), { stickyNoteId: null, date: '2026-09-10', count: -5 })
  const calls2 = (globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls ?? []
  assert.equal(calls2[0]?.count, 1, 'count=-5 must clamp to 1')

  // count = 99999 → clamp 到 1000
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler3 = getHandler('completion:record')
  await handler3(fakeEvent(), { stickyNoteId: null, date: '2026-09-10', count: 99999 })
  const calls3 = (globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls ?? []
  assert.equal(calls3[0]?.count, 1000, 'count=99999 must clamp to 1000')

  // count = 3.7 → floor 到 3
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler4 = getHandler('completion:record')
  await handler4(fakeEvent(), { stickyNoteId: null, date: '2026-09-10', count: 3.7 })
  const calls4 = (globalThis as { __test_completionsRecordCalls?: unknown[] }).__test_completionsRecordCalls ?? []
  assert.equal(calls4[0]?.count, 3, 'count=3.7 must floor to 3')
})

await test('completion:record: sticky path ignores count argument (fixed to 1)', async () => {
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler = getHandler('completion:record')
  // 即便渲染端发 count=100，sticky 路径也只记一次完成（hot-path invariant）
  const result = await handler(fakeEvent(), {
    stickyNoteId: VALID_UUID,
    date: '2026-09-10',
    count: 100,
  })
  assert.deepEqual(result, {
    ok: true,
    count: 1,
    stickyNoteId: VALID_UUID,
    date: '2026-09-10',
  })
})

// =====================================================================
// note-event:record — R40 assertUuidId + DAY_KEY_RE + ALLOWED_NOTE_EVENT_TYPES
// =====================================================================

await test('note-event:record: valid UUID noteId + valid date + valid type → ok:true, repo called', async () => {
  for (const type of ['create', 'edit', 'delete'] as const) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('note-event:record')
    const result = await handler(fakeEvent(), {
      noteId: VALID_UUID,
      date: '2026-09-10',
      type,
    })
    assert.deepEqual(result, { ok: true })
    const calls = (globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls ?? []
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { noteId: VALID_UUID, date: '2026-09-10', type })
  }
})

await test('note-event:record: null noteId allowed (system aggregation path)', async () => {
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler = getHandler('note-event:record')
  const result = await handler(fakeEvent(), {
    noteId: null,
    date: '2026-09-10',
    type: 'edit',
  })
  assert.deepEqual(result, { ok: true })
  const calls = (globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls ?? []
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { noteId: null, date: '2026-09-10', type: 'edit' })
})

await test('note-event:record: type omitted → defaults to "edit"', async () => {
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const handler = getHandler('note-event:record')
  const result = await handler(fakeEvent(), {
    noteId: VALID_UUID,
    date: '2026-09-10',
    // type omitted
  })
  assert.deepEqual(result, { ok: true })
  const calls = (globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls ?? []
  assert.equal(calls[0]?.type, 'edit')
})

await test('note-event:record: rejects unknown type (white-list violation)', async () => {
  for (const evil of [
    'override', // 任意字符串
    'CREATE', // 大小写敏感（白名单只接受小写）
    '', // 空
    'delete ', // 含尾随空格
    'edit/delete', // 路径分隔
    'rename', // 真实业务字段但不在白名单
  ]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('note-event:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          noteId: VALID_UUID,
          date: '2026-09-10',
          type: evil,
        }),
      /type must be one of/,
      `type=${JSON.stringify(evil)} must be rejected`,
    )
    assert.equal(
      ((globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls ?? []).length,
      0,
    )
  }
})

await test('note-event:record: rejects non-string type (number / object / array)', async () => {
  for (const evil of [123, {}, [], true]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('note-event:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          noteId: VALID_UUID,
          date: '2026-09-10',
          type: evil as unknown,
        }),
      /type must be one of/,
      `type=${JSON.stringify(evil)} must be rejected`,
    )
  }
})

await test('note-event:record: rejects non-UUID noteId (path-traversal / number / empty / object)', async () => {
  for (const evil of [
    '../../../etc/passwd',
    123,
    '',
    '   ',
    {},
    '550e8400-e29b-41d4-a716', // 截断
  ]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('note-event:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          noteId: evil,
          date: '2026-09-10',
          type: 'edit',
        } as unknown),
      /id must be a non-empty UUID string/,
      `noteId=${JSON.stringify(evil)} must be rejected`,
    )
    assert.equal(
      ((globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls ?? []).length,
      0,
    )
  }
})

await test('note-event:record: rejects malformed date (DAY_KEY_RE violation)', async () => {
  for (const bad of ['not-a-date', '2026/09/10', 12345, null, {}]) {
    resetAll()
    completionHandlers.registerCompletionHandlers()
    const handler = getHandler('note-event:record')
    await assert.rejects(
      () =>
        handler(fakeEvent(), {
          noteId: VALID_UUID,
          date: bad as unknown,
          type: 'edit',
        }),
      /invalid date for note-event:record/,
      `date=${JSON.stringify(bad)} must be rejected`,
    )
    assert.equal(
      ((globalThis as { __test_noteEventsRecordCalls?: unknown[] }).__test_noteEventsRecordCalls ?? []).length,
      0,
    )
  }
})

// =====================================================================
// completion:daily / completion:total / note-event:daily — 直通
// =====================================================================

await test('completion:daily / completion:total / note-event:daily pass-through to repos', async () => {
  resetAll()
  ;(globalThis as { __test_completionsDailyCountsReturn?: unknown }).__test_completionsDailyCountsReturn = {
    '2026-09-10': 5,
  }
  ;(globalThis as { __test_completionsTotalReturn?: unknown }).__test_completionsTotalReturn = 42
  ;(globalThis as { __test_noteEventsDailyCountsReturn?: unknown }).__test_noteEventsDailyCountsReturn = {
    '2026-09-10': 3,
  }
  completionHandlers.registerCompletionHandlers()

  const daily = await getHandler('completion:daily')(
    fakeEvent(),
    { startDate: '2026-09-01', endDate: '2026-09-30' },
  )
  assert.deepEqual(daily, { '2026-09-10': 5 })

  const total = await getHandler('completion:total')(
    fakeEvent(),
    { startDate: '2026-09-01', endDate: '2026-09-30' },
  )
  assert.equal(total, 42)

  const noteDaily = await getHandler('note-event:daily')(
    fakeEvent(),
    { startDate: '2026-09-01', endDate: '2026-09-30' },
  )
  assert.deepEqual(noteDaily, { '2026-09-10': 3 })
})

// =====================================================================
// completion:backfill — runAllBackfills 入参透传 + 返回值 re-export
// =====================================================================

await test('completion:backfill: force=false → runAllBackfills(false), result returned as-is', async () => {
  resetAll()
  const presetResult = {
    completions: { scanned: 5, inserted: 3, skipped: 2 },
    noteEvents: { scanned: 4, inserted: 2, skipped: 2 },
  }
  ;(globalThis as { __test_runAllBackfillsReturn?: unknown }).__test_runAllBackfillsReturn = presetResult
  completionHandlers.registerCompletionHandlers()

  const result = await getHandler('completion:backfill')(fakeEvent(), { force: false })
  assert.deepEqual(result, presetResult)
  const calls = (globalThis as { __test_runAllBackfillsCalls?: unknown[] }).__test_runAllBackfillsCalls ?? []
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { force: false })
})

await test('completion:backfill: force=true → runAllBackfills(true)', async () => {
  resetAll()
  completionHandlers.registerCompletionHandlers()
  const result = await getHandler('completion:backfill')(fakeEvent(), { force: true })
  const calls = (globalThis as { __test_runAllBackfillsCalls?: unknown[] }).__test_runAllBackfillsCalls ?? []
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { force: true })
  // 默认 result shape 必须 re-export 给前端
  assert.ok(result.completions && result.noteEvents)
})

await test('completion:backfill: args=undefined → defaults to force=false', async () => {
  resetAll()
  completionHandlers.registerCompletionHandlers()
  await getHandler('completion:backfill')(fakeEvent(), undefined)
  const calls = (globalThis as { __test_runAllBackfillsCalls?: unknown[] }).__test_runAllBackfillsCalls ?? []
  assert.equal(calls[0]?.force, false)
})