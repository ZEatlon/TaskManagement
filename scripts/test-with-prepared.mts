/**
 * src/main/db/withPrepared.ts 的 R-test-suite-with-prepared (test-coverage)
 * 防线单测 —— 覆盖 3 条关键路径：
 *   (1) dbClient.call('prepare', ...) 抛错（SQL 语法错 / worker 重启 / db
 *       锁）→ 原样冒泡且不调用 executor / finalize
 *   (2) executor 内部 throw（如 all/get/run 抛错）→ 原样冒泡，且 finally
 *       仍跑 finalize
 *   (3) finalize 自身 reject（worker 已死 / stmtId 已失效）→ 调用方主结果
 *       （成功或失败）不被覆盖
 *
 * 设计：scripts/test-loader.mjs 已扩展 isFromWithPrepared context，
 * withPrepared.ts 的 './client' 替成 testmock://db-client stub（=本测试
 * 注入的 globalThis.__test_dbClient）。测试通过 FIFO responseQueue 控制
 * prepare / executor-call / finalize 三段的返回值或 error，并在 callLog
 * 上断言调用顺序与次数。
 *
 * 运行：npm run test:with-prepared
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

// ===== dbClient mock（FIFO responseQueue） =====

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

    registerStmtCacheInvalidator(_fn: () => void): () => void {
      return () => {}
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

// ===== 加载被测模块 =====
// 必须放在 __test_dbClient 注入之后 —— withPrepared.ts 顶层从 './client'
// 取 dbClient；test-loader.mjs 把这个 './client' 替成
// `globalThis.__test_dbClient` 的内存 stub，所以 import 时序很重要。
const { withPrepared } = await import('../src/main/db/withPrepared.ts')

// ===== 辅助 =====

function callsOf(method: string): CallRecord[] {
  return dbClientMock.callLog.filter((c) => c.method === method)
}

function resetMock(): void {
  dbClientMock.__reset()
}

// =====================================================================
// Test 1: prepare 抛错 → 不调 executor / finalize
// =====================================================================

await test('withPrepared: dbClient.call(prepare) rejects → executor NOT called, finalize NOT called, error bubbles up', async () => {
  resetMock()
  // prepare 阶段直接 reject：worker 重启 / SQL 语法错 / db 锁的典型场景
  dbClientMock.responseQueue.push({ error: 'database is locked' })

  let executorCalled = false
  const promise = withPrepared('SELECT * FROM t', async () => {
    executorCalled = true
    return 'should-not-reach'
  })

  await assert.rejects(promise, /database is locked/)
  assert.equal(executorCalled, false, 'executor must NOT be called when prepare throws')
  assert.equal(callsOf('prepare').length, 1, 'prepare called exactly once')
  assert.equal(callsOf('finalize').length, 0, 'finalize must NOT be called when prepare throws (no stmtId to finalize)')
})

// =====================================================================
// Test 2: executor 抛错 → finally 仍跑 finalize，错误原样冒泡
// =====================================================================

await test('withPrepared: executor throws → finally still calls finalize, original error bubbles up', async () => {
  resetMock()
  // prepare 成功 → executor 阶段 dbClient.call(all|get|run) reject
  dbClientMock.responseQueue.push({ result: { stmtId: 17 } }) // prepare ok
  dbClientMock.responseQueue.push({ error: 'no such column: foo' }) // executor call rejects
  dbClientMock.responseQueue.push({ result: { ok: true } }) // finalize ok

  const promise = withPrepared('SELECT foo FROM t', async (stmtId) => {
    assert.equal(stmtId, 17, 'executor must receive the stmtId from prepare')
    return (dbClientMock.call('all', { stmtId }) as Promise<unknown>)
  })

  await assert.rejects(promise, /no such column: foo/)
  // 关键防线：executor 抛错时 finally 仍跑 finalize，避免 stmt 累积
  assert.equal(callsOf('finalize').length, 1, 'finalize must run via finally even when executor throws')
  const fin = callsOf('finalize')[0]
  assert.ok(fin, 'finalize call recorded')
  assert.deepEqual(fin!.params, { stmtId: 17 }, 'finalize must use the same stmtId from prepare')
})

// =====================================================================
// Test 3a: finalize 抛错（成功路径下）→ 主结果透传，不被覆盖
// =====================================================================

await test('withPrepared: finalize rejects but executor returned → result propagates, finalize error swallowed', async () => {
  resetMock()
  dbClientMock.responseQueue.push({ result: { stmtId: 42 } }) // prepare ok
  // executor 不调 dbClient（直接返回值）
  dbClientMock.responseQueue.push({ error: 'Invalid stmtId (stale cache after respawn)' }) // finalize reject

  const result = await withPrepared('SELECT * FROM t', async () => {
    return { rows: [{ id: 1 }, { id: 2 }] }
  })

  // 关键防线：finalize 失败不能让 finally 覆盖 executor 的主结果
  assert.deepEqual(result, { rows: [{ id: 1 }, { id: 2 }] })
  assert.equal(callsOf('finalize').length, 1, 'finalize was attempted once')
})

// =====================================================================
// Test 3b: finalize 抛错（失败路径下）→ 主错误透传，不被 finalize 覆盖
// =====================================================================

await test('withPrepared: finalize rejects AND executor throws → executor error bubbles up (not finalize error)', async () => {
  resetMock()
  dbClientMock.responseQueue.push({ result: { stmtId: 99 } }) // prepare ok
  dbClientMock.responseQueue.push({ error: 'no such column: bar' }) // executor rejects
  dbClientMock.responseQueue.push({ error: 'worker died (finalize failure)' }) // finalize also rejects

  const promise = withPrepared('SELECT bar FROM t', async (stmtId) => {
    return dbClientMock.call('all', { stmtId })
  })

  // 关键防线：executor 的根因错误应该冒泡，finalize 错误被吞掉
  await assert.rejects(promise, /no such column: bar/)
  // 两个错误都触发了，但用户拿到的是根因
  assert.equal(callsOf('finalize').length, 1, 'finalize was attempted once')
})

// =====================================================================
// Test 4: 成功路径基线 — 三步都成功，stmtId 透传
// =====================================================================

await test('withPrepared: happy path → prepare → executor(stmtId) → finalize, all 3 calls in order', async () => {
  resetMock()
  dbClientMock.responseQueue.push({ result: { stmtId: 7 } }) // prepare
  dbClientMock.responseQueue.push({ result: [{ id: 'a' }, { id: 'b' }] }) // executor all
  dbClientMock.responseQueue.push({ result: { ok: true } }) // finalize

  const result = await withPrepared('SELECT id FROM t', async (stmtId) => {
    assert.equal(stmtId, 7)
    return dbClientMock.call('all', { stmtId })
  })

  assert.deepEqual(result, [{ id: 'a' }, { id: 'b' }])
  // 调用顺序必须是 prepare → executor-call → finalize
  const methods = dbClientMock.callLog.map((c) => c.method)
  assert.deepEqual(methods, ['prepare', 'all', 'finalize'])
})
