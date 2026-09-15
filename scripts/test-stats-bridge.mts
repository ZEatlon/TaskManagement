/**
 * src/main/ai/statsBridge.ts 的 R36 防线单测 —— 覆盖 getPomodoroStats /
 * computeStreak（隐式）/ bestHour 选最早 / MAX_DAY_BUCKETS=90 截断 /
 * isAllRange 跳过 queryAllDates / 损坏 started_at 防御 这 6 条关键路径。
 *
 * statsBridge 是 AI → 番茄钟统计的桥接层，被 ai/tools registry 暴露给 LLM
 * 作为 getPomodoroStats 工具。LRU 缓存不会拦截单次调用，每次调用都走真
 * SQLite 聚合逻辑，因此 LLM 看到的「连续多少天 / 最佳时段」一旦算错，会
 * 在多轮对话中持续误导用户（详见 .claude/memory/utc-local-day-slice.md）。
 *
 * 测试策略：
 *   1. **TZ 锁定 Asia/Shanghai**（在 import 之前）。statsBridge 用 new Date()
 *      直接取「今天」/「本周」，且所有日期键都是本地日。
 *   2. test-loader.mjs 已扩展 isFromStatsBridge + isFromCachedStmt 上下文，
 *      把 ../db/client / ../db/cachedStmt / ../log 三个依赖都替换为 stub。
 *   3. dbClient 走 FIFO responseQueue —— 4 路 Promise.all 并行触发 prepare
 *      + execute，调用顺序已分析稳定：prepare A → prepare B → prepare C →
 *      all(A) → get(B,today) → get(B,week) → all(C)（非 all）或
 *      prepare A → prepare B → all(A) → get(B,today) → get(B,week)（all）。
 *   4. cachedStmt stub 内部对同一 SQL 的并发 prepare 调用做了 dedup
 *      （_pending Map），与真实代码在稳态下的行为一致。
 *
 * 运行：npm run test:stats-bridge
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// 必须在 import 之前 —— V8 在第一次 new Date() 时确定本地 TZ；后续 import
// 触发的模块顶层 new Date()（如 statsBridge 内部的 localMidnight）也会用新 TZ。
process.env.TZ = 'Asia/Shanghai'

// ===== 类型（与 statsBridge 对齐；这里只声明测试用到的子集） =====

interface RangeRow {
  started_at: string
  duration_min: number | null
  sticky_note_id: string | null
}

interface DateOnlyRow {
  started_at: string
}

// ===== dbClient mock（FIFO responseQueue + 调用日志） =====

interface QueuedResponse {
  result?: unknown
  error?: string
}

interface CallRecord {
  method: string
  params: Record<string, unknown>
}

function makeDbClientMock() {
  return {
    callLog: [] as CallRecord[],
    responseQueue: [] as QueuedResponse[],
    /** stmt cache invalidator —— statsBridge 测试不触发 worker respawn，
     *  但 cachedStmt stub 会在首次 prepare 调用时 lazy 注册。 */
    invalidator: null as null | (() => void),

    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
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

    __reset(): void {
      this.callLog.length = 0
      this.responseQueue.length = 0
    },
  }
}

const dbClientMock = makeDbClientMock()
;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientMock> }).__test_dbClient = dbClientMock

// ===== 加载被测模块 =====
const statsBridge = await import('../src/main/ai/statsBridge.ts')

// ===== 辅助：构造「本地日」key 对应的 ISO 字符串 =====

/** 把 Date 转成本地 12:00 的 ISO 字符串 —— 中午 12 点是 +8 区本地，离午夜远，
 *  不会被 DST / 跨日边界搞乱。 */
function localMiddayIso(d: Date): string {
  // 用本地构造法：把 local year/month/day 12:00:00 写成 ISO
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  // +08:00 偏移固定：避免本地时区误差。statsBridge 内部只把 started_at
  // 当 UTC ISO 解析，再调 localDayKeyOf(started) 取本地日 —— 不论用
  // +08:00 还是 Z，只要那个本地日是 X，最终 byDay 的 key 就是 X。
  return `${y}-${m}-${day}T12:00:00+08:00`
}

/** 当前本地「今天 00:00」的 Date 引用 */
function todayLocalStart(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** offsetDays 天前的本地 00:00 */
function localDayStart(offsetDays: number): Date {
  const d = todayLocalStart()
  d.setDate(d.getDate() + offsetDays)
  return d
}

// ===== FIFO 响应排程 =====

/**
 * 排程 getPomodoroStats(range) 内部会触发的 dbClient.call 序列响应。
 *
 * Promise.all 启动 4 个并行分支（queryRangeRows / queryCount×2 /
 * queryAllDates），它们的同步部分依次调用 prepareCached → dbClient。
 * 因 cachedStmt stub 内部 dedup 同 SQL 的并发 prepare，调用顺序稳定为：
 *   prepare(A) → prepare(B) → [prepare(C)] → all(A) → get(B,today) → get(B,week) → [all(C)]
 *
 * A = queryRangeRows 的 SQL
 * B = queryCount 的 SQL（两条 get 共享 stmtId，params 不同）
 * C = queryAllDates 的 SQL（仅 !isAllRange 走）
 */
function scheduleFifo(opts: {
  rangeRows: RangeRow[]
  todayCount: number
  weekCount: number
  allDates?: DateOnlyRow[]
  isAllRange?: boolean
}): void {
  const isAll = opts.isAllRange === true
  const allDates = opts.allDates ?? []

  // prepare 响应（stmtId 是占位 —— cachedStmt stub 把 res.stmtId 缓存到 _cache，
  // 后续 dbClient.call('all'/'get', { stmtId }) 用的是缓存值，与此处给的
  // 占位 stmtId 数值无关 —— statsBridge 内部不再检查具体数值）。
  dbClientMock.responseQueue.push({ result: { stmtId: 100 } }) // A: rangeRows
  dbClientMock.responseQueue.push({ result: { stmtId: 200 } }) // B: count
  if (!isAll) {
    dbClientMock.responseQueue.push({ result: { stmtId: 300 } }) // C: allDates
  }
  // execute 响应
  dbClientMock.responseQueue.push({ result: opts.rangeRows }) // all(A)
  dbClientMock.responseQueue.push({ result: { c: opts.todayCount } }) // get(B, todayStart)
  dbClientMock.responseQueue.push({ result: { c: opts.weekCount } }) // get(B, weekStart)
  if (!isAll) {
    dbClientMock.responseQueue.push({ result: allDates }) // all(C)
  }
}

function resetAll(): void {
  dbClientMock.__reset()
  // cachedStmt stub 是模块级 Map<sql, stmtId>，跨测试会泄露状态。
  // scheduleFifo 默认假设「prepare 都要走一次 dbClient.call」—— 不清缓存，
  // 第二次跑同一 range 时 prepare 命中本地缓存，responseQueue 顺序错位，
  // execute 拿到的就是上一轮 prepare 的响应，断言全炸。
  // 走 globalThis 而非 import — test import 真 cachedStmt.ts 没有 __resetCache。
  ;(globalThis as { __test_cachedStmtReset?: () => void }).__test_cachedStmtReset?.()
}

// ===== 导入 lazy：先校验日志 stub（statsBridge 损坏行 warn 走 log.warn） =====
//
// statsBridge import 时 cachedStmt 也会被加载；cachedStmt stub 顶层不会自动
// 注册 invalidator（它只有在 prepareCached 真正被调用时才会调
// dbClient.registerStmtCacheInvalidator）。statsBridge 第一次调用
// getPomodoroStats 就会触发 prepare → ensureInvalidatorRegistered。
// 这里不需要手动调 __bindInvalidator（仅用于模拟 worker respawn）。

// ===== Tests =====

await test('empty table → all counts=0, bestHour=null, streakDays=0', async () => {
  resetAll()
  scheduleFifo({ rangeRows: [], todayCount: 0, weekCount: 0, allDates: [] })

  const result = await statsBridge.getPomodoroStats('week')

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.range, 'week')
  assert.equal(result.todayCount, 0)
  assert.equal(result.weekCount, 0)
  assert.equal(result.rangeCount, 0)
  assert.equal(result.rangeTotalMinutes, 0)
  assert.equal(result.averageMinutes, 0)
  assert.equal(result.streakDays, 0)
  assert.equal(result.bestHour, null)
  assert.equal(result.bestHourCount, 0)
  assert.deepEqual(result.byDay, [])
  assert.equal(result.withStickyCount, 0)
  assert.equal(result.withoutStickyCount, 0)

  // 调用序列：prepare A + prepare B + prepare C + all(A) + get(B,2x) + all(C)
  // 总计 7 次 dbClient.call
  assert.equal(dbClientMock.callLog.length, 7, 'empty run still triggers all 7 IPC calls')
  const prepareCount = dbClientMock.callLog.filter((c) => c.method === 'prepare').length
  assert.equal(prepareCount, 3, '3 prepares: rangeRows / count / allDates')
})

await test('one today record → streakDays=1', async () => {
  resetAll()
  const todayStart = todayLocalStart()
  const todayIso = localMiddayIso(todayStart)
  scheduleFifo({
    rangeRows: [{ started_at: todayIso, duration_min: 25, sticky_note_id: 'sticky-1' }],
    todayCount: 1,
    weekCount: 1,
    allDates: [{ started_at: todayIso }],
  })

  const result = await statsBridge.getPomodoroStats('week')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.rangeCount, 1)
  assert.equal(result.rangeTotalMinutes, 25)
  assert.equal(result.averageMinutes, 25)
  assert.equal(result.streakDays, 1)
  assert.equal(result.bestHour, '12:00-13:00', 'bestHour must reflect local hour 12')
  assert.equal(result.bestHourCount, 1)
  assert.equal(result.withStickyCount, 1)
  assert.equal(result.withoutStickyCount, 0)
  assert.equal(result.byDay.length, 1)
  assert.equal(result.byDay[0]?.count, 1)
  assert.equal(result.byDay[0]?.totalMinutes, 25)
})

await test('today + yesterday, no day-before → streakDays=2', async () => {
  resetAll()
  const todayIso = localMiddayIso(todayLocalStart())
  const yIso = localMiddayIso(localDayStart(-1))
  scheduleFifo({
    rangeRows: [
      { started_at: yIso, duration_min: 25, sticky_note_id: null },
      { started_at: todayIso, duration_min: 30, sticky_note_id: null },
    ],
    todayCount: 1,
    weekCount: 2,
    allDates: [{ started_at: yIso }, { started_at: todayIso }],
  })

  const result = await statsBridge.getPomodoroStats('week')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.streakDays, 2, '连续 2 天（含今天）')
  assert.equal(result.rangeCount, 2)
  assert.equal(result.rangeTotalMinutes, 55)
})

await test('today missing, yesterday present → streakDays=1 (today-not-required)', async () => {
  resetAll()
  const yIso = localMiddayIso(localDayStart(-1))
  scheduleFifo({
    rangeRows: [{ started_at: yIso, duration_min: 25, sticky_note_id: null }],
    todayCount: 0,
    weekCount: 1,
    allDates: [{ started_at: yIso }],
  })

  const result = await statsBridge.getPomodoroStats('week')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.streakDays, 1, '用户早上问"连续多少天"时不应因今日还没开始清零')
  assert.equal(result.todayCount, 0)
  assert.equal(result.rangeCount, 1)
})

await test("range='all' with 100 distinct days → byDay.length=90 and ascending", async () => {
  resetAll()
  // 100 行，每行一个独立的本地日（今天、昨天、...、99 天前）
  const rows: RangeRow[] = []
  for (let i = 0; i < 100; i++) {
    rows.push({
      started_at: localMiddayIso(localDayStart(-i)),
      duration_min: 25,
      sticky_note_id: null,
    })
  }
  // isAllRange=true 跳过 queryAllDates（无 C 这条 SQL），只 5 次 IPC
  scheduleFifo({ rangeRows: rows, todayCount: 1, weekCount: 7, isAllRange: true })

  const result = await statsBridge.getPomodoroStats('all')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.range, 'all')
  assert.equal(result.rangeCount, 100)
  // byDay 截断到最近 90 天，按日期升序
  assert.equal(result.byDay.length, 90, 'MAX_DAY_BUCKETS=90 must truncate to last 90 days')
  for (let i = 1; i < result.byDay.length; i++) {
    const prev = result.byDay[i - 1]!.date
    const cur = result.byDay[i]!.date
    assert.ok(prev < cur, `byDay must be ascending: ${prev} < ${cur}`)
  }
  // 第一条是 89 天前（旧的 10 天被截掉），最后一条是今天
  const expectedFirst = (() => {
    const d = localDayStart(-89)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const expectedLast = (() => {
    const d = todayLocalStart()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  assert.equal(result.byDay[0]?.date, expectedFirst, 'first bucket must be the 89-days-ago day')
  assert.equal(result.byDay[89]?.date, expectedLast, 'last bucket must be today')

  // isAllRange 路径：queryAllDates 被跳过，所以只 5 次 dbClient.call
  assert.equal(dbClientMock.callLog.length, 5, 'isAllRange must skip queryAllDates (no allDates prepare/all)')
})

await test('two hours tied at count=3 → bestHour picks the earlier hour', async () => {
  resetAll()
  // 3 行在 14:xx，3 行在 09:xx。bestHour 循环用 `>` 而非 `>=`，
  // 所以第一次见到的并列计数不会被更新 —— 更早的小时胜出。
  const today = todayLocalStart()
  const t9 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}T09:00:00+08:00`
  const t14 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}T14:00:00+08:00`
  const rows: RangeRow[] = [
    { started_at: t9, duration_min: 25, sticky_note_id: null },
    { started_at: t9, duration_min: 25, sticky_note_id: null },
    { started_at: t9, duration_min: 25, sticky_note_id: null },
    { started_at: t14, duration_min: 25, sticky_note_id: null },
    { started_at: t14, duration_min: 25, sticky_note_id: null },
    { started_at: t14, duration_min: 25, sticky_note_id: null },
  ]
  scheduleFifo({
    rangeRows: rows,
    todayCount: 6,
    weekCount: 6,
    allDates: rows.map((r) => ({ started_at: r.started_at })),
  })

  const result = await statsBridge.getPomodoroStats('today')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.bestHourCount, 3, 'tied at 3 each')
  assert.equal(result.bestHour, '09:00-10:00', 'earlier hour (09) wins over 14 due to strict > comparison')
})

await test('isAllRange path: todayCount/weekCount correct even when queryAllDates is skipped', async () => {
  resetAll()
  // range='all' 跳过 queryAllDates，但 todayCount/weekCount 仍走
  // 独立的 queryCount(todayStart) / queryCount(weekStart) —— 必须正确。
  const todayIso = localMiddayIso(todayLocalStart())
  const yIso = localMiddayIso(localDayStart(-1))
  // 30 天前 + 5 天前 + 1 天前 + 今天，共 4 行
  const d30 = localMiddayIso(localDayStart(-30))
  const d5 = localMiddayIso(localDayStart(-5))
  const rows: RangeRow[] = [
    { started_at: d30, duration_min: 25, sticky_note_id: null },
    { started_at: d5, duration_min: 25, sticky_note_id: null },
    { started_at: yIso, duration_min: 25, sticky_note_id: null },
    { started_at: todayIso, duration_min: 25, sticky_note_id: null },
  ]
  // todayCount=1 (只有今天), weekCount=2 (今天 + 昨天，5天前不在近 7 天)
  scheduleFifo({
    rangeRows: rows,
    todayCount: 1,
    weekCount: 2,
    isAllRange: true,
  })

  const result = await statsBridge.getPomodoroStats('all')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.todayCount, 1, 'todayCount comes from queryCount(todayStart), independent of range')
  assert.equal(result.weekCount, 2, 'weekCount comes from queryCount(weekStart), independent of range')
  assert.equal(result.rangeCount, 4)
  assert.equal(result.streakDays, 2, 'streak 仍能从 byDay / dayKeys 算出（复用 rangeRows 循环）')

  // 没有 allDates prepare/all
  const allCalls = dbClientMock.callLog.filter((c) => c.method === 'all')
  assert.equal(allCalls.length, 1, 'isAllRange → only rangeRows all() call, no allDates')
})

await test('invalid started_at row → log.warn + skip, no throw', async () => {
  resetAll()
  const todayIso = localMiddayIso(todayLocalStart())
  scheduleFifo({
    rangeRows: [
      // 损坏行：started_at 不是有效日期
      { started_at: 'not-a-date', duration_min: 25, sticky_note_id: null },
      { started_at: '2026-13-45T99:99:99Z', duration_min: 25, sticky_note_id: null },
      // 有效行：今天的番茄
      { started_at: todayIso, duration_min: 30, sticky_note_id: 'sticky-x' },
    ],
    todayCount: 1,
    weekCount: 1,
    allDates: [{ started_at: todayIso }],
  })

  const result = await statsBridge.getPomodoroStats('week')
  assert.equal(result.ok, true, '损坏行不能让整次统计失败')
  if (!result.ok) return
  // 只有 1 条有效行被计入
  assert.equal(result.rangeCount, 1)
  assert.equal(result.rangeTotalMinutes, 30)
  assert.equal(result.streakDays, 1)
  assert.equal(result.withStickyCount, 1)
  assert.equal(result.withoutStickyCount, 0)
})

await test('default range argument → range="week"', async () => {
  resetAll()
  scheduleFifo({
    rangeRows: [],
    todayCount: 0,
    weekCount: 0,
    allDates: [],
  })

  const result = await statsBridge.getPomodoroStats()
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.range, 'week', 'default range parameter must be "week"')
})

await test('cancelled queryCount (worker respawn): rangeError result, not throw', async () => {
  // getPomodoroStats 内部任何 dbClient.call 抛错都被外层 try/catch 转成
  // { ok: false, error: msg }。模拟 queryCount 的 get() 抛错。
  resetAll()
  dbClientMock.responseQueue.push({ result: { stmtId: 100 } }) // prepare A
  dbClientMock.responseQueue.push({ result: { stmtId: 200 } }) // prepare B
  dbClientMock.responseQueue.push({ result: { stmtId: 300 } }) // prepare C
  dbClientMock.responseQueue.push({ result: [] }) // all(A)
  dbClientMock.responseQueue.push({ error: 'worker died' }) // get(B, today) 抛错

  const result = await statsBridge.getPomodoroStats('week')
  assert.equal(result.ok, false, 'dbClient error must be converted to { ok: false }')
  if (result.ok) return
  assert.match(result.error, /worker died/)
})

await test('module load: prepareCached triggers invalidator registration (stmt cache hygiene)', async () => {
  // 关键防线：worker respawn 后所有 Repository 必须清缓存。
  // statsBridge 首次调 prepareCached → cachedStub.惰性注册到 dbClient。
  resetAll()
  scheduleFifo({ rangeRows: [], todayCount: 0, weekCount: 0, allDates: [] })
  await statsBridge.getPomodoroStats('week')

  assert.ok(
    typeof dbClientMock.invalidator === 'function',
    'cachedStmt must register an invalidator at first prepare (so worker respawn clears cache)',
  )
})
