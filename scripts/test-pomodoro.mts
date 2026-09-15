/**
 * pomodoroService.ts 的核心守护路径单测 —— 不引第三方 runner，直接用 Node
 * 内置的 ESM loader (scripts/test-loader.mjs) + node:test。
 *
 * 覆盖：
 *   1. R-fix-pomodoro-config-validate (HIGH input-validation)：9 个字段的边界
 *      表驱动测试 —— focusMin=-1 / cycleCount=MAX_SAFE_INTEGER / whiteNoise='purple-noise'
 *      都应在 service 层 throw 而不是写库。
 *   2. H9 generation guard：stop→start 间隙取消副作用路径 —— 用户主动 stop 后
 *      不会发完成通知、不会 sticky.complete、不会触发 audio 副作用。
 *
 * 设计：
 *   - timerEngine 是模块单例：测试通过 globalThis.__test_timerEngine 注入一个
 *     「假」引擎对象，让 pomodoroService 读到的 timerEngine 完全可控。
 *   - dbClient / stickyNotesRepo / settingsRepo / withPrepared / notifications / audio
 *     全部由 loader 注入到 globalThis 的 mock 接管；测试只关心调用次数与顺序。
 *   - 用 .mts 后缀让 Node 把测试文件当 ESM 处理（顶层 await + import()）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== 通用 Mock 工具 =====

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
    /** 让 recordPomodoro 的 INSERT「挂起」，等测试手动 release */
    recordPomodoroBlocker: null as null | { resolve: () => void; reject: (e: Error) => void },

    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      this.callLog.push({ method, params })
      const next = this.responseQueue.shift()
      if (!next) throw new Error(`no queued response for call(${method})`)
      if (next.error) throw new Error(next.error)
      return next.result as T
    },

    async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
      return work()
    },

    __reset(): void {
      this.callLog.length = 0
      this.responseQueue.length = 0
      this.recordPomodoroBlocker = null
    },
  }
}

/**
 * 构造一个可控的 timerEngine mock。pomodoroService 把它当单例用：
 * - state / config 是当前快照
 * - onTick / onStateChanged / onStopped / onPhaseComplete 是回调字段
 *   （pomodoroService.start() 会赋值到这些字段上）
 * - start/stop/pause/resume/skip/reset/setConfig 是普通方法（记录到 calls）
 */
function makeTimerEngineMock() {
  const calls: { fn: string; args?: unknown[] }[] = []
  return {
    state: {
      mode: 'focus' as const,
      remainingSec: 1500,
      totalSec: 1500,
      cycleIndex: 0,
      running: false,
      startedAt: null,
      stickyNoteId: null,
      elapsedSec: 0,
    },
    config: {
      focusMin: 25,
      shortBreakMin: 5,
      longBreakMin: 15,
      dailyGoal: 4,
      cycleCount: 4,
      autoStartNext: false,
      soundEnabled: true,
      autoEnterFocusMode: false,
      whiteNoise: 'none' as const,
    },
    // 回调字段 —— pomodoroService.start() 会重新赋值
    onTick: null as null | ((s: unknown) => void),
    onStateChanged: null as null | ((s: unknown) => void),
    onStopped: null as null | ((s: unknown) => void),
    onPhaseComplete: null as null | ((finished: unknown, next: unknown, prev: unknown) => void),

    start(stickyNoteId: string | null = null): void {
      calls.push({ fn: 'start', args: [stickyNoteId] })
    },
    stop(): void {
      calls.push({ fn: 'stop' })
    },
    pause(): void {
      calls.push({ fn: 'pause' })
    },
    resume(): void {
      calls.push({ fn: 'resume' })
    },
    skip(): void {
      calls.push({ fn: 'skip' })
    },
    reset(): void {
      calls.push({ fn: 'reset' })
    },
    setConfig(c: unknown): void {
      calls.push({ fn: 'setConfig', args: [c] })
      Object.assign(this.config, c)
    },
    __calls: calls,
  }
}

// ===== globalThis 注入 =====

const dbClientMock = makeDbClientMock()
const timerEngineMock = makeTimerEngineMock()

;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientMock> }).__test_dbClient = dbClientMock
;(globalThis as { __test_timerEngine?: ReturnType<typeof makeTimerEngineMock> }).__test_timerEngine = timerEngineMock
;(globalThis as { __test_stickyFindById?: (id: string) => unknown }).__test_stickyFindById = null
;(globalThis as { __test_settingsGet?: (key: string) => unknown }).__test_settingsGet = null
;(globalThis as { __test_settingsSetCalls?: unknown[] }).__test_settingsSetCalls = []
;(globalThis as { __test_stickyCompleteCalls?: unknown[] }).__test_stickyCompleteCalls = []
;(globalThis as { __test_emitCalls?: unknown[] }).__test_emitCalls = []
;(globalThis as { __test_notificationCalls?: Record<string, unknown[]> }).__test_notificationCalls = {}
;(globalThis as { __test_audioCalls?: unknown[] }).__test_audioCalls = []

function getNotificationCalls(): Record<string, unknown[]> {
  return (globalThis as { __test_notificationCalls?: Record<string, unknown[]> })
    .__test_notificationCalls ?? {}
}
function getStickyCompleteCalls(): unknown[] {
  return (globalThis as { __test_stickyCompleteCalls?: unknown[] }).__test_stickyCompleteCalls ?? []
}
function getSettingsSetCalls(): unknown[] {
  return (globalThis as { __test_settingsSetCalls?: unknown[] }).__test_settingsSetCalls ?? []
}
function getAudioCalls(): unknown[] {
  return (globalThis as { __test_audioCalls?: unknown[] }).__test_audioCalls ?? []
}
function getEmitCalls(): unknown[] {
  return (globalThis as { __test_emitCalls?: unknown[] }).__test_emitCalls ?? []
}

function resetGlobals(): void {
  dbClientMock.__reset()
  ;(globalThis as { __test_stickyCompleteCalls?: unknown[] }).__test_stickyCompleteCalls = []
  ;(globalThis as { __test_settingsSetCalls?: unknown[] }).__test_settingsSetCalls = []
  ;(globalThis as { __test_emitCalls?: unknown[] }).__test_emitCalls = []
  ;(globalThis as { __test_notificationCalls?: Record<string, unknown[]> }).__test_notificationCalls = {}
  ;(globalThis as { __test_audioCalls?: unknown[] }).__test_audioCalls = []
  // 重置 timerEngine 的状态快照，避免上一次测试残留 cycleIndex 影响
  timerEngineMock.state = {
    mode: 'focus',
    remainingSec: 1500,
    totalSec: 1500,
    cycleIndex: 0,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.__calls.length = 0
  timerEngineMock.onTick = null
  timerEngineMock.onStateChanged = null
  timerEngineMock.onStopped = null
  timerEngineMock.onPhaseComplete = null
}

// ===== 加载被测模块 =====

const service = await import('../src/main/pomodoro/pomodoroService.ts')

// ===== Tests: validatePomodoroConfigPatch =====

await test('validatePomodoroConfigPatch: rejects non-plain-object input', () => {
  assert.throws(() => service.validatePomodoroConfigPatch(null), /plain object/)
  assert.throws(() => service.validatePomodoroConfigPatch('foo'), /plain object/)
  assert.throws(() => service.validatePomodoroConfigPatch(42), /plain object/)
  assert.throws(() => service.validatePomodoroConfigPatch([]), /plain object/)
})

await test('validatePomodoroConfigPatch: happy path returns sanitized partial', () => {
  const out = service.validatePomodoroConfigPatch({
    focusMin: 30,
    autoStartNext: true,
    whiteNoise: 'rain',
  })
  assert.equal(out.focusMin, 30)
  assert.equal(out.autoStartNext, true)
  assert.equal(out.whiteNoise, 'rain')
  // 未提供的字段不出现
  assert.equal((out as Record<string, unknown>).shortBreakMin, undefined)
})

await test('validatePomodoroConfigPatch: rejects out-of-range focusMin / shortBreakMin / longBreakMin', () => {
  for (const key of ['focusMin', 'shortBreakMin', 'longBreakMin'] as const) {
    // 负数
    assert.throws(() => service.validatePomodoroConfigPatch({ [key]: -1 }), /integer in \[1, 180\]/)
    // 0
    assert.throws(() => service.validatePomodoroConfigPatch({ [key]: 0 }), /integer in \[1, 180\]/)
    // 上界外
    assert.throws(() => service.validatePomodoroConfigPatch({ [key]: 181 }), /integer in \[1, 180\]/)
    // 非整数
    assert.throws(() => service.validatePomodoroConfigPatch({ [key]: 25.5 }), /integer in \[1, 180\]/)
    // NaN / Infinity
    assert.throws(() => service.validatePomodoroConfigPatch({ [key]: NaN }), /integer in \[1, 180\]/)
    assert.throws(
      () => service.validatePomodoroConfigPatch({ [key]: Number.POSITIVE_INFINITY }),
      /integer in \[1, 180\]/,
    )
  }
})

await test('validatePomodoroConfigPatch: rejects huge cycleCount (would break % cycleCount === 0)', () => {
  assert.throws(
    () => service.validatePomodoroConfigPatch({ cycleCount: Number.MAX_SAFE_INTEGER }),
    /integer in \[1, 12\]/,
  )
  assert.throws(() => service.validatePomodoroConfigPatch({ cycleCount: 0 }), /integer in \[1, 12\]/)
  assert.throws(
    () => service.validatePomodoroConfigPatch({ cycleCount: 13 }),
    /integer in \[1, 12\]/,
  )
})

await test('validatePomodoroConfigPatch: rejects dailyGoal out of [1, 20]', () => {
  assert.throws(() => service.validatePomodoroConfigPatch({ dailyGoal: 0 }), /integer in \[1, 20\]/)
  assert.throws(() => service.validatePomodoroConfigPatch({ dailyGoal: 21 }), /integer in \[1, 20\]/)
})

await test('validatePomodoroConfigPatch: rejects non-boolean for boolean fields', () => {
  for (const key of ['autoStartNext', 'soundEnabled', 'autoEnterFocusMode'] as const) {
    assert.throws(
      () => service.validatePomodoroConfigPatch({ [key]: 'yes' }),
      new RegExp(`config\\.${key} must be boolean`),
    )
    assert.throws(
      () => service.validatePomodoroConfigPatch({ [key]: 1 }),
      new RegExp(`config\\.${key} must be boolean`),
    )
  }
})

await test('validatePomodoroConfigPatch: rejects unknown whiteNoise value', () => {
  assert.throws(
    () => service.validatePomodoroConfigPatch({ whiteNoise: 'purple-noise' }),
    /must be one of/,
  )
  assert.throws(() => service.validatePomodoroConfigPatch({ whiteNoise: '' }), /must be one of/)
})

await test('saveConfig: invalid patch throws before any DB write', async () => {
  resetGlobals()
  // settingsRepo.get 返回 null → loadConfig 用 DEFAULT 合并
  ;(globalThis as { __test_settingsGet?: (k: string) => unknown }).__test_settingsGet = () => null

  await assert.rejects(
    () => service.saveConfig({ focusMin: -1 }),
    /integer in \[1, 180\]/,
  )

  // settingsRepo.set 不该被调用 —— 校验失败时直接 throw，不写库
  assert.equal(getSettingsSetCalls().length, 0, 'invalid patch must not reach settingsRepo.set')
})

await test('saveConfig: valid patch sanitizes + writes', async () => {
  resetGlobals()
  ;(globalThis as { __test_settingsGet?: (k: string) => unknown }).__test_settingsGet = () => null

  const next = await service.saveConfig({ focusMin: 30, whiteNoise: 'rain' })
  assert.equal(next.focusMin, 30)
  assert.equal(next.whiteNoise, 'rain')

  // settingsRepo.set 被调一次
  const setCalls = getSettingsSetCalls()
  assert.equal(setCalls.length, 1)
  // timerEngine.setConfig 被调一次（这是 start() 之外唯一一处 setConfig）
  const teSetConfig = timerEngineMock.__calls.filter((c) => c.fn === 'setConfig')
  assert.equal(teSetConfig.length, 1)
})

// ===== Tests: H9 generation guard =====
//
// 关键场景：用户在 phase 完成 → recordPomodoro 之前 / 期间调 stopPomodoroService()，
// 老 generation 的 handlePhaseComplete 在 await 恢复后必须被截断 ——
// 不写 sticky complete、不发完成通知、不播完成音。

await test('H9 guard: stopPomodoroService before recordPomodoro resolves cancels sticky.complete', async () => {
  resetGlobals()
  service.startPomodoroService()
  // 此刻 gen=N (e.g. 1)，timerEngineMock.onPhaseComplete 已被绑定

  // 模拟自然完成（focus → break 推进）
  const finished = {
    mode: 'focus' as const,
    startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    stickyNoteId: 'sticky-1',
    totalSec: 25 * 60,
    elapsedSec: 25 * 60,
    userSkipped: false,
  }
  const nextState = {
    mode: 'shortBreak' as const,
    remainingSec: 5 * 60,
    totalSec: 5 * 60,
    cycleIndex: 1,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextState }

  // 让 recordPomodoro 在 call('run') 处挂起，等 stop 之后再 release。
  let resolveRecord!: () => void
  const recordPromise = new Promise<void>((resolve) => {
    resolveRecord = resolve
  })
  let recordStartedResolve: () => void = () => {}
  const recordStarted = new Promise<void>((r) => {
    recordStartedResolve = r
  })

  const realCall = dbClientMock.call.bind(dbClientMock)
  dbClientMock.call = async function <T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.callLog.push({ method, params })
    if (method === 'run') {
      recordStartedResolve()
      await recordPromise
    }
    // 非 run 方法默认返回 ok（让 BEGIN/COMMIT/其它都过）；
    // run 方法在 recordPromise 释放后也返回 ok。
    return { ok: true } as T
  } as typeof dbClientMock.call

  try {
    // 触发 phase complete —— handlePhaseComplete 作为 fire-and-forget 跑起来
    timerEngineMock.onPhaseComplete?.(finished, nextState, 'focus')
    await recordStarted

    // 在 recordPomodoro 挂起期间，用户主动 stop 服务
    service.stopPomodoroService()

    // 现在才让 recordPomodoro 完成 —— 但 guard 已经在 stop 时把 generation 自增
    resolveRecord()
    // 让 handlePhaseComplete 的 await 链跑完
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 50))

    // 断言：sticky.complete 没被调用（H9 修复目标）
    assert.equal(
      getStickyCompleteCalls().length,
      0,
      'sticky.complete must not be called after stopPomodoroService cancels the generation',
    )
    const notif = getNotificationCalls()
    assert.equal(
      (notif.notifyFocusComplete ?? []).length,
      0,
      'notifyFocusComplete must not be called after stop cancels the generation',
    )
    const audioCalls = getAudioCalls().filter((c: any) => c.fn === 'playCompletionSound')
    assert.equal(audioCalls.length, 0, 'audio side effect must not trigger after guard cancel')
  } finally {
    // 兜底：万一前面抛错，resolveRecord 还没调，必须释放挂起的 promise，
    // 否则 Node 测试运行器会抛 "Promise resolution is still pending"。
    resolveRecord()
    dbClientMock.call = realCall
    await new Promise((r) => setImmediate(r))
  }
})

await test('H9 guard: double stop→start invalidates stale handler chain', async () => {
  resetGlobals()
  service.startPomodoroService()
  service.startPomodoroService() // 第二次 start 自增 generation
  service.stopPomodoroService() // 又自增一次

  // 第一次 start 时绑的 onPhaseComplete 现在拿到的 gen 是 1，
  // 当前 pomodoroGeneration 已经是 3（两次 start + 一次 stop），
  // 所以 guard() 必定返回 false —— 任何副作用都被截断。
  const finished = {
    mode: 'focus' as const,
    startedAt: new Date().toISOString(),
    stickyNoteId: 'sticky-x',
    totalSec: 25 * 60,
    elapsedSec: 25 * 60,
    userSkipped: false,
  }
  const nextState = {
    mode: 'shortBreak' as const,
    remainingSec: 5 * 60,
    totalSec: 5 * 60,
    cycleIndex: 1,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextState }

  // 不挂起任何东西 —— 直接 fire，guard 应立即截断
  timerEngineMock.onPhaseComplete?.(finished, nextState, 'focus')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  assert.equal(getStickyCompleteCalls().length, 0)
  const notif = getNotificationCalls()
  assert.equal((notif.notifyFocusComplete ?? []).length, 0)
})

await test('H9 guard: natural completion without stop → all side effects fire', async () => {
  resetGlobals()
  service.startPomodoroService()

  // 让 dbClient.call 全走默认 mock（不挂起），run 返回 ok
  // INSERT pomodoros 那条 run 不需要 queue（withPrepared 包了，callback 调 run
  // 但 mock 的 call 期望 responseQueue 有响应 —— 我们让它 throw-free 直接 queue success）
  // 简化：因为 runInTransaction → work() 内部既调 exec(BEGIN/COMMIT) 也调 run，
  // 我们 queue 足够的成功响应。

  const finished = {
    mode: 'focus' as const,
    startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    stickyNoteId: 'sticky-natural',
    totalSec: 25 * 60,
    elapsedSec: 25 * 60,
    userSkipped: false,
  }
  const nextState = {
    mode: 'shortBreak' as const,
    remainingSec: 5 * 60,
    totalSec: 5 * 60,
    cycleIndex: 1,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextState }

  // 不挂起、queue 充足的响应让 BEGIN/COMMIT/INSERT 都成功
  for (let i = 0; i < 6; i++) {
    dbClientMock.responseQueue.push({ result: { ok: true } })
  }

  timerEngineMock.onPhaseComplete?.(finished, nextState, 'focus')
  // 等异步链跑完（recordPomodoro + sticky.complete + notify + audio 都 await 链上）
  await new Promise((r) => setTimeout(r, 100))

  // 正常路径：sticky.complete 被调一次
  assert.equal(getStickyCompleteCalls().length, 1, 'sticky.complete must fire on natural completion')
  const notif = getNotificationCalls()
  assert.ok((notif.notifyFocusComplete ?? []).length >= 1, 'notifyFocusComplete must fire')
})

// ===== Tests: handlePhaseComplete break-phase paths (R7P-5) =====
//
// handlePhaseComplete 的 else 分支（line 694-703）在 prevMode !== 'focus'
// 时走 break 完成路径。R7P-5 修复关注两点：
//   - 通知 payload 传入 prevMode（'shortBreak' / 'longBreak'），避免把已完成
//     的 break 误标为 focus
//   - recordPomodoro 仅在 prevMode === 'focus' 时写 pomodoros 表，break
//     完成不应写
//
// 三个场景覆盖：
//   (a) shortBreak → longBreak 自动推进：recordPomodoro NOT called，
//       notifyBreakComplete 被调且 prevMode='shortBreak'，
//       notifyAutoStart 被调（nextState.running && mode !== 'focus'），
//       audio 不走 break→focus 分支所以 playCompletionSound NOT called
//   (b) longBreak → focus 自动推进：notifyBreakComplete 传 prevMode='longBreak'，
//       notifyAutoStart NOT called（nextState.mode === 'focus'），
//       audio.playCompletionSound('longBreak') 被调（line 727，break→focus
//       分支）
//   (c) shortBreak 完成但 nextState 不自动起：notifyBreakComplete 被调，
//       notifyAutoStart NOT called（nextState.running === false）

await test('R7P-5 break-phase: shortBreak → longBreak auto-start → recordPomodoro NOT called; notifyBreakComplete(prevMode=shortBreak) fired; notifyAutoStart fired', async () => {
  resetGlobals()
  service.startPomodoroService()

  const finished = {
    mode: 'shortBreak' as const,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    stickyNoteId: null,
    totalSec: 300, // 5 min shortBreak
    elapsedSec: 300,
    userSkipped: false,
  }
  // nextState: 推进到 longBreak + 自动起跑
  const nextState = {
    mode: 'longBreak' as const,
    remainingSec: 15 * 60,
    totalSec: 15 * 60,
    cycleIndex: 2,
    running: true,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextState }

  // break 完成路径不需要写 DB / sticky —— 不 push 任何 dbClient.call 响应
  timerEngineMock.onPhaseComplete?.(finished, nextState, 'shortBreak')
  await new Promise((r) => setTimeout(r, 100))

  // (1) recordPomodoro NOT called —— break 完成不应进 pomodoros 表
  const dbCalls = dbClientMock.callLog.filter((c) => c.method === 'run')
  assert.equal(dbCalls.length, 0, 'break completion must not call dbClient.run (recordPomodoro path)')

  // sticky.complete NOT called —— 只 focus 完成才自动勾便签
  assert.equal(
    getStickyCompleteCalls().length,
    0,
    'break completion must not call stickyNotesRepo.complete',
  )

  // (2) notifyBreakComplete 被调，传入 prevMode='shortBreak'
  const notif = getNotificationCalls()
  const breakCalls = notif.notifyBreakComplete ?? []
  assert.equal(breakCalls.length, 1, 'notifyBreakComplete must fire on break completion')
  const [passedNextState, passedMin, passedPrevMode] = breakCalls[0] as [unknown, number, string]
  assert.deepEqual(passedNextState, nextState, 'notifyBreakComplete nextState must match')
  assert.equal(passedMin, 5, 'notifyBreakComplete min must be Math.round(totalSec/60) = 5')
  assert.equal(passedPrevMode, 'shortBreak', 'notifyBreakComplete prevMode must be shortBreak (R7P-5)')

  // notifyFocusComplete NOT called —— break 完成不发 focus 通知
  assert.equal(
    (notif.notifyFocusComplete ?? []).length,
    0,
    'notifyFocusComplete must not fire on break completion',
  )

  // (3) notifyAutoStart 被调（nextState.running && nextState.mode !== 'focus'）
  assert.equal(
    (notif.notifyAutoStart ?? []).length,
    1,
    'notifyAutoStart must fire when nextState.running && mode !== focus',
  )

  // (4) audio: shortBreak→longBreak 不会触发 break→focus 分支
  //     (nextState.mode === 'longBreak' !== 'focus')，所以 playCompletionSound NOT called
  const audioCalls = getAudioCalls().filter((c: { fn: string }) => c.fn === 'playCompletionSound')
  assert.equal(
    audioCalls.length,
    0,
    'playCompletionSound must not fire when nextState.mode !== focus (shortBreak→longBreak branch)',
  )
})

await test('R7P-5 break-phase: longBreak → focus auto-start → audio.playCompletionSound(longBreak) fired (line 727)', async () => {
  resetGlobals()
  service.startPomodoroService()

  const finished = {
    mode: 'longBreak' as const,
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    stickyNoteId: null,
    totalSec: 900, // 15 min longBreak
    elapsedSec: 900,
    userSkipped: false,
  }
  // nextState: 自动起 focus 阶段
  const nextState = {
    mode: 'focus' as const,
    remainingSec: 25 * 60,
    totalSec: 25 * 60,
    cycleIndex: 0,
    running: true,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextState }

  timerEngineMock.onPhaseComplete?.(finished, nextState, 'longBreak')
  await new Promise((r) => setTimeout(r, 100))

  // recordPomodoro NOT called
  const dbCalls = dbClientMock.callLog.filter((c) => c.method === 'run')
  assert.equal(dbCalls.length, 0, 'longBreak completion must not call dbClient.run')

  // notifyBreakComplete with prevMode='longBreak'
  const notif = getNotificationCalls()
  const breakCalls = notif.notifyBreakComplete ?? []
  assert.equal(breakCalls.length, 1)
  const [, passedMin, passedPrevMode] = breakCalls[0] as [unknown, number, string]
  assert.equal(passedMin, 15, 'notifyBreakComplete min must be Math.round(900/60) = 15')
  assert.equal(passedPrevMode, 'longBreak', 'notifyBreakComplete prevMode must be longBreak (R7P-5)')

  // notifyAutoStart NOT called (nextState.mode === 'focus')
  assert.equal(
    (notif.notifyAutoStart ?? []).length,
    0,
    'notifyAutoStart must NOT fire when nextState.mode === focus',
  )

  // audio.playCompletionSound('longBreak') 被调（line 727, break→focus branch）
  const audioCalls = getAudioCalls().filter((c: { fn: string; mode?: string }) => c.fn === 'playCompletionSound')
  assert.equal(audioCalls.length, 1, 'playCompletionSound must fire on break→focus auto-start')
  assert.equal(audioCalls[0].mode, 'longBreak', 'playCompletionSound mode must be prevMode (longBreak)')

  // setWhiteNoise：timerEngine.config.whiteNoise === 'none' → 不调
  const setNoiseCalls = getAudioCalls().filter((c: { fn: string }) => c.fn === 'setWhiteNoise')
  assert.equal(
    setNoiseCalls.length,
    0,
    'setWhiteNoise must not fire when config.whiteNoise === none',
  )
})

await test('R7P-5 break-phase: Math.round(totalSec/60) rounds correctly for short durations', async () => {
  resetGlobals()
  service.startPomodoroService()

  // 90s shortBreak → Math.round(90/60) = 2 (not 1.5 → 2)
  const finished90 = {
    mode: 'shortBreak' as const,
    startedAt: new Date().toISOString(),
    stickyNoteId: null,
    totalSec: 90,
    elapsedSec: 90,
    userSkipped: false,
  }
  const nextIdle = {
    mode: 'focus' as const,
    remainingSec: 25 * 60,
    totalSec: 25 * 60,
    cycleIndex: 1,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextIdle }

  timerEngineMock.onPhaseComplete?.(finished90, nextIdle, 'shortBreak')
  await new Promise((r) => setTimeout(r, 50))

  const notif = getNotificationCalls()
  const breakCalls = notif.notifyBreakComplete ?? []
  assert.equal(breakCalls.length, 1)
  const [, passedMin] = breakCalls[0] as [unknown, number, string]
  assert.equal(passedMin, 2, '90s shortBreak must round up to 2 min')

  // 270s longBreak → Math.round(270/60) = 5 (4.5 → 5)
  resetGlobals()
  service.startPomodoroService()
  const finished270 = {
    mode: 'longBreak' as const,
    startedAt: new Date().toISOString(),
    stickyNoteId: null,
    totalSec: 270,
    elapsedSec: 270,
    userSkipped: false,
  }
  const nextIdle2 = {
    mode: 'focus' as const,
    remainingSec: 25 * 60,
    totalSec: 25 * 60,
    cycleIndex: 0,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextIdle2 }

  timerEngineMock.onPhaseComplete?.(finished270, nextIdle2, 'longBreak')
  await new Promise((r) => setTimeout(r, 50))

  const notif2 = getNotificationCalls()
  const breakCalls2 = notif2.notifyBreakComplete ?? []
  assert.equal(breakCalls2.length, 1)
  const [, passedMin2] = breakCalls2[0] as [unknown, number, string]
  assert.equal(passedMin2, 5, '270s longBreak must round up to 5 min (4.5 → 5)')
})

await test('R7P-5 break-phase: shortBreak completes with running=false → notifyAutoStart NOT called', async () => {
  resetGlobals()
  service.startPomodoroService()

  const finished = {
    mode: 'shortBreak' as const,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    stickyNoteId: null,
    totalSec: 300,
    elapsedSec: 300,
    userSkipped: false,
  }
  // 用户没开启 autoStartNext —— nextState.running = false
  const nextState = {
    mode: 'longBreak' as const,
    remainingSec: 15 * 60,
    totalSec: 15 * 60,
    cycleIndex: 1,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
  timerEngineMock.state = { ...nextState }

  timerEngineMock.onPhaseComplete?.(finished, nextState, 'shortBreak')
  await new Promise((r) => setTimeout(r, 100))

  // notifyBreakComplete 还是会被调（break 完成本身的通知）
  const notif = getNotificationCalls()
  const breakCalls = notif.notifyBreakComplete ?? []
  assert.equal(breakCalls.length, 1, 'notifyBreakComplete must fire on break completion')

  // 但 notifyAutoStart 不该被调（nextState.running === false）
  assert.equal(
    (notif.notifyAutoStart ?? []).length,
    0,
    'notifyAutoStart must not fire when nextState.running === false',
  )

  // audio 也不该被调（nextState.running && nextState.mode === 'focus' 都不成立）
  const audioCalls = getAudioCalls().filter((c: { fn: string }) => c.fn === 'playCompletionSound')
  assert.equal(audioCalls.length, 0, 'audio must not fire when nextState not running')
})
