/**
 * src/main/ai/pomodoroBridge.ts 的 R-test-suite-pomodoro-bridge (test-coverage)
 * 防线单测 —— 覆盖 applyPomodoroAction / applyStart / applyStop / applyTogglePause
 * 四条用户感知路径。
 *
 * 关键防线（见 src/main/ai/pomodoroBridge.ts）：
 *   1. minutes 钳到 [1, 180]（line 193）—— LLM 传 0 / 181 / -1 / NaN 都会
 *      被 clamp，loadConfig 拿到的是 clamp 后的值
 *   2. stickyNoteId 不存在 → kind:start + ok:false（line 182），service.start
 *      不会被调到
 *   3. running=true 时 applyStart → ok:false + state 透传（line 203-209），
 *      即便 stickyNoteId 合法
 *   4. !running && elapsedSec===0 时 applyStop → ok:false（line 236-244），
 *      forced 字段透传
 *   5. applyTogglePause 三态切换：running→paused / !running && startedAt→resumed
 *      / 其它→ok:false 无 kind 字段
 *   6. startPomodoro minutes=合法但与当前 focusMin 相同 → focusMinChanged=false
 *   7. minutes=NaN（非有限数）→ ok:false + 'minutes 必须是数字'
 *
 * 设计：
 *   - scripts/test-loader.mjs 已扩展 isFromPomodoroBridge context，把
 *     ../pomodoro/pomodoroService 整模块替成 testmock://pomodoro-service stub
 *     （暴露 getState / loadConfig / saveConfig / start / stop / pause / resume
 *     七个函数，全部读 globalThis 上的 in-memory mock）。
 *   - ../db/repositories/stickyNotes 走已有的 testmock://sticky-notes-repo stub。
 *   - 测试通过 globalThis.__test_pomodoro{State,LoadConfig,SaveConfig,Start,
 *     Stop,Pause,Resume} 注入行为；通过 __test_pomodoroStartCalls 等数组
 *     断言调用次数 / 入参。
 *
 * 运行：npm run test:pomodoro-bridge
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== 类型（与 pomodoroBridge 对齐；这里只声明测试用到的子集） =====

interface BridgeStateLike {
  mode: string
  running: boolean
  remainingSec: number
  totalSec: number
  elapsedSec: number
  cycleIndex: number
  stickyNoteId: string | null
  startedAt: string | null
}

// ===== globalThis 注入 =====

interface StartCall {
  stickyNoteId: string | null
}

interface SaveConfigCall {
  focusMin?: number
  whiteNoise?: string
  [key: string]: unknown
}

const DEFAULT_STATE: BridgeStateLike = {
  mode: 'focus',
  running: false,
  remainingSec: 1500,
  totalSec: 1500,
  elapsedSec: 0,
  cycleIndex: 0,
  stickyNoteId: null,
  startedAt: null,
}

;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
  ...DEFAULT_STATE,
}
;(globalThis as { __test_pomodoroLoadConfig?: () => Promise<{ focusMin: number }> }).__test_pomodoroLoadConfig =
  () => Promise.resolve({ focusMin: 25 })
;(globalThis as { __test_pomodoroSaveConfigCalls?: SaveConfigCall[] }).__test_pomodoroSaveConfigCalls = []
;(globalThis as { __test_pomodoroStartCalls?: (string | null)[] }).__test_pomodoroStartCalls = []
;(globalThis as { __test_pomodoroStopCalls?: boolean[] }).__test_pomodoroStopCalls = []
;(globalThis as { __test_pomodoroPauseCalls?: boolean[] }).__test_pomodoroPauseCalls = []
;(globalThis as { __test_pomodoroResumeCalls?: boolean[] }).__test_pomodoroResumeCalls = []
// __test_pomodoroStart 留空：默认走 stub 的「返回当前 state」分支；需要模拟
// 抛错时由个别测试在调用前注入。
;(globalThis as { __test_pomodoroStart?: unknown }).__test_pomodoroStart = undefined
;(globalThis as {
  __test_stickyFindById?: (id: string) => unknown
}).__test_stickyFindById = null

function getStartCalls(): (string | null)[] {
  return (globalThis as { __test_pomodoroStartCalls?: (string | null)[] }).__test_pomodoroStartCalls ?? []
}
function getStopCalls(): boolean[] {
  return (globalThis as { __test_pomodoroStopCalls?: boolean[] }).__test_pomodoroStopCalls ?? []
}
function getPauseCalls(): boolean[] {
  return (globalThis as { __test_pomodoroPauseCalls?: boolean[] }).__test_pomodoroPauseCalls ?? []
}
function getResumeCalls(): boolean[] {
  return (globalThis as { __test_pomodoroResumeCalls?: boolean[] }).__test_pomodoroResumeCalls ?? []
}
function getSaveConfigCalls(): SaveConfigCall[] {
  return (globalThis as { __test_pomodoroSaveConfigCalls?: SaveConfigCall[] }).__test_pomodoroSaveConfigCalls ?? []
}

/** 把全局 in-memory 状态重置为 idle focus 25min（pomodoroBridge 默认起点） */
function resetAll(): void {
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
  }
  ;(globalThis as { __test_pomodoroLoadConfig?: () => Promise<{ focusMin: number }> }).__test_pomodoroLoadConfig =
    () => Promise.resolve({ focusMin: 25 })
  ;(globalThis as { __test_pomodoroSaveConfigCalls?: SaveConfigCall[] }).__test_pomodoroSaveConfigCalls = []
  ;(globalThis as { __test_pomodoroStartCalls?: (string | null)[] }).__test_pomodoroStartCalls = []
  ;(globalThis as { __test_pomodoroStopCalls?: boolean[] }).__test_pomodoroStopCalls = []
  ;(globalThis as { __test_pomodoroPauseCalls?: boolean[] }).__test_pomodoroPauseCalls = []
  ;(globalThis as { __test_pomodoroResumeCalls?: boolean[] }).__test_pomodoroResumeCalls = []
  ;(globalThis as { __test_pomodoroStart?: unknown }).__test_pomodoroStart = undefined
  ;(globalThis as { __test_stickyFindById?: (id: string) => unknown }).__test_stickyFindById = null
}

// ===== 加载被测模块 =====
const bridge = await import('../src/main/ai/pomodoroBridge.ts')

// ===== Tests: applyPomodoroAction 分发 =====

await test('applyPomodoroAction: action=start delegates to applyStart (no opts)', async () => {
  resetAll()
  // stickyNoteId 不传 → null 路径；不设 minutes → 不会 saveConfig
  const result = await bridge.applyPomodoroAction({ action: 'start' })
  assert.equal(result.ok, true, 'start should succeed in idle state')
  if (!result.ok) return
  assert.equal(result.kind, 'start')
  assert.equal(result.stickyNoteId, null)
  assert.equal(result.focusMin, undefined, 'no minutes provided → focusMin field absent')
  // service.start 被调一次
  const calls = getStartCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0], null)
})

await test('applyPomodoroAction: action=stop delegates to applyStop (no opts)', async () => {
  resetAll()
  // 先 start 让状态变成 running
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: true,
    elapsedSec: 30,
  }
  const result = await bridge.applyPomodoroAction({ action: 'stop' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'stop')
  // force 没传 → forced 字段必须为 false（line 234 严格 === true 才算 forced）
  assert.equal(result.forced, false)
  // service.stop 被调一次
  assert.equal(getStopCalls().length, 1)
})

await test('applyPomodoroAction: action=pause delegates to applyTogglePause (no opts)', async () => {
  resetAll()
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: true,
  }
  const result = await bridge.applyPomodoroAction({ action: 'pause' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'paused')
  assert.equal(getPauseCalls().length, 1)
})

// ===== Tests: applyStart - minutes 钳位 =====

await test('applyStart: minutes=0 → clamped to 1 (MIN_FOCUS_MINUTES)', async () => {
  resetAll()
  // 焦点：service.start 拿到的是被钳到 [1,180] 之后的值，但 bridge 只把
  // clamped 值写入 saveConfig —— service.start 接受 stickyNoteId 不接受 minutes。
  // 所以此处断言 saveConfig 拿到的 focusMin=1，而不是 service.start 入参。
  const result = await bridge.applyPomodoroAction({ action: 'start', minutes: 0 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'start')
  assert.equal(result.focusMin, 1)
  assert.equal(result.focusMinChanged, true)
  const calls = getSaveConfigCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.focusMin, 1)
})

await test('applyStart: minutes=181 → clamped to 180 (MAX_FOCUS_MINUTES)', async () => {
  resetAll()
  const result = await bridge.applyPomodoroAction({ action: 'start', minutes: 181 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.focusMin, 180)
  const calls = getSaveConfigCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.focusMin, 180)
})

await test('applyStart: minutes=-1 → clamped to 1', async () => {
  resetAll()
  const result = await bridge.applyPomodoroAction({ action: 'start', minutes: -1 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.focusMin, 1)
})

await test('applyStart: minutes=NaN → ok:false "minutes 必须是数字"', async () => {
  resetAll()
  const result = await bridge.applyPomodoroAction({ action: 'start', minutes: Number.NaN })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /minutes 必须是数字/)
  assert.equal(result.kind, 'start')
  // service.start 不该被调
  assert.equal(getStartCalls().length, 0)
  // saveConfig 不该被调
  assert.equal(getSaveConfigCalls().length, 0)
})

await test('applyStart: minutes=Infinity → ok:false (Number.isFinite fails)', async () => {
  resetAll()
  const result = await bridge.applyPomodoroAction({
    action: 'start',
    minutes: Number.POSITIVE_INFINITY,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /minutes 必须是数字/)
  assert.equal(getStartCalls().length, 0)
})

await test('applyStart: minutes=30.7 → rounded to 31 (Math.round then clamp)', async () => {
  resetAll()
  const result = await bridge.applyPomodoroAction({ action: 'start', minutes: 30.7 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // bridge 内部 Math.round(30.7) = 31，clamp 后还是 31
  assert.equal(result.focusMin, 31)
  const calls = getSaveConfigCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.focusMin, 31)
})

await test('applyStart: minutes=25 (same as current focusMin) → focusMinChanged=false', async () => {
  resetAll()
  // 当前 focusMin=25（默认）
  const result = await bridge.applyPomodoroAction({ action: 'start', minutes: 25 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.focusMin, 25)
  // 与当前 focusMin 相同 → focusMinChanged 必须为 false（line 196-199）
  assert.equal(result.focusMinChanged, false, 'same value must NOT write saveConfig')
  // 严格来说 loadConfig 仍被调一次，saveConfig 不被调
  assert.equal(getSaveConfigCalls().length, 0, 'no-op write must be skipped')
})

// ===== Tests: applyStart - stickyNoteId 校验 =====

await test('applyStart: stickyNoteId not found → ok:false "便签不存在", serviceStart NOT called', async () => {
  resetAll()
  ;(globalThis as { __test_stickyFindById?: (id: string) => unknown }).__test_stickyFindById = () => null
  const result = await bridge.applyPomodoroAction({
    action: 'start',
    stickyNoteId: 'non-existent',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.kind, 'start')
  assert.match(result.error, /便签不存在/)
  // 关键：service.start 不该被调（bridge line 182 早返）
  assert.equal(getStartCalls().length, 0, 'serviceStart must NOT be called when sticky is missing')
})

await test('applyStart: stickyNoteId with only whitespace → trimmed to null (not found check skipped)', async () => {
  resetAll()
  const result = await bridge.applyPomodoroAction({
    action: 'start',
    stickyNoteId: '   ',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // whitespace 桥接 trim 后视为 null，跳过 findById
  assert.equal(result.stickyNoteId, null)
  // service.start 被调一次，stickyNoteId=null
  const calls = getStartCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0], null)
})

await test('applyStart: stickyNoteId exists → passes through to service.start', async () => {
  resetAll()
  ;(globalThis as { __test_stickyFindById?: (id: string) => unknown }).__test_stickyFindById = (
    id: string,
  ) => ({ id, title: 'mock' })
  const result = await bridge.applyPomodoroAction({
    action: 'start',
    stickyNoteId: 'valid-uuid-1234',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.stickyNoteId, 'valid-uuid-1234')
  // service.start 被调一次，stickyNoteId 原值透传
  const calls = getStartCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0], 'valid-uuid-1234')
})

// ===== Tests: applyStart - 已运行守卫 =====

await test('applyStart: already running → ok:false + state passthrough, serviceStart NOT called', async () => {
  resetAll()
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: true,
    elapsedSec: 120,
  }
  const result = await bridge.applyPomodoroAction({ action: 'start' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.kind, 'start')
  assert.match(result.error, /已在运行中/)
  // state 必须透传（让 LLM 知道当前实际状态）
  assert.ok(result.state, 'state must be returned even on failure')
  assert.equal(result.state?.running, true)
  assert.equal(result.state?.elapsedSec, 120)
  // service.start 不该被调（line 203-209 早返）
  assert.equal(getStartCalls().length, 0)
})

// ===== Tests: applyStart - serviceStart 失败回滚 (state-leak-on-failure) =====

await test('applyStart: serviceStart throws → focusMin rolled back to previous value', async () => {
  resetAll()
  // 当前 focusMin=25，serviceStart 抛 SQLITE_BUSY 之类的错（DB lock / notesRepo
  // 异常 / getState 状态竞争）。bridge 必须在 catch 内 saveConfig({focusMin:25})
  // 把之前写入的 50 回滚掉，避免下次开默认番茄钟时拿到一个用户从未确认过的值。
  ;(globalThis as { __test_pomodoroStart?: () => never }).__test_pomodoroStart = () => {
    throw new Error('SQLITE_BUSY: database is locked')
  }
  const result = await bridge.applyPomodoroAction({
    action: 'start',
    minutes: 50,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.kind, 'start')
  assert.match(result.error, /SQLITE_BUSY/)
  // 关键防线：saveConfig 顺序必须是 [focusMin=50 写入, focusMin=25 回滚]
  const calls = getSaveConfigCalls()
  assert.equal(calls.length, 2, 'saveConfig must be called twice: write then rollback')
  assert.equal(calls[0]?.focusMin, 50, 'first write: user-requested minutes=50')
  assert.equal(calls[1]?.focusMin, 25, 'rollback: restore previous focusMin=25')
  // service.start 仍被调一次（要走到抛错路径必须真调）
  assert.equal(getStartCalls().length, 1)
})

await test('applyStart: serviceStart throws AND no minutes provided → no rollback, ok:false', async () => {
  resetAll()
  // minutes 不传 → saveConfig 完全不该被调（既无写入也无回滚），失败也走 catch
  // 但因为 focusMinChanged=false，回滚 if 条件不成立，saveConfig 数组保持空。
  ;(globalThis as { __test_pomodoroStart?: () => never }).__test_pomodoroStart = () => {
    throw new Error('notesRepo write failed')
  }
  const result = await bridge.applyPomodoroAction({ action: 'start' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.kind, 'start')
  assert.match(result.error, /notesRepo write failed/)
  // saveConfig 不该被调 —— 既没有改默认值就不需要回滚
  assert.equal(getSaveConfigCalls().length, 0)
})

await test('applyStart: serviceStart throws AND minutes=25 (same as current) → no rollback', async () => {
  resetAll()
  // 当前 focusMin=25，minutes=25 → 触发 clamped===cur.focusMin 分支，
  // saveConfig 不被调（line 204 if 条件不成立），抛错时也没东西可回滚。
  ;(globalThis as { __test_pomodoroStart?: () => never }).__test_pomodoroStart = () => {
    throw new Error('boom')
  }
  const result = await bridge.applyPomodoroAction({ action: 'start', minutes: 25 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(getSaveConfigCalls().length, 0, 'no-op write must not trigger rollback')
})

// 注：回滚 saveConfig 自身也失败的极端分支没有单测 —— 当前 stub 用全局
// __test_pomodoroSaveConfig 钩所有调用，没法只让「第 2 次调用 reject」。
// 静态保证：catch 内嵌套 try/catch + log.warn，失败路径不会冒泡，
// 即使 rollback 抛错也会落到最外层 `return { ok: false, error: ... }`。
// 这条不变式靠代码 review 而非单测守护。

// ===== Tests: applyStop - no-op 守卫 + force 透传 =====

await test('applyStop: !running && elapsedSec===0 → ok:false "当前没有进行中", forced透传', async () => {
  resetAll()
  // 默认 state 已经是 !running && elapsedSec=0
  const result = await bridge.applyPomodoroAction({ action: 'stop', force: true })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.kind, 'stop')
  assert.equal(result.forced, true, 'force=true must propagate even on failure')
  assert.match(result.error, /当前没有进行中的番茄钟/)
  // service.stop 不该被调
  assert.equal(getStopCalls().length, 0)
})

await test('applyStop: !running && elapsedSec===0 + force=false → ok:false + forced=false', async () => {
  resetAll()
  const result = await bridge.applyPomodoroAction({ action: 'stop' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.forced, false)
})

await test('applyStop: !running but elapsedSec>0 (paused w/ progress) → ok:true, service.stop called', async () => {
  resetAll()
  // 模拟「已暂停」状态：running=false 但 elapsedSec 已经过了几秒
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: false,
    elapsedSec: 240,
  }
  const result = await bridge.applyPomodoroAction({ action: 'stop', force: true })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'stop')
  assert.equal(result.forced, true)
  // service.stop 必须被调
  assert.equal(getStopCalls().length, 1)
})

await test('applyStop: running → ok:true + service.stop called, forced reflects input', async () => {
  resetAll()
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: true,
    elapsedSec: 60,
  }
  const result = await bridge.applyPomodoroAction({ action: 'stop' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'stop')
  assert.equal(result.forced, false)
  assert.equal(getStopCalls().length, 1)
})

// ===== Tests: applyTogglePause - 三态分支 =====

await test('applyTogglePause: running=true → kind=paused, service.pause called', async () => {
  resetAll()
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: true,
    startedAt: '2026-09-14T10:00:00.000Z',
  }
  const result = await bridge.applyPomodoroAction({ action: 'pause' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'paused')
  assert.equal(getPauseCalls().length, 1)
  assert.equal(getResumeCalls().length, 0)
})

await test('applyTogglePause: !running && startedAt!==null → kind=resumed (R-fix-pause-resume-elapsed0)', async () => {
  resetAll()
  // 关键防线：刚 start 后 < 1s 内 pause 触发 resume vs paused 的 kind 区分
  // —— 此时 running=false 但 startedAt 已设、elapsedSec=0
  // R-fix-pause-resume-elapsed0：原条件 `startedAt !== null && elapsedSec > 0`
  // 把这种 paused-at-0 状态误判为「没有可恢复的番茄钟」。修复后条件放宽到
  // `startedAt !== null && !running`。
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: false,
    startedAt: '2026-09-14T10:00:00.000Z',
    elapsedSec: 0,
  }
  const result = await bridge.applyPomodoroAction({ action: 'pause' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'resumed', 'startedAt!==null && !running must be resumed, not error')
  assert.equal(getResumeCalls().length, 1)
  assert.equal(getPauseCalls().length, 0)
})

await test('applyTogglePause: !running && startedAt!==null && elapsedSec>0 → kind=resumed', async () => {
  resetAll()
  // 经典「暂停中」状态：已跑过几秒然后被 pause
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: false,
    startedAt: '2026-09-14T10:00:00.000Z',
    elapsedSec: 120,
  }
  const result = await bridge.applyPomodoroAction({ action: 'pause' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.kind, 'resumed')
  assert.equal(getResumeCalls().length, 1)
})

await test('applyTogglePause: !running && startedAt===null (idle) → ok:false, NO kind field', async () => {
  resetAll()
  // 默认 state：idle focus, startedAt=null
  const result = await bridge.applyPomodoroAction({ action: 'pause' })
  assert.equal(result.ok, false)
  if (result.ok) return
  // R-fix-pausePomodoro-kind-on-failure (HIGH ai-quality)：失败分支省略
  // kind 字段，避免 LLM 据 kind 误判为「已暂停」
  assert.equal(result.kind, undefined, 'failure must NOT have kind field (ok=false semantics)')
  assert.match(result.error, /当前没有进行中或已暂停/)
  // service.pause / resume 都不该被调
  assert.equal(getPauseCalls().length, 0)
  assert.equal(getResumeCalls().length, 0)
})

// ===== Tests: getPomodoroState 只读 =====

await test('getPomodoroState: returns current state snapshot (idle)', () => {
  resetAll()
  const state = bridge.getPomodoroState()
  assert.equal(state.running, false)
  assert.equal(state.elapsedSec, 0)
  assert.equal(state.stickyNoteId, null)
  assert.equal(state.startedAt, null)
  assert.equal(state.mode, 'focus')
})

await test('getPomodoroState: running state with stickyNoteId and startedAt', () => {
  resetAll()
  ;(globalThis as { __test_pomodoroState?: BridgeStateLike }).__test_pomodoroState = {
    ...DEFAULT_STATE,
    running: true,
    stickyNoteId: 'sticky-xyz',
    startedAt: '2026-09-14T10:00:00.000Z',
    elapsedSec: 30,
    cycleIndex: 2,
  }
  const state = bridge.getPomodoroState()
  assert.equal(state.running, true)
  assert.equal(state.stickyNoteId, 'sticky-xyz')
  assert.equal(state.startedAt, '2026-09-14T10:00:00.000Z')
  assert.equal(state.elapsedSec, 30)
  assert.equal(state.cycleIndex, 2)
})

// ===== Tests: export canonical 入口只读统计 =====
await test('getPomodoroStats: re-exported from statsBridge (same module object)', async () => {
  // pomodoroBridge.ts:306 用 `export { getPomodoroStats } from './statsBridge'`
  // —— 验证两个 import 拿到的函数引用严格一致（避免某个 reviewer 在 bridge
  // 内做包装导致 LLM 误判）。
  const statsBridge = await import('../src/main/ai/statsBridge.ts')
  assert.equal(bridge.getPomodoroStats, statsBridge.getPomodoroStats)
})
