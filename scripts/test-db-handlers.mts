/**
 * src/main/ipc/db-handlers.ts 的 IPC 信任边界 + db:vacuum 副作用单测
 *
 * 覆盖：
 *   1. db:vacuum happy path —— handler 必须 await dbClient.call('vacuum',
 *      {})，并在 vacuum resolve 之后才返回 { ok: true }。如果 refactor
 *      把 await 去掉（同步返回）就让渲染端以为 vacuum 已经完成，但
 *      SQLite VACUUM 还在 IPC reply 之后异步跑 —— 触发「渲染端立刻
 *      开新事务 + vacuum 内部对 DB 加锁」的竞态。
 *   2. db:vacuum error path —— dbClient.call 抛错时 handler 必须把
 *      rejection 抛给渲染端（不允许 swallow / 静默吞掉）。如果吞掉
 *      错误返回 { ok: true }，会让 dev 工具以为 vacuum 完成而实际
 *      失败，后续 IPC 调用走相同的 ipcMain.handle 订阅，订阅被破坏
 *      风险。
 *   3. db:status —— 直通 getStatus()，把 connection stub 返回的对象
 *      re-export 给渲染端。
 *
 * 设计：
 *   - scripts/test-loader.mjs 把 db-handlers.ts 的 3 个依赖
 *     （./channels / ../db/connection / ../db/client）替换成 in-memory
 *     stub。registerDbHandlers() 调用时所有 handler 被写到
 *     globalThis.__test_ipcHandlers —— 测试按 channel 名取出，直接合成
 *     IpcMainInvokeEvent 调用，断言返回值 + dbClient.call 副作用
 *     （callLog 记录 method + 入参；responseQueue 控制 resolve 时机）。
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

// ===== dbClient mock =====
//
// 与 test-backfill.mts 共用形态：FIFO responseQueue 控制 call 返回值，
// callLog 断言 method + 入参。db:vacuum 只触发一次 call('vacuum', {})，
// responseQueue 预先 push 一条即可；vacuum error path 把 error 字段填
// 错误消息，call 直接 reject 让 handler 把 rejection 冒泡给渲染端。
function makeDbClientMock() {
  return {
    callLog: [] as CallRecord[],
    responseQueue: [] as QueuedResponse[],
    invalidator: null as null | (() => void),

    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      this.callLog.push({ method, params })
      const next = this.responseQueue.shift()
      if (!next) {
        return Promise.reject(
          new Error(
            `no queued response for call(${method}) [callLog.length=${this.callLog.length}]`,
          ),
        )
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

    runInTransaction<T>(work: () => Promise<T>): Promise<T> {
      return work()
    },

    __reset(): void {
      this.callLog.length = 0
      this.responseQueue.length = 0
    },
  }
}

const dbClientMock = makeDbClientMock()
;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientMock> }).__test_dbClient = dbClientMock

// 保存原始 call 引用 ——「await semantics」测试会临时改写 call()，
// resetAll() 时恢复，避免后续测试拿到 stale 的 deferred vacuumPromise。
const ORIGINAL_CALL = dbClientMock.call.bind(dbClientMock)

// ===== globalThis 注入 =====

;(globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers = {}

type HandlerFn = (event: unknown, payload: unknown) => Promise<unknown>
function getHandlers(): Record<string, HandlerFn> {
  return (globalThis as { __test_ipcHandlers?: Record<string, HandlerFn> }).__test_ipcHandlers ?? {}
}
function resetAll(): void {
  ;(globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers = {}
  dbClientMock.__reset()
  // 恢复被「await semantics」测试覆盖的 call 引用，否则后续 error path
  // 测试调 dbClient.call 时仍然走 deferred vacuumPromise（被 await 挂住）
  // 而不是新 push 进 responseQueue 的 error response。
  ;(dbClientMock as { call: typeof ORIGINAL_CALL }).call = ORIGINAL_CALL
  delete (globalThis as Record<string, unknown>).__test_dbStatus
  delete (globalThis as Record<string, unknown>).__test_getStatus
}

// ===== 加载被测模块 =====

const dbHandlers = await import('../src/main/ipc/db-handlers.ts')
dbHandlers.registerDbHandlers()

const WC_ID = 9
const fakeEvent = () => ({ sender: { id: WC_ID } })

function getHandler(channel: string) {
  const h = getHandlers()[channel]
  assert.ok(typeof h === 'function', `handler for ${channel} must be registered`)
  return h as HandlerFn
}

// =====================================================================
// db:vacuum — happy path
// =====================================================================

await test('db:vacuum: awaits dbClient.call("vacuum", {}) and returns { ok: true } after resolve', async () => {
  resetAll()
  dbHandlers.registerDbHandlers()

  // 先 push 真空吸响应
  dbClientMock.responseQueue.push({ result: { ok: true } })
  const handler = getHandler('db:vacuum')

  const result = await handler(fakeEvent(), undefined)
  assert.deepEqual(result, { ok: true })

  // 必须有且只有一次 vacuum call
  assert.equal(dbClientMock.callLog.length, 1, 'db:vacuum must call dbClient.call exactly once')
  const call = dbClientMock.callLog[0]
  assert.equal(call?.method, 'vacuum')
  assert.deepEqual(call?.params, {})

  // queue 必须被消费（防止「push 一条但 handler 没消费」的隐式 bug）
  assert.equal(dbClientMock.responseQueue.length, 0, 'queued response must be consumed')
})

await test('db:vacuum: returns ONLY after dbClient.call resolves (await semantics)', async () => {
  // 用 deferred 响应控制 resolve 时机：handler 不能在 resolve 前返回。
  resetAll()
  dbHandlers.registerDbHandlers()

  let resolveVacuum: (val: unknown) => void = () => {}
  const vacuumPromise = new Promise((resolve) => {
    resolveVacuum = resolve
  })
  // 把 responseQueue 里那条改成 deferred：让 mock call 返回的是 vacuumPromise
  dbClientMock.responseQueue.length = 0
  dbClientMock.callLog.length = 0
  // 重写 dbClient.call：返回 vacuumPromise，断言 handler 等待
  const originalCall = dbClientMock.call.bind(dbClientMock)
  let vacuumResolveObserved = false
  dbClientMock.call = async <T = unknown>(method: string, params: Record<string, unknown> = {}) => {
    dbClientMock.callLog.push({ method, params })
    if (method === 'vacuum') {
      // 注意：result 必须等到 resolveVacuum 被调才返回
      const r = await vacuumPromise
      vacuumResolveObserved = true
      return r as T
    }
    return originalCall<T>(method, params)
  }

  const handler = getHandler('db:vacuum')
  let handlerResolved = false
  const handlerPromise = handler(fakeEvent(), undefined).then((res) => {
    handlerResolved = true
    return res
  })

  // 100ms 后真空吸仍 defer → handler 必须没 resolve
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(handlerResolved, false, 'handler must NOT resolve before vacuum call resolves')

  // 现在让 vacuum 完成
  resolveVacuum({ ok: true })
  const result = await handlerPromise
  assert.deepEqual(result, { ok: true })
  assert.equal(vacuumResolveObserved, true, 'handler must wait for vacuum promise to resolve')
})

// =====================================================================
// db:vacuum — error path
// =====================================================================

await test('db:vacuum: dbClient.call rejection propagates (handler must NOT swallow)', async () => {
  resetAll()
  dbHandlers.registerDbHandlers()

  dbClientMock.responseQueue.push({ error: 'sqlite is locked' })
  const handler = getHandler('db:vacuum')

  await assert.rejects(
    () => handler(fakeEvent(), undefined),
    /sqlite is locked/,
    'handler must propagate dbClient.call rejection',
  )

  // 必须仍然调过一次 vacuum（不能因为错误路径就短路跳过）
  assert.equal(dbClientMock.callLog.length, 1)
  assert.equal(dbClientMock.callLog[0]?.method, 'vacuum')
})

await test('db:vacuum: dbClient.call generic Error → handler rejects with same message', async () => {
  resetAll()
  dbHandlers.registerDbHandlers()

  dbClientMock.responseQueue.push({ error: 'I/O disk failure' })
  const handler = getHandler('db:vacuum')

  let caught: Error | null = null
  try {
    await handler(fakeEvent(), undefined)
  } catch (e) {
    caught = e as Error
  }
  assert.ok(caught, 'handler must reject on dbClient error')
  assert.match(caught!.message, /I\/O disk failure/)
})

// =====================================================================
// db:status — 直通 getStatus
// =====================================================================

await test('db:status: returns getStatus() result verbatim (default mock shape)', async () => {
  resetAll()
  dbHandlers.registerDbHandlers()

  const handler = getHandler('db:status')
  const result = await handler(fakeEvent(), undefined)
  // 默认 stub 返回 ready:true / path / version / migrationsApplied
  assert.equal((result as { ready?: boolean }).ready, true)
  assert.equal(typeof (result as { path?: string }).path, 'string')
  assert.equal(typeof (result as { version?: number }).version, 'number')
})

await test('db:status: __test_dbStatus preset is re-exported verbatim', async () => {
  resetAll()
  const preset = {
    ready: false,
    path: '/custom/path.db',
    version: 7,
    migrationsApplied: 7,
    customField: 'dev-only',
  }
  ;(globalThis as { __test_dbStatus?: unknown }).__test_dbStatus = preset
  dbHandlers.registerDbHandlers()

  const result = await getHandler('db:status')(fakeEvent(), undefined)
  assert.deepEqual(result, preset)
})

await test('db:status: __test_getStatus function override takes precedence over __test_dbStatus', async () => {
  resetAll()
  ;(globalThis as { __test_dbStatus?: unknown }).__test_dbStatus = { ready: true, path: '/x.db' }
  ;(globalThis as { __test_getStatus?: () => unknown }).__test_getStatus = () => ({
    ready: true,
    path: '/override.db',
    override: true,
  })
  dbHandlers.registerDbHandlers()

  const result = await getHandler('db:status')(fakeEvent(), undefined)
  assert.equal((result as { path?: string }).path, '/override.db')
  assert.equal((result as { override?: boolean }).override, true)
})