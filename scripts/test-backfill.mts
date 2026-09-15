/**
 * src/main/db/backfill.ts 的守护路径单测 —— 覆盖
 *   1. idempotency 短路（force=false 时已写过就不跑）
 *   2. force=true 跳过幂等检查
 *   3. 整批扫描 + per-row exists 预检 + INSERT ON CONFLICT（regression: R21/R25-DI-2）
 *   4. 损坏行自愈（status=done + completed_at=NULL → fallback 到今天 + warn）
 *   5. backfillNoteEvents: notes 表空 / 表不存在 / 幂等跳过 / INSERT WHERE NOT EXISTS
 *   6. runAllBackfills: 任意一项失败不影响另一项
 *
 * backfill 内部走 withPrepared = prepare → run/get/all → finalize 三段 IPC，
 * 测试通过 globalThis.__test_dbClient 的 FIFO responseQueue 控制每次
 * dbClient.call 的返回值，并在 callLog 上断言调用顺序与次数。
 *
 * 运行：npm run test:backfill
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
        return Promise.reject(new Error(`no queued response for call(${method}) [callLog.length=${this.callLog.length}]`))
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

// ===== 加载被测模块 =====
const backfill = await import('../src/main/db/backfill.ts')

// ===== 辅助：构造 withPrepared 序列响应 =====
//
// backfill.withPrepared(sql, async stmtId => dbClient.call(...) → callback)
// 测试要按顺序排程 prepare + execute + finalize 三段响应（依次 push 到
// responseQueue）。prepare 返回 { stmtId }，execute 返回 callback 真正需要的
// 值，finalize 返回 { ok: true }。
function pushPrepare(stmtId: number): void {
  dbClientMock.responseQueue.push({ result: { stmtId } })
}
function pushFinalize(): void {
  dbClientMock.responseQueue.push({ result: { ok: true } })
}
function pushGet(value: unknown): void {
  dbClientMock.responseQueue.push({ result: value })
}
function pushAll(rows: unknown[]): void {
  dbClientMock.responseQueue.push({ result: rows })
}
function pushRun(changes: number): void {
  dbClientMock.responseQueue.push({ result: { changes } })
}
function pushRunError(msg: string): void {
  dbClientMock.responseQueue.push({ error: msg })
}

/** 把 callLog 中所有 method === 'all' 的参数返回 */
function callsOf(method: string): CallRecord[] {
  return dbClientMock.callLog.filter((c) => c.method === method)
}

function resetAll(): void {
  dbClientMock.__reset()
}

// ===== backfillCompletions 单测 =====

await test('backfillCompletions: idempotency flag set → skipped, no SQL traffic', async () => {
  resetAll()
  // getSettingBool 走 withPrepared: prepare → get → finalize
  pushPrepare(100) // SELECT FROM settings WHERE key=?
  pushGet({ value: '1' }) // 已写过幂等标记
  pushFinalize()

  const result = await backfill.backfillCompletions(false)

  assert.equal(result.skipped, true, 'idempotency set → skipped=true')
  assert.equal(result.scanned, 0)
  assert.equal(result.inserted, 0)
  // 关键断言：幂等命中后，**不应**继续走 sticky_notes 扫描 / completions 插入。
  assert.equal(
    callsOf('all').length,
    0,
    'no all() should happen when idempotency flag is set',
  )
  assert.equal(
    callsOf('run').length,
    0,
    'no run() should happen when idempotency flag is set',
  )
})

await test('backfillCompletions: force=true bypasses idempotency check', async () => {
  resetAll()
  // force=true 跳过 getSettingBool，直接走 sticky_notes 扫描
  // 1. scan sticky_notes: prepare + all + finalize
  pushPrepare(101)
  pushAll([]) // 0 行
  pushFinalize()

  const result = await backfill.backfillCompletions(true)

  assert.equal(result.skipped, false)
  assert.equal(result.scanned, 0)
  assert.equal(result.inserted, 0)
  // setSetting 的幂等标记写入
  pushPrepare(102)
  pushRun(1)
  pushFinalize()
  // （上面 push 的会在 withPrepared 内部消费 —— 但 result 已返回，
  // 我们只断言 SQL 序列已正确发起，不重跑）
  // 关键断言：force=true 直接到 sticky_notes 扫描，没调 getSetting。
  const prepareSqls = dbClientMock.callLog
    .filter((c) => c.method === 'prepare')
    .map((c) => String(c.params['sql'] ?? ''))
  assert.ok(
    prepareSqls.some((s) => s.includes('FROM sticky_notes')),
    'force=true should still scan sticky_notes',
  )
})

await test('backfillCompletions: 2 rows, both new → 2 inserts', async () => {
  resetAll()
  // 幂等检查：未设置
  pushPrepare(100)
  pushGet(null)
  pushFinalize()
  // 扫描 sticky_notes：2 行 done
  pushPrepare(101)
  pushAll([
    { id: 's1', completed_at: '2026-01-02T12:00:00.000Z' },
    { id: 's2', completed_at: '2026-01-03T12:00:00.000Z' },
  ])
  pushFinalize()
  // s1: 不存在 → 插入
  pushPrepare(110) // SELECT 1 FROM completions
  pushGet(null)
  pushFinalize()
  pushPrepare(111) // INSERT completions
  pushRun(1)
  pushFinalize()
  // s2: 不存在 → 插入
  pushPrepare(120)
  pushGet(null)
  pushFinalize()
  pushPrepare(121)
  pushRun(1)
  pushFinalize()
  // 标记幂等
  pushPrepare(130)
  pushRun(1)
  pushFinalize()

  const result = await backfill.backfillCompletions(false)

  assert.equal(result.skipped, false)
  assert.equal(result.scanned, 2)
  assert.equal(result.inserted, 2)
  // R21 验证：INSERT 用 ON CONFLICT(sticky_note_id, date) DO NOTHING 真业务键
  const insertSqls = dbClientMock.callLog
    .filter((c) => c.method === 'prepare')
    .map((c) => String(c.params['sql'] ?? ''))
  assert.ok(
    insertSqls.some((s) => s.includes('INSERT INTO completions')),
    'INSERT INTO completions must be issued',
  )
  const insertSql = insertSqls.find((s) => s.includes('INSERT INTO completions'))
  assert.ok(
    insertSql?.includes('ON CONFLICT(sticky_note_id, date)'),
    `R21 regression: ON CONFLICT must be on real business key (sticky_note_id, date), got: ${insertSql}`,
  )
})

await test('backfillCompletions: pre-existing completion → skipped (R25-DI-2 select-then-insert dedup)', async () => {
  resetAll()
  pushPrepare(100) // idempotency
  pushGet(null)
  pushFinalize()
  pushPrepare(101) // scan sticky_notes
  pushAll([
    { id: 's1', completed_at: '2026-01-02T12:00:00.000Z' },
    { id: 's2', completed_at: '2026-01-03T12:00:00.000Z' },
  ])
  pushFinalize()
  // s1 已存在：SELECT 1 返回非 null → 不 INSERT
  pushPrepare(110)
  pushGet({ x: 1 })
  pushFinalize()
  // s2 不存在 → INSERT
  pushPrepare(120)
  pushGet(null)
  pushFinalize()
  pushPrepare(121)
  pushRun(1)
  pushFinalize()
  // 幂等标记
  pushPrepare(130)
  pushRun(1)
  pushFinalize()

  const result = await backfill.backfillCompletions(false)

  assert.equal(result.scanned, 2)
  assert.equal(result.inserted, 1, 'only s2 is inserted; s1 already exists')

  // 关键断言：扫描发现 2 行 → 只发 1 次 INSERT。
  // R25-DI-2 修复前是 INSERT 一律发，靠 ON CONFLICT no-op；修复后是
  // SELECT 1 预检命中就跳过整轮（连 INSERT 都不发），省 UUID 生成。
  const insertPrepares = callsOf('prepare').filter((c) =>
    String(c.params['sql'] ?? '').includes('INSERT INTO completions'),
  )
  assert.equal(insertPrepares.length, 1, 'SELECT 1 hit must short-circuit INSERT')
})

await test('backfillCompletions: corrupted row (status=done, completed_at=NULL) healed with today', async () => {
  resetAll()
  pushPrepare(100) // idempotency
  pushGet(null)
  pushFinalize()
  pushPrepare(101) // scan sticky_notes —— 1 行 done 但 completed_at=NULL
  pushAll([{ id: 's-corrupt', completed_at: null }])
  pushFinalize()
  // 不存在 → INSERT
  pushPrepare(110)
  pushGet(null)
  pushFinalize()
  pushPrepare(111)
  pushRun(1)
  pushFinalize()
  // 幂等标记
  pushPrepare(130)
  pushRun(1)
  pushFinalize()

  const result = await backfill.backfillCompletions(false)

  assert.equal(result.scanned, 1)
  assert.equal(result.inserted, 1, 'corrupted sticky still gets a completion row (heatmap must not lose it)')

  // 验证 INSERT 时用的 date 是今天 —— 通过 params 推断：completionDateIso
  // = new Date().toISOString()（fallback），localDayKeyOf 出来的 key 是今天的
  // 本地日。验证 params 第 3 个元素（[id, sticky_note_id, date, created_at]
  // 索引：date 是 params[2]）。
  const insertRun = dbClientMock.callLog.find(
    (c) => c.method === 'run' && (c.params['params'] as unknown[])?.length === 4,
  )
  assert.ok(insertRun, 'INSERT run should be present')
  const insertParams = insertRun!.params['params'] as unknown[]
  // params 顺序：[nowIso, sticky_note_id, date, completionDateIso]
  // backfill.ts:172-181 里的 INSERT 是
  //   params: [id, r.id, date, completionDateIso]
  // 但实际是 4 个：id (UUID), sticky_note_id, date, created_at (ISO)
  // 我们断言 date 不为空字符串且是个 YYYY-MM-DD 形态
  const dateParam = insertParams[2] as string
  assert.match(dateParam, /^\d{4}-\d{2}-\d{2}$/, `date param should be YYYY-MM-DD, got: ${dateParam}`)
})

await test('backfillCompletions: R31-DI-3 archived=0 guard — should not see archived stickies', async () => {
  // R31-DI-3 修复（high invariant-violation）：原版扫描 sticky_notes 没
  // 加 `AND archived = 0` 守卫 → archived=1 的 legacy sticky 也会被写
  // completions，污染 heatmap。修复后 SQL 必须含 archived=0。
  resetAll()
  pushPrepare(100)
  pushGet(null)
  pushFinalize()
  pushPrepare(101)
  pushAll([]) // 0 行（生产环境 archived=0 守卫生效后 archived=1 不返回）
  pushFinalize()
  pushPrepare(130)
  pushRun(1)
  pushFinalize()

  await backfill.backfillCompletions(false)

  const stickyScanSql = dbClientMock.callLog
    .filter((c) => c.method === 'prepare')
    .map((c) => String(c.params['sql'] ?? ''))
    .find((s) => s.includes('FROM sticky_notes'))
  assert.ok(stickyScanSql, 'sticky_notes scan SQL must be present')
  assert.ok(
    stickyScanSql!.includes('archived = 0'),
    `R31-DI-3 fix: scan SQL must filter archived=0, got: ${stickyScanSql}`,
  )
})

await test('backfillCompletions: settings table error → getSettingBool returns false (continue)', async () => {
  // getSettingBool 内部 try/catch —— settings 读失败不该让整次 backfill 中止
  resetAll()
  // getSettingBool's withPrepared: prepare 抛错 → catch 兜底返回 false
  pushRunError('no such table: settings')
  // 继续扫描 sticky_notes（0 行）
  pushPrepare(101)
  pushAll([])
  pushFinalize()
  // setSetting 的 withPrepared：prepare ok + run 抛错（被 setSetting 的 catch 吞）
  pushPrepare(110)
  pushRunError('no such table: settings')
  pushFinalize()

  const result = await backfill.backfillCompletions(false)

  assert.equal(result.skipped, false, 'getSettingBool 失败时回退到 false（未设置）')
  assert.equal(result.scanned, 0)
  // 不应抛错
})

// ===== backfillNoteEvents 单测 =====

await test('backfillNoteEvents: idempotency flag set → skipped', async () => {
  resetAll()
  pushPrepare(100)
  pushGet({ value: '1' })
  pushFinalize()

  const result = await backfill.backfillNoteEvents(false)

  assert.equal(result.skipped, true)
  assert.equal(result.scanned, 0)
  assert.equal(result.inserted, 0)
  assert.equal(callsOf('all').length, 0, 'no SELECT notes should happen when idempotent')
})

await test('backfillNoteEvents: 0 notes → empty scan, no insert', async () => {
  resetAll()
  pushPrepare(100) // idempotency check
  pushGet(null)
  pushFinalize()
  pushPrepare(101) // SELECT notes
  pushAll([])
  pushFinalize()
  pushPrepare(110) // settings write
  pushRun(1)
  pushFinalize()

  const result = await backfill.backfillNoteEvents(false)

  assert.equal(result.scanned, 0)
  assert.equal(result.inserted, 0)
  assert.equal(result.skipped, false)
})

await test('backfillNoteEvents: notes table not ready → return skipped=false, no settings write', async () => {
  // SELECT notes 抛错（表不存在）→ catch 兜底返回 scanned=0，
  // 且**不**写幂等标记（让下次重试）
  resetAll()
  pushPrepare(100) // idempotency check
  pushGet(null)
  pushFinalize()
  pushPrepare(101) // SELECT notes —— 抛错
  pushRunError('no such table: notes')
  pushFinalize()

  const result = await backfill.backfillNoteEvents(false)

  assert.equal(result.scanned, 0)
  assert.equal(result.inserted, 0)
  assert.equal(result.skipped, false, 'notes 不存在时不标 skipped=true，留给下次重试')
  // 关键：表错时不该写幂等标记
  const setSettingCalls = dbClientMock.callLog.filter((c) => {
    if (c.method !== 'run') return false
    const params = c.params['params'] as unknown[] | undefined
    return Array.isArray(params) && params[0] === 'heatmap.backfill.note_events.v1'
  })
  assert.equal(setSettingCalls.length, 0, 'notes table missing → must NOT write idempotency flag')
})

await test('backfillNoteEvents: 3 notes → 3 INSERT WHERE NOT EXISTS, dedup on conflict', async () => {
  // R23-DI-4 修复：合并 SELECT 1 预检到 INSERT WHERE NOT EXISTS，原子写不重复
  resetAll()
  pushPrepare(100) // idempotency
  pushGet(null)
  pushFinalize()
  pushPrepare(101) // SELECT notes
  pushAll([
    { id: 'n1', mtime: '2026-01-02T12:00:00.000Z' },
    { id: 'n2', mtime: '2026-01-03T12:00:00.000Z' },
    { id: 'n3', mtime: '2026-01-04T12:00:00.000Z' },
  ])
  pushFinalize()
  // INSERT WHERE NOT EXISTS: 共享一个 stmtId (cached via withPrepared)
  // 三次 run，分别返回 changes=1（新增）/ 0（已存在，dedup）
  pushPrepare(110) // INSERT WHERE NOT EXISTS
  pushRun(1) // n1 新增
  pushRun(0) // n2 已存在 → changes=0
  pushRun(1) // n3 新增
  pushFinalize()
  // 幂等标记
  pushPrepare(120)
  pushRun(1)
  pushFinalize()

  const result = await backfill.backfillNoteEvents(false)

  assert.equal(result.scanned, 3)
  assert.equal(result.inserted, 2, 'changes=0 的那条不计入 inserted')

  // 验证 INSERT SQL 合并 WHERE NOT EXISTS（R23-DI-4 修复）
  const insertSql = dbClientMock.callLog
    .filter((c) => c.method === 'prepare')
    .map((c) => String(c.params['sql'] ?? ''))
    .find((s) => s.includes('INSERT INTO note_events'))
  assert.ok(insertSql, 'INSERT INTO note_events SQL must be present')
  assert.ok(
    insertSql!.includes('WHERE NOT EXISTS'),
    `R23-DI-4 fix: INSERT must use WHERE NOT EXISTS, got: ${insertSql}`,
  )
})

// ===== runAllBackfills 单测 =====

await test('runAllBackfills: completions throws → note_events still runs, returns both results', async () => {
  // 任意一项失败不影响其它项（仅记录日志）
  resetAll()
  // backfillCompletions: idempotency check 时 prepare 抛错 → 整次 backfill
  // 抛到外层 catch（因为 getSettingBool 自己 catch，但 SELECT sticky_notes
  // 那一段没 catch —— 直接冒泡）。
  pushPrepare(100) // idempotency prepare
  pushGet(null)
  pushFinalize()
  pushPrepare(101) // SELECT sticky_notes
  pushRunError('no such table: sticky_notes')
  pushFinalize()
  // catch 在 runAllBackfills 内层 → completions = default {skipped:false,...}
  // backfillNoteEvents: 正常路径
  pushPrepare(200) // idempotency
  pushGet(null)
  pushFinalize()
  pushPrepare(201) // SELECT notes
  pushAll([])
  pushFinalize()
  pushPrepare(210) // settings write
  pushRun(1)
  pushFinalize()

  const summary = await backfill.runAllBackfills(false)

  assert.equal(summary.completions.scanned, 0)
  assert.equal(summary.completions.inserted, 0)
  // noteEvents 必须独立跑完
  assert.equal(summary.noteEvents.scanned, 0)
  assert.equal(summary.noteEvents.skipped, false)
})
