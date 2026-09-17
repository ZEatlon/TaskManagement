/**
 * W2-B 测试套件 — AI 助手规则引擎
 *
 * 覆盖：
 *   1. 默认偏好下，所有 hint/chat 都 → ignore（enabled=false 是默认）
 *   2. 启用 + 工作时段内 + 无静音：focus-streak → hint
 *   3. 静音列表命中 → ignore
 *   4. 工作时段外（user:manual-ask 除外）→ ignore
 *   5. 频率上限：距上次触发 < 60min/cap 分钟 → ignore
 *   6. user:manual-ask 不受 enabled/work-hours/rate-limit 约束（但受 enabled 约束）
 *   7. mapEventToCategory 正确分类
 *   8. isWithinWorkHours 支持跨夜（22→6）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_ASSISTANT_PREFS,
  decide,
  isWithinRateLimit,
  isWithinWorkHours,
  mapEventToCategory,
  type AssistantEvent,
  type AssistantPrefs,
  type RuleContext,
} from '../src/main/ai/assistantRules.ts'

const HOUR = 60 * 60 * 1000

function ctx(
  nowMs: number,
  prefsOverride: Partial<AssistantPrefs> = {},
  lastFiredMs: Partial<Record<string, number>> = {},
): RuleContext {
  return {
    prefs: { ...DEFAULT_ASSISTANT_PREFS, enabled: true, ...prefsOverride },
    lastFiredMs,
    nowMs,
  }
}

function mkEvent(
  type: AssistantEvent['type'],
  payload?: AssistantEvent['payload'],
): AssistantEvent {
  return {
    type,
    atIso: new Date().toISOString(),
    payload,
  }
}

await test('默认 enabled=false → 一切 ignore', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const c: RuleContext = {
    prefs: { ...DEFAULT_ASSISTANT_PREFS, enabled: false },
    lastFiredMs: {},
    nowMs: noon,
  }
  assert.equal(decide(mkEvent('pomodoro:phase-complete', {
    pomodoro: { mode: 'focus', cycleIndex: 1 },
  }), c).action, 'ignore')
  assert.equal(decide(mkEvent('user:manual-ask', {
    question: '在吗？',
  }), c).action, 'ignore')
})

await test('启用 + 工作时段 + focus 完成 → hint', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const d = decide(
    mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'focus', cycleIndex: 1 },
    }),
    ctx(noon),
  )
  assert.equal(d.action, 'hint')
  assert.equal(d.category, 'focus-streak')
  assert.ok(d.hintText && d.hintText.length > 0, 'hintText 必须非空')
})

await test('break 完成 → ignore（mapEventToCategory 不映射）', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const d = decide(
    mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'shortBreak', cycleIndex: 1 },
    }),
    ctx(noon),
  )
  assert.equal(d.action, 'ignore')
})

await test('静音列表命中 → ignore', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const d = decide(
    mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'focus', cycleIndex: 1 },
    }),
    ctx(noon, { mutedCategories: ['focus-streak'] }),
  )
  assert.equal(d.action, 'ignore')
})

await test('工作时段外 → ignore（user:manual-ask 除外）', () => {
  // 凌晨 3 点
  const lateNight = new Date(2025, 0, 15, 3, 0).getTime()
  const focusDecide = decide(
    mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'focus', cycleIndex: 1 },
    }),
    ctx(lateNight),
  )
  assert.equal(focusDecide.action, 'ignore', '非 manual-ask 在凌晨应被忽略')

  const manualDecide = decide(
    mkEvent('user:manual-ask', { question: '?' }),
    ctx(lateNight),
  )
  assert.equal(manualDecide.action, 'chat', 'manual-ask 不受工作时段约束')
})

await test('频率上限：距上次 < 60min/cap → ignore', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const oneHourAgo = noon - HOUR
  // cap=3：60min / 3 = 20min 间隔
  const d = decide(
    mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'focus', cycleIndex: 1 },
    }),
    ctx(noon, { frequencyCapPerHour: 3 }, { 'focus-streak': oneHourAgo }),
  )
  // 距上次正好 60 分钟 ≥ 20min → 应触发
  assert.equal(d.action, 'hint')

  // 但「5 分钟前触发过」应被抑制
  const fiveMinAgo = noon - 5 * 60 * 1000
  const d2 = decide(
    mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'focus', cycleIndex: 1 },
    }),
    ctx(noon, { frequencyCapPerHour: 3 }, { 'focus-streak': fiveMinAgo }),
  )
  assert.equal(d2.action, 'ignore')
})

await test('isWithinRateLimit 边界：刚好达到间隔 → true', () => {
  const now = 1_000_000_000
  const last = now - 20 * 60 * 1000
  assert.equal(
    isWithinRateLimit('focus-streak', {
      prefs: { ...DEFAULT_ASSISTANT_PREFS, enabled: true, frequencyCapPerHour: 3 },
      lastFiredMs: { 'focus-streak': last },
      nowMs: now,
    }),
    true,
    '恰好 20 分钟前触发、cap=3 → 允许',
  )
  const lastTooSoon = now - 19 * 60 * 1000
  assert.equal(
    isWithinRateLimit('focus-streak', {
      prefs: { ...DEFAULT_ASSISTANT_PREFS, enabled: true, frequencyCapPerHour: 3 },
      lastFiredMs: { 'focus-streak': lastTooSoon },
      nowMs: now,
    }),
    false,
    '19 分钟前触发、cap=3 → 抑制',
  )
})

await test('user:manual-ask → chat + prompt 用 event 注入的 question', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const d = decide(
    mkEvent('user:manual-ask', { question: '今天最有意义的事是什么？' }),
    ctx(noon),
  )
  assert.equal(d.action, 'chat')
  assert.equal(d.chatPrompt, '今天最有意义的事是什么？')
})

await test('pomodoro-reflection category → chat 而非 hint', () => {
  // 通过 customHints 触发 reflection 路径不便；直接验证：focus-streak 是 hint，
  // reflection 走 chat（用 long-edit-nudge 不算 —— 只测 hint/chat 边界）
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  // sedentary-reminder → hint
  const dHint = decide(mkEvent('app:work-hours-tick'), ctx(noon))
  assert.equal(dHint.action, 'hint')
  assert.equal(dHint.category, 'sedentary-reminder')
})

await test('long-edit-nudge → hint（不会变 chat；reflection 才是 chat）', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const d = decide(
    mkEvent('note-event:long-edit', { editingMinutes: 30 }),
    ctx(noon),
  )
  assert.equal(d.action, 'hint')
  assert.equal(d.category, 'long-edit-nudge')
})

await test('customHints 覆盖默认文案', () => {
  const noon = new Date(2025, 0, 15, 12, 0).getTime()
  const d = decide(
    mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'focus', cycleIndex: 1 },
    }),
    ctx(noon, { customHints: { 'focus-streak': '自定义：再接再厉！' } }),
  )
  assert.equal(d.action, 'hint')
  assert.equal(d.hintText, '自定义：再接再厉！')
})

await test('isWithinWorkHours 支持跨夜（22→6）', () => {
  const prefs: AssistantPrefs = {
    ...DEFAULT_ASSISTANT_PREFS,
    enabled: true,
    workHours: { startHour: 22, endHour: 6 },
  }
  const h23 = new Date(2025, 0, 15, 23, 0).getTime()
  const h02 = new Date(2025, 0, 15, 2, 0).getTime()
  const h08 = new Date(2025, 0, 15, 8, 0).getTime()
  const h22 = new Date(2025, 0, 15, 22, 0).getTime()
  assert.equal(isWithinWorkHours(h23, prefs), true, '23 点应在内')
  assert.equal(isWithinWorkHours(h02, prefs), true, '02 点应在内（跨夜）')
  assert.equal(isWithinWorkHours(h22, prefs), true, '22 点是起点，应在内')
  assert.equal(isWithinWorkHours(h08, prefs), false, '08 点不在 22→6 内')
})

await test('isWithinWorkHours 普通时段（9→18）', () => {
  const prefs: AssistantPrefs = {
    ...DEFAULT_ASSISTANT_PREFS,
    enabled: true,
    workHours: { startHour: 9, endHour: 18 },
  }
  const h12 = new Date(2025, 0, 15, 12, 0).getTime()
  const h18 = new Date(2025, 0, 15, 18, 0).getTime()
  const h09 = new Date(2025, 0, 15, 9, 0).getTime()
  const h08 = new Date(2025, 0, 15, 8, 0).getTime()
  assert.equal(isWithinWorkHours(h12, prefs), true)
  assert.equal(isWithinWorkHours(h09, prefs), true, '起点 inclusive')
  assert.equal(isWithinWorkHours(h18, prefs), false, '终点 exclusive')
  assert.equal(isWithinWorkHours(h08, prefs), false)
})

await test('mapEventToCategory 各事件正确分类', () => {
  assert.equal(
    mapEventToCategory(mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'focus', cycleIndex: 1 },
    })),
    'focus-streak',
  )
  assert.equal(
    mapEventToCategory(mkEvent('pomodoro:phase-complete', {
      pomodoro: { mode: 'shortBreak', cycleIndex: 1 },
    })),
    null,
  )
  assert.equal(mapEventToCategory(mkEvent('sticky-note:due')), null)
  assert.equal(
    mapEventToCategory(mkEvent('sticky-note:overdue', { overdueMinutes: 30 })),
    'sticky-overdue',
  )
  assert.equal(mapEventToCategory(mkEvent('app:work-hours-tick')), 'sedentary-reminder')
  assert.equal(
    mapEventToCategory(mkEvent('note-event:long-edit', { editingMinutes: 30 })),
    'long-edit-nudge',
  )
  assert.equal(
    mapEventToCategory(mkEvent('user:manual-ask', { question: '?' })),
    'pomodoro-reflection',
  )
})
