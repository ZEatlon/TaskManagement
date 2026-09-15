/**
 * src/shared/lib/dayKey.ts 的 R36 防线单测 —— 覆盖 localDayKeyOf /
 * startOfDayLocal / startOfDay（别名）。
 *
 * 这是项目里**唯一**的本地日历 day key 工具，被 main / preload / renderer
 * 三端共用。一旦退回到 `toISOString().slice(0, 10)`（UTC 日），UTC+8 用户
 * 晚上 8 点之后写的便签 / 完成的番茄会被算到「明天」（详见
 * .claude/memory/utc-local-day-slice.md）。
 *
 * 测试策略：
 *   1. **TZ 强制锁定到 Asia/Shanghai**。必须在任何 `import('../...')` 之前
 *      设置 process.env.TZ，否则 V8 缓存的本地 TZ 与测试期望不一致会静默
 *      跑错。本项目所有「今天/本周/本月」逻辑都按 +8 标定，测试也对齐。
 *   2. localDayKeyOf 至少 3 类断言：基本格式、padding、关键 UTC↔local 漂移。
 *   3. startOfDayLocal 验证 (a) 不修改原 d (b) 返回 Date 各字段归零 (c) 默
 *      认参数路径。
 *   4. startOfDay 别名仅做相等性确认（不重复覆盖）。
 *
 * 运行：npm run test:day-key
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// 必须在 import 之前 —— V8 在第一次 new Date() 时确定本地 TZ；后续 import
// 触发的模块顶层 new Date() 也会用新 TZ。
process.env.TZ = 'Asia/Shanghai'

// ===== 加载被测模块 =====
const dayKey = await import('../src/shared/lib/dayKey.ts')

// ===== Tests: localDayKeyOf 格式 =====
await test('localDayKeyOf: pads single-digit month and day to 2 digits', () => {
  // 2026-01-05 12:00 +08:00 → local 2026-01-05 12:00
  const d = new Date('2026-01-05T12:00:00+08:00')
  assert.equal(dayKey.localDayKeyOf(d), '2026-01-05')
})

await test('localDayKeyOf: pads single-digit month', () => {
  // 2026-09-01 09:00 +08:00 → local 2026-09-01
  const d = new Date('2026-09-01T09:00:00+08:00')
  assert.equal(dayKey.localDayKeyOf(d), '2026-09-01')
})

await test('localDayKeyOf: pads single-digit day', () => {
  // 2026-12-03 09:00 +08:00 → local 2026-12-03
  const d = new Date('2026-12-03T09:00:00+08:00')
  assert.equal(dayKey.localDayKeyOf(d), '2026-12-03')
})

// ===== Tests: localDayKeyOf — UTC↔local 漂移防线（核心） =====
await test('localDayKeyOf: late-UTC morning but local next-day morning returns LOCAL date', () => {
  // 2026-01-01T16:30:00Z = UTC 16:30 → +8 local 是 2026-01-02 00:30
  // 关键防线：toISOString().slice(0, 10) 会返回 '2026-01-01'（UTC 错误），
  // localDayKeyOf 必须返回本地日的 '2026-01-02'。
  const d = new Date('2026-01-01T16:30:00Z')
  // sanity: UTC slice 是错的
  assert.equal(d.toISOString().slice(0, 10), '2026-01-01')
  // 关键断言：必须用 local accessor
  assert.equal(dayKey.localDayKeyOf(d), '2026-01-02')
})

await test('localDayKeyOf: early-UTC evening but local previous-day evening returns LOCAL date', () => {
  // 2026-01-02T15:30:00Z = UTC 15:30 → +8 local 是 2026-01-02 23:30（同日）
  // 反向测试：本地还在前一天夜里（24 点前）时，本地日 key 应该是今天，
  // 但 ISO slice 也碰巧是今天 —— 这种 case 主要防止有人用 toLocaleDateString
  // 默认格式（locale 漂移导致 '1/2/2026' / '2026/1/2' / '02-01-2026'）
  // 而非用本地 accessor。
  const d = new Date('2026-01-02T15:30:00Z')
  assert.equal(dayKey.localDayKeyOf(d), '2026-01-02')
})

await test('localDayKeyOf: explicit +08:00 offset ISO string returns that local day', () => {
  // 显式带 +08:00 偏移的字符串：在 +8 下 local 直接读出日期部分。
  const d = new Date('2026-01-01T23:30:00+08:00')
  assert.equal(dayKey.localDayKeyOf(d), '2026-01-01')
  // 反例：同字面量但若用 toISOString().slice(0,10) 会得到 '2026-01-01'
  // （碰巧一致），所以这一行主要验证函数可解析 +08:00 偏移字符串。
})

// ===== Tests: localDayKeyOf 默认参数 =====
await test('localDayKeyOf: default arg returns today in +08:00', () => {
  const fromFn = dayKey.localDayKeyOf()
  const fromNow = dayKey.localDayKeyOf(new Date())
  assert.equal(typeof fromFn, 'string')
  assert.equal(fromFn, fromNow, 'default arg path must equal explicit new Date()')
  // 与 new Date() 的本地 accessor 自检对齐
  const now = new Date()
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  assert.equal(fromFn, expected, 'default path must read local accessors (not UTC)')
})

// ===== Tests: startOfDayLocal =====
await test('startOfDayLocal: zeroes hours/minutes/seconds/milliseconds, keeps year-month-day', () => {
  const d = new Date('2026-09-14T15:30:45.789+08:00')
  const r = dayKey.startOfDayLocal(d)
  assert.equal(r.getFullYear(), 2026)
  assert.equal(r.getMonth(), 8) // September (0-indexed)
  assert.equal(r.getDate(), 14)
  assert.equal(r.getHours(), 0)
  assert.equal(r.getMinutes(), 0)
  assert.equal(r.getSeconds(), 0)
  assert.equal(r.getMilliseconds(), 0)
})

await test('startOfDayLocal: does NOT mutate the input Date', () => {
  // 关键防线：startOfDayLocal 必须返回新 Date，不修改原 d。
  // 老代码 `d.setHours(0, 0, 0, 0)` 会污染所有持有 d 引用的 caller
  // （pomodoroService / heatmapData / statsBridge 等都会撞雷）。
  const original = new Date('2026-09-14T15:30:45.789+08:00')
  const originalTime = original.getTime()
  const r = dayKey.startOfDayLocal(original)
  assert.equal(original.getTime(), originalTime, 'input Date.getTime() must be unchanged')
  assert.equal(original.getHours(), 15, 'input hour must not be reset to 0')
  assert.equal(original.getMinutes(), 30, 'input minute must not be reset to 0')
  assert.notEqual(r, original, 'must return a NEW Date instance')
})

await test('startOfDayLocal: default arg uses today (local 00:00 in +08:00)', () => {
  const r = dayKey.startOfDayLocal()
  assert.equal(r.getHours(), 0)
  assert.equal(r.getMinutes(), 0)
  assert.equal(r.getSeconds(), 0)
  assert.equal(r.getMilliseconds(), 0)
  // 与 localDayKeyOf() 自洽：key === localDayKeyOf(r)
  assert.equal(dayKey.localDayKeyOf(r), dayKey.localDayKeyOf())
})

// ===== Tests: startOfDay 别名 =====
await test('startOfDay: alias resolves to startOfDayLocal (reference equality)', () => {
  // 跨 IPC 边界时 renderer 不应被要求 import renderer/lib/date.ts 的别名；
  // 此别名保证 shared 端和 renderer 端语义一致。
  assert.equal(dayKey.startOfDay, dayKey.startOfDayLocal)
})

await test('startOfDay: alias produces identical results for the same input', () => {
  const d = new Date('2026-09-14T15:30:45.789+08:00')
  const a = dayKey.startOfDay(d)
  const b = dayKey.startOfDayLocal(d)
  assert.equal(a.getTime(), b.getTime())
  assert.equal(a.getHours(), 0)
})

// =====================================================================
// R36 防线单测 —— isValidDayKey / isValidDayKeyLocal 真实日期判定
// =====================================================================
//
// 这是项目里**唯一**的本地日历 day key 工具，被 main / preload / renderer
// 三端共用。一旦退回到 `toISOString().slice(0, 10)`（UTC 日），UTC+8 用户
// 晚上 8 点之后写的便签 / 完成的番茄会被算到「明天」（详见
// .claude/memory/utc-local-day-slice.md）。两个 helper 共享 DAY_KEY_RE 字面
// 校验，但锚点不同：isValidDayKey 是 UTC（new Date('YYYY-MM-DDT00:00:00.000Z')），
// isValidDayKeyLocal 是本地时区（new Date('YYYY-MM-DDT00:00:00')）。任何
// 改动 helper 的语义都会破坏 5 个调用点（navigateBridge.parseRoute /
// validators.parseSafeDayKey / completions.validateDayKey / sticky-note-handlers /
// completions.record）的真实日期判定。

// ===== Tests: isValidDayKey (UTC anchor) =====

await test('isValidDayKey: 2024-02-29 (leap year) → true', () => {
  // 关键防线：2024 是闰年，2 月 29 日合法。新 Date('2024-02-29T00:00:00.000Z')
  // 必须保持 2-29，而不是被 JS 滑到 3-1。
  assert.equal(dayKey.isValidDayKey('2024-02-29'), true)
})

await test('isValidDayKey: 2025-02-29 (non-leap year) → false', () => {
  // 关键防线：2025 不是闰年，2 月 29 日不存在。new Date('2025-02-29T...')
  // 在 JS 引擎里会滑到 3-1，isValidDayKey 内部回读 UTC 三元组确认 = 2-29
  // 不匹配 → false。
  assert.equal(dayKey.isValidDayKey('2025-02-29'), false)
})

await test('isValidDayKey: 2025-02-30 (impossible day) → false', () => {
  // 关键防线：2 月根本没有 30 天，JS 会滑到 3-2。
  assert.equal(dayKey.isValidDayKey('2025-02-30'), false)
})

await test('isValidDayKey: 2025-13-01 (impossible month) → false', () => {
  assert.equal(dayKey.isValidDayKey('2025-13-01'), false)
})

await test('isValidDayKey: 2025-00-15 (month=0) → false', () => {
  assert.equal(dayKey.isValidDayKey('2025-00-15'), false)
})

await test('isValidDayKey: 2025-01-32 (day=32) → false', () => {
  assert.equal(dayKey.isValidDayKey('2025-01-32'), false)
})

await test('isValidDayKey: 2025-01-00 (day=0) → false', () => {
  assert.equal(dayKey.isValidDayKey('2025-01-00'), false)
})

await test('isValidDayKey: "2025/01/01" (slash separator) → false (DAY_KEY_RE requires dash)', () => {
  assert.equal(dayKey.isValidDayKey('2025/01/01'), false)
})

await test('isValidDayKey: "2025-9-14" (no zero-pad) → false', () => {
  // 关键防线：9 / 14 不带零填充会被 DAY_KEY_RE 拒
  assert.equal(dayKey.isValidDayKey('2025-9-14'), false)
})

await test('isValidDayKey: "26-01-01" (2-digit year) → false', () => {
  // 关键防线：必须 4 位年份
  assert.equal(dayKey.isValidDayKey('26-01-01'), false)
})

await test('isValidDayKey: null → false', () => {
  assert.equal(dayKey.isValidDayKey(null), false)
})

await test('isValidDayKey: undefined → false', () => {
  assert.equal(dayKey.isValidDayKey(undefined), false)
})

await test('isValidDayKey: 123 (number) → false', () => {
  assert.equal(dayKey.isValidDayKey(123), false)
})

await test('isValidDayKey: {} (object) → false', () => {
  assert.equal(dayKey.isValidDayKey({}), false)
})

await test('isValidDayKey: [] (array) → false', () => {
  assert.equal(dayKey.isValidDayKey([]), false)
})

await test('isValidDayKey: "" (empty string) → false', () => {
  assert.equal(dayKey.isValidDayKey(''), false)
})

await test('isValidDayKey: "2025-01-01" → true (basic valid date)', () => {
  assert.equal(dayKey.isValidDayKey('2025-01-01'), true)
})

await test('isValidDayKey: "2025-12-31" → true (year boundary)', () => {
  assert.equal(dayKey.isValidDayKey('2025-12-31'), true)
})

// ===== Tests: isValidDayKeyLocal (local anchor) =====

await test('isValidDayKeyLocal: 2024-02-29 (leap year, local) → true', () => {
  // 与 isValidDayKey 同语义，但锚点本地时区
  assert.equal(dayKey.isValidDayKeyLocal('2024-02-29'), true)
})

await test('isValidDayKeyLocal: 2025-02-29 (non-leap) → false', () => {
  assert.equal(dayKey.isValidDayKeyLocal('2025-02-29'), false)
})

await test('isValidDayKeyLocal: 2025-02-30 → false', () => {
  assert.equal(dayKey.isValidDayKeyLocal('2025-02-30'), false)
})

await test('isValidDayKeyLocal: 2025-13-01 → false', () => {
  assert.equal(dayKey.isValidDayKeyLocal('2025-13-01'), false)
})

await test('isValidDayKeyLocal: "2025/01/01" → false (DAY_KEY_RE rejected first)', () => {
  assert.equal(dayKey.isValidDayKeyLocal('2025/01/01'), false)
})

await test('isValidDayKeyLocal: "2025-9-14" → false', () => {
  assert.equal(dayKey.isValidDayKeyLocal('2025-9-14'), false)
})

await test('isValidDayKeyLocal: null → false', () => {
  assert.equal(dayKey.isValidDayKeyLocal(null), false)
})

await test('isValidDayKeyLocal: {} → false', () => {
  assert.equal(dayKey.isValidDayKeyLocal({}), false)
})

await test('isValidDayKeyLocal: "2025-01-01" → true', () => {
  assert.equal(dayKey.isValidDayKeyLocal('2025-01-01'), true)
})

// ===== Tests: TZ 锚点差异（DST 边界防御） =====

await test('isValidDayKey vs isValidDayKeyLocal: identical results for most days (UTC vs local anchor same year-month-day)', () => {
  // 对绝大多数日期，UTC 锚点与本地锚点解析的 year/month/day 一致。
  // 仅在跨午夜 / DST 边界附近可能不同，但 YYYY-MM-DD 形式的字面日期
  // + T00:00:00 锚点会落在午夜整点，不跨日；这里断言二者对一组常见日期
  // 行为完全一致，避免有人改了 helper 时漂移。
  const samples = ['2024-02-29', '2025-01-01', '2025-12-31', '2026-06-15', '2026-09-14']
  for (const s of samples) {
    assert.equal(
      dayKey.isValidDayKey(s),
      dayKey.isValidDayKeyLocal(s),
      `UTC vs local disagree on ${s}`,
    )
  }
})

await test('isValidDayKeyLocal: TZ-locked +08:00 anchor yields midnight in +08:00 (no day drift)', () => {
  // 关键防线：TZ 已锁 +08:00，new Date('2025-01-01T00:00:00') 必须落在
  // 本地 1-1 00:00:00（不是 1-1 08:00:00Z 那种跨日）。getDate 必须=1。
  const dt = new Date('2025-01-01T00:00:00')
  assert.equal(dt.getFullYear(), 2025)
  assert.equal(dt.getMonth(), 0)
  assert.equal(dt.getDate(), 1)
  // 解析到正确的本地日
  assert.equal(dayKey.isValidDayKeyLocal('2025-01-01'), true)
})

await test('isValidDayKey: TZ-locked +08:00 anchor yields UTC midnight (no day drift)', () => {
  // 对照：isValidDayKey 用 T00:00:00.000Z 锚 UTC。在 +08:00 时区下，UTC
  // 1-1 00:00 = 本地 1-1 08:00，getUTCDate=1 还是同一天。验证 helper
  // 内部用 getUTCFullYear/getUTCMonth/getUTCDate 而非本地 accessor。
  const dt = new Date('2025-01-01T00:00:00.000Z')
  assert.equal(dt.getUTCFullYear(), 2025)
  assert.equal(dt.getUTCMonth(), 0)
  assert.equal(dt.getUTCDate(), 1)
  assert.equal(dayKey.isValidDayKey('2025-01-01'), true)
})
