/**
 * notifier.ts 的核心守护路径单测 —— 不引第三方 runner，直接用 Node 内置的
 * ESM loader (scripts/test-loader.mjs) + node:test。
 *
 * 覆盖 R33 修复的「markNotifiedWithRetry 整批重试 3 次 + per-row 退化」逻辑，
 * 以及 worker respawn 后 stmt cache invalidator 清空模块缓存、下一轮重新 prepare
 * 的路径（notifier.ts:212-215 的 dbClient.registerStmtCacheInvalidator 钩子）。
 *
 * 运行：npm run test:notifier
 *
 * 设计：
 *   - scripts/test-loader.mjs 用 ESM resolve/load 钩子把 notifier.ts 的 4 个
 *     外部依赖（electron / ../db/client / ../log / ../ipc/emit）替换成从
 *     globalThis 读取的内联 stub。测试在 dynamic import notifier 之前先
 *     把 mock 对象挂到 globalThis 上。
 *   - DB worker 完全 mock 掉 —— 不真连 SQLite，只断言 dbClient.call 的
 *     method + params 顺序与返回处理。
 *   - 用 .mts 后缀让 Node 把测试文件当 ESM 处理（顶层 await + import()）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== 类型 =====

interface QueuedResponse {
  result?: unknown
  error?: string
}

interface CallRecord {
  method: string
  params: Record<string, unknown>
}

// ===== Mocks（挂到 globalThis 上，loader 会注入到被 mock 的模块里） =====

function makeDbClientMock() {
  return {
    /** 每次 dbClient.call 的入参快照，方便测试断言调用顺序 */
    callLog: [] as CallRecord[],
    /** 模拟 worker 返回值：FIFO 消费 */
    responseQueue: [] as QueuedResponse[],
    /** 注册的 invalidator 回调（worker respawn 后触发） */
    invalidator: null as null | (() => void),

    call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      this.callLog.push({ method, params })
      const next = this.responseQueue.shift()
      if (!next) {
        return Promise.reject(new Error(`no queued response for call(${method})`))
      }
      if (next.error) {
        return Promise.reject(new Error(next.error))
      }
      return Promise.resolve(next.result as T)
    },

    registerStmtCacheInvalidator(fn: () => void): () => void {
      this.invalidator = fn
      return () => {
        if (this.invalidator === fn) this.invalidator = null
      }
    },

    /** notifier.ts 不调 runInTransaction，但 mock 留着防止以后扩展时 panic */
    runInTransaction<T>(work: () => Promise<T>): Promise<T> {
      return work()
    },

    /** 测试辅助：手动触发 worker respawn 后的 invalidator 钩子 */
    __triggerInvalidate(): void {
      this.invalidator?.()
    },

    /** 测试辅助：重置状态（保留 invalidator 引用 —— 它是模块加载时一次性
     *  注册到 dbClient 的，__reset 不能误清；否则下一个 test 的
     *  __triggerInvalidate 会变成 no-op，notifier 的 stmt 缓存永远不清。） */
    __reset(): void {
      this.callLog.length = 0
      this.responseQueue.length = 0
    },
  }
}

// 初始化 global state（每个测试文件重新装一份）
const dbClientMock = makeDbClientMock()
;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientMock> }).__test_dbClient = dbClientMock
;(globalThis as { __test_emitCalls?: unknown[] }).__test_emitCalls = []

function getEmitCalls(): { channel: string; payload: unknown }[] {
  return ((globalThis as { __test_emitCalls?: unknown[] }).__test_emitCalls ?? []) as {
    channel: string
    payload: unknown
  }[]
}
function resetEmitCalls(): void {
  ;(globalThis as { __test_emitCalls?: unknown[] }).__test_emitCalls = []
}

// ===== 加载被测模块 =====

const notifier = await import('../src/main/sticky-notes/notifier.ts')

// ===== 辅助：queue 一条 prepare/all/run 响应的「标准」返回值 =====

function queueFetchPrepare(stmtId = 100): void {
  dbClientMock.responseQueue.push({ result: { stmtId } })
}
function queueFetchAll(rows: unknown[]): void {
  dbClientMock.responseQueue.push({ result: rows })
}
function queueMarkPrepare(stmtId = 200): void {
  dbClientMock.responseQueue.push({ result: { stmtId } })
}
function queueRunSuccess(changes = 1): void {
  dbClientMock.responseQueue.push({ result: { changes } })
}
function queueRunError(msg: string): void {
  dbClientMock.responseQueue.push({ error: msg })
}
function queueFinalizeSuccess(): void {
  dbClientMock.responseQueue.push({ result: { ok: true } })
}

/** 找出 callLog 中所有 method === 'all' 的参数 */
function callsOf(method: string): CallRecord[] {
  return dbClientMock.callLog.filter((c) => c.method === method)
}

/** 重新创建 dbClientMock（loader 缓存的 dbClient 实例固定，需要在每次测试前
 *  重置内部状态。如果 mock 模块被 ESM 缓存了，新创建的对象也拿不到 —— 所以
 *  我们通过 __reset() 方法原地清理 callLog / responseQueue / invalidator，
 *  让 ESM 缓存的 dbClient 引用每次都是「干净」状态。） */
function resetAll(): void {
  // 先触发 invalidator —— 这一步必须在 __reset 清掉 invalidator **之前**，
  // 否则 next test 时 notifier 的模块缓存 fetchStmtId / markStmtId 不被清，
  // 后续 ensureXxxStmt() 会跳过 prepare，导致 responseQueue 错位（下一条
  // 「all」请求 pop 出上一条测试遗留的 prepare 响应，对象不可迭代）。
  dbClientMock.__triggerInvalidate()
  dbClientMock.__reset()
  resetEmitCalls()
}

// ===== Tests =====

test('module load: registers stmt cache invalidator exactly once', () => {
  // notifier.ts 模块顶层调用 registerStmtCacheInvalidator —— 验证 hook 已装好，
  // 这样 worker respawn 后能拿到清空缓存的回调。
  assert.ok(
    typeof dbClientMock.invalidator === 'function',
    'expected notifier to register a stmt cache invalidator at module load',
  )
})

await test('scanOnce with 0 due rows: no markNotified call, no per-row fallback', async () => {
  resetAll()
  queueFetchPrepare(101)
  queueFetchAll([]) // 0 行

  const result = await notifier.runOnce()

  assert.equal(result.hit, 0, 'hit count should be 0 for empty result set')
  // prepare + all 两条调用，不该有 run（markNotified 不会被触发）
  assert.equal(dbClientMock.callLog.length, 2, 'should call prepare+all only')
  assert.equal(dbClientMock.callLog[0]?.method, 'prepare')
  assert.equal(dbClientMock.callLog[1]?.method, 'all')
})

await test('scanOnce with 2 due rows: dispatches + batch markNotified (success path)', async () => {
  resetAll()
  // 1. fetchDueRows: prepare + all
  queueFetchPrepare(101)
  queueFetchAll([
    { id: 'note-a', title: 'A', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
    { id: 'note-b', title: 'B', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p2' },
  ])
  // 2. showDueNotification 不发 db call；emitToRenderers 也不发 db call
  // 3. markNotified: prepare + run（一次整批）
  queueMarkPrepare(201)
  queueRunSuccess(2)

  const result = await notifier.runOnce()

  assert.equal(result.hit, 2, 'hit count should be 2')
  // 总调用数 = 2 (fetch) + 2 (mark)
  assert.equal(dbClientMock.callLog.length, 4, 'expect prepare+all+prepare+run')
  const methods = dbClientMock.callLog.map((c) => c.method)
  assert.deepEqual(methods, ['prepare', 'all', 'prepare', 'run'])

  // IPC 推送了 2 次 sticky-note:due（每条 row 一次）
  const emits = getEmitCalls()
  assert.equal(emits.length, 2)
  for (const e of emits) {
    assert.equal(typeof e.payload, 'object')
  }
})

await test('markNotifiedWithRetry: batch fails once then succeeds (retry path)', async () => {
  resetAll()
  // scanOnce 触发 fetchDueRows
  queueFetchPrepare(101)
  queueFetchAll([
    { id: 'note-x', title: 'X', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
  ])
  // markNotified：第一次整批 run 抛错
  queueMarkPrepare(201)
  queueRunError('no such prepared statement')
  // 第二次重试成功
  queueRunSuccess(1)

  const result = await notifier.runOnce()
  assert.equal(result.hit, 1)

  // 调用序列：fetch-prepare + fetch-all + mark-prepare + mark-run(fail) + mark-run(ok)
  const runCalls = callsOf('run')
  assert.equal(runCalls.length, 2, 'expected 1 retry → 2 run calls total')
  // 不应走到 per-row 路径（那会再触发 prepare）
  const prepareCalls = callsOf('prepare')
  assert.equal(prepareCalls.length, 2, 'fetch-prepare + mark-prepare, no per-row prepare')
})

await test('markNotifiedWithRetry: batch fails 3 times → per-row fallback kicks in', async () => {
  resetAll()
  queueFetchPrepare(101)
  queueFetchAll([
    { id: 'note-1', title: '1', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
    { id: 'note-2', title: '2', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p2' },
  ])
  // 整批 mark 重试 3 次都失败
  queueMarkPrepare(201)
  queueRunError('batch fail 1')
  queueRunError('batch fail 2')
  queueRunError('batch fail 3')
  // per-row 退化：每条 row 一组 prepare + run + finalize
  // note-1 成功
  dbClientMock.responseQueue.push({ result: { stmtId: 301 } })
  queueRunSuccess(1)
  queueFinalizeSuccess()
  // note-2 也成功
  dbClientMock.responseQueue.push({ result: { stmtId: 302 } })
  queueRunSuccess(1)
  queueFinalizeSuccess()

  const result = await notifier.runOnce()
  assert.equal(result.hit, 2, 'per-row fallback should keep succeeded count = 2')

  // 整批调用序列：1 prepare + 3 run（重试失败）
  // per-row：2 × (prepare + run + finalize)
  const prepareCalls = callsOf('prepare')
  const runCalls = callsOf('run')
  const finalizeCalls = callsOf('finalize')
  // 总 prepares = 1 (fetch) + 1 (mark batch) + 2 (per-row) = 4
  assert.equal(prepareCalls.length, 4, 'fetch + mark + 2 per-row prepares')
  assert.equal(runCalls.length, 5, '3 batch retries + 2 per-row runs')
  assert.equal(finalizeCalls.length, 2, '2 per-row finalizes (no batch finalize)')

  // 第一个 prepare 是 fetch，第二个是 mark batch，第三/四个是 per-row
  assert.match(String(prepareCalls[2]?.params['sql'] ?? ''), /WHERE id = \?/)
  assert.match(String(prepareCalls[3]?.params['sql'] ?? ''), /WHERE id = \?/)
})

await test('per-row fallback: row-level failure is silently swallowed (no crash)', async () => {
  resetAll()
  queueFetchPrepare(101)
  queueFetchAll([
    { id: 'note-ok', title: 'OK', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
    { id: 'note-fail', title: 'FAIL', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
  ])
  // 整批 mark 全部失败 → per-row 退化
  queueMarkPrepare(201)
  queueRunError('batch 1')
  queueRunError('batch 2')
  queueRunError('batch 3')
  // note-ok: prepare + run + finalize ok
  dbClientMock.responseQueue.push({ result: { stmtId: 401 } })
  queueRunSuccess(1)
  queueFinalizeSuccess()
  // note-fail: prepare 自身抛错（极端情况：worker 全挂）
  // 注：原代码里 per-row 失败是 catch + warn；prepare 抛错会被同层 catch，
  // 但 try/finally 内的 run/finalize 不会执行 —— 这意味着 note-fail 失败时
  // finalize 也不会被调。本测试验证「第一条 note-ok 成功 + scanOnce 整体仍
  // resolve」即可，不强制 finalize 数量。
  queueRunError('prepare also fails')

  const result = await notifier.runOnce()
  assert.equal(result.hit, 2, 'succeeded count is set BEFORE markNotified, so still 2')
})

await test('stmt cache invalidator: after respawn, next scanOnce re-prepares fetchStmt', async () => {
  resetAll()
  // 第一轮扫描：prepare + all + mark-prepare + run
  queueFetchPrepare(101)
  queueFetchAll([
    { id: 'note-r1', title: 'R1', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
  ])
  queueMarkPrepare(201)
  queueRunSuccess(1)
  await notifier.runOnce()
  const prepareCallsAfterFirst = callsOf('prepare').length
  assert.equal(prepareCallsAfterFirst, 2, 'first scan: 2 prepares (fetch + mark)')

  // 模拟 worker respawn —— invalidator 清空模块缓存
  assert.ok(dbClientMock.invalidator, 'invalidator should be registered')
  dbClientMock.__triggerInvalidate()

  // 第二轮扫描：缓存清空，重新 prepare
  queueFetchPrepare(102)
  queueFetchAll([
    { id: 'note-r2', title: 'R2', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
  ])
  queueMarkPrepare(202)
  queueRunSuccess(1)
  await notifier.runOnce()

  // 第二轮又触发了 2 个新 prepare（fetch + mark），总共 4 个
  const allPrepareCalls = callsOf('prepare')
  assert.equal(
    allPrepareCalls.length,
    4,
    'after invalidator, both fetchStmt and markStmt must be re-prepared',
  )
})

// ===== R28 race fix + start/stop 生命周期（之前零覆盖） =====

/** 把事件循环上的微任务 + I/O 回调全部跑一遍。startNotifier 启动的
 *  initial scanOnce 是 fire-and-forget，没有返回值可 await，要靠
 *  flushMicrotasks 等它的 promise chain 全部 settle 完才能断言 callLog。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setImmediate(r))
  }
}

await test('startNotifier: fires immediate scanOnce + registers interval handle', async () => {
  resetAll()
  // 启动立即 scanOnce 走 fetchDueRows → 0 行 → no mark
  queueFetchPrepare(101)
  queueFetchAll([])

  notifier.startNotifier()
  await flushMicrotasks()

  // 启动立即 scanOnce 已跑完：fetch-prepare + fetch-all（无 mark 因为 hit=0）
  assert.equal(
    callsOf('prepare').length,
    1,
    'initial scanOnce should fetch-prepare once',
  )
  assert.equal(callsOf('all').length, 1, 'initial scanOnce should all once')
  assert.equal(callsOf('run').length, 0, 'hit=0 means no markNotified run')
  assert.equal(callsOf('finalize').length, 0, 'still running — no finalize yet')

  // 清理：停止时 finalizeCachedStmts 释放 fetchStmtId（markStmtId 是 null）
  queueFinalizeSuccess()
  await notifier.stopNotifier()
})

await test('stopNotifier awaits in-flight scanOnce before finalize (R28 race fix)', async () => {
  resetAll()

  // 1. fetch prepare 正常返回 stmtId
  queueFetchPrepare(101)
  // 2. fetch all 用一个手动控制的 promise 挂起，模拟 markNotified 之前的
  //    「fetch 拿到 fetchStmtId 后 await fetch all」的 in-flight 状态。
  let resolveFetchAll!: (rows: unknown[]) => void
  const fetchAllDeferred = new Promise<unknown[]>((resolve) => {
    resolveFetchAll = resolve
  })
  dbClientMock.responseQueue.push({ result: fetchAllDeferred })

  // 3. 触发 interval tick（不走真实 30s setInterval），把 scanOnce 串到
  //    scanInFlight —— 这是 R28 修复要保护的状态。
  notifier._runIntervalTickForTest()

  // flushMicrotasks 让 fire-and-forget scanOnce chain 跑过 prepare → 进入
  // await fetch all 的 pending 状态。
  await flushMicrotasks()
  assert.equal(callsOf('prepare').length, 1, 'fetch-prepare consumed')
  assert.equal(callsOf('all').length, 1, 'fetch-all in-flight (pending)')

  // 4. 提前 queue 后续响应：mark-prepare / mark-run / 2× finalize。
  //    stopNotifier 内部的顺序是 await scanInFlight → await finalizeCachedStmts，
  //    所以 finalize 响应必须在 scanOnce resolve 之前 push 进来（FIFO），
  //    否则 await 永远挂起。
  queueMarkPrepare(201)
  queueRunSuccess(1)
  queueFinalizeSuccess()
  queueFinalizeSuccess()

  // 5. 调用 stopNotifier —— 不 await，让它停在 await scanInFlight 上
  const stopPromise = notifier.stopNotifier()

  // 6. 释放 fetchAllDeferred，让 scanOnce continue：进入 markNotified 路径
  resolveFetchAll([
    { id: 'note-x', title: 'X', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
  ])

  // 7. 等 stopNotifier 走完：它 await 完 scanInFlight 后才会调 finalize
  await stopPromise

  // 8. 顺序断言：R28 修复的关键是 finalize 不能在 scanOnce 完成之前发出。
  //    若 R28 修复被回退，finalize 会跑在 mark-run 之前（markNotified 命中
  //    已销毁 stmtId 抛错 → setInterval .catch 静默吞 → 通知已弹但
  //    notified_at 没写 → 下次启动重复通知）。
  const methods = dbClientMock.callLog.map((c) => c.method)
  const fetchAllIdx = methods.indexOf('all')
  const markPrepareIdx = methods.lastIndexOf('prepare')
  const markRunIdx = methods.lastIndexOf('run')
  const finalizeIdx = methods.indexOf('finalize')

  assert.ok(fetchAllIdx >= 0, 'fetch-all happened')
  assert.ok(markPrepareIdx >= 0, 'mark-prepare happened')
  assert.ok(markRunIdx >= 0, 'mark-run happened')
  assert.ok(finalizeIdx >= 0, 'finalize happened')
  assert.ok(
    fetchAllIdx < markPrepareIdx,
    'in-flight fetch-all must precede mark-prepare',
  )
  assert.ok(
    markPrepareIdx < markRunIdx,
    'mark-prepare must precede mark-run',
  )
  assert.ok(
    markRunIdx < finalizeIdx,
    'R28 fix: mark-run must precede finalize (stopNotifier awaits scanInFlight)',
  )
})

await test('start+stop+start: second start re-prepares fetch stmt after finalize', async () => {
  resetAll()

  // ===== 第一轮：startNotifier 初始 scanOnce 命中 1 条 =====
  queueFetchPrepare(101)
  queueFetchAll([
    { id: 'n1', title: 'N1', date: '2026-01-01', due_at: '2026-01-02T00:00:00Z', priority: 'p1' },
  ])
  queueMarkPrepare(201)
  queueRunSuccess(1)

  notifier.startNotifier()
  await flushMicrotasks()

  const cycle1Prepares = callsOf('prepare').length
  assert.equal(cycle1Prepares, 2, 'cycle 1: fetch + mark = 2 prepares')

  // 第一轮 stop：finalizeCachedStmts 释放 fetchStmtId=101 + markStmtId=201
  queueFinalizeSuccess()
  queueFinalizeSuccess()
  await notifier.stopNotifier()
  assert.equal(callsOf('finalize').length, 2, 'cycle 1 stop: 2 finalizes')

  // ===== 第二轮：startNotifier 重新 prepare fetch stmt =====
  // 关键不变量：cycle 1 stop 已经把 fetchStmtId/markStmtId 清成 null，
  // cycle 2 的 initial scanOnce 必须重新走 dbClient.call('prepare', ...)
  // 而不是命中模块缓存（若命中则 stmtId 仍指向已销毁的 worker prepared
  // statement → "no such prepared statement"）。
  queueFetchPrepare(102)
  queueFetchAll([]) // 0 行 → 不再调 mark

  notifier.startNotifier()
  await flushMicrotasks()

  const totalPrepares = callsOf('prepare').length
  assert.equal(
    totalPrepares,
    3,
    'cycle 2: 1 new prepare (cycle 1 had 2; fetch stmtCache cleared by finalize)',
  )

  // 第二轮 stop：只有 fetchStmtId=102，markStmtId 仍是 null
  queueFinalizeSuccess()
  await notifier.stopNotifier()
})

await test('lifecycle: dbClient.registerStmtCacheInvalidator hook stays registered across stop+start', async () => {
  // 覆盖一个潜在回归：startNotifier/stopNotifier 误注册新的 invalidator，
  // 或者 stopNotifier 把 invalidator 解绑。这条 invariant 用来兜底：
  // worker respawn 后，无论 notifier 在 start/stop 任何状态，invalidator
  // 都必须仍能清空 stmtCache。
  resetAll()
  assert.ok(
    typeof dbClientMock.invalidator === 'function',
    'invalidator registered at module load',
  )
  // 抓当前 invalidator 引用
  const before = dbClientMock.invalidator

  // 启动 + 停止循环
  queueFetchPrepare(101)
  queueFetchAll([])
  notifier.startNotifier()
  await flushMicrotasks()
  queueFinalizeSuccess()
  await notifier.stopNotifier()

  // invalidator 引用必须不变（没有重复注册 / 被解绑）
  assert.strictEqual(
    dbClientMock.invalidator,
    before,
    'invalidator reference must remain stable across start+stop',
  )
})
