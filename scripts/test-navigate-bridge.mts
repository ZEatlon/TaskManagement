/**
 * navigateBridge.ts 的 parseRoute + navigateTo 防线单测 —— 覆盖 ALLOWED_ROUTES
 * 白名单、日期真实性校验、多 query 参数丢弃逻辑。
 *
 * 关键防线（见 src/main/ai/navigateBridge.ts line 111-140）：
 *   1. ALLOWED_ROUTES_SET 白名单（防 javascript: / //evil.com 注入到 router）
 *   2. 日期 regex /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ + 真实存在校验（挡 2025-02-30
 *      / 2025-13-01 等不存在日历日）
 *   3. 多 query 参数静默丢弃未知项，只保留 date（不整条拒绝；LLM 常多带
 *      无害参数，宽松处理比失败更可用）
 *
 * 设计：
 *   - scripts/test-loader.mjs 把 navigateBridge.ts 的依赖（electron /
 *     ./tools / ../log）替换成 in-memory 桩。wc.fromId 读 globalThis 上的
 *     fake webContents；getCurrentCallerWebContentsId 由 navigateTools
 *     stub 直接读 globalThis.__test_callerWebContentsId。
 *   - 成功路径：测试预设 wcId + fake wc（含 send 捕获），调 navigateTo 后
 *     从 wc.send 的 capture 拿到 callId，再用注册到 __test_ipcHandlers
 *     ['app:navigate-ack'] 的 handler 模拟渲染端 ack。这样不依赖 1.5s 超时。
 *   - parseRoute 是 navigateTo 内部函数，失败路径在 wc 检查之前就 return
 *     ok:false —— 所以「无效路由 / 非法日期」测试不需要预设 wc。
 *   - .mts 后缀让 Node 把测试文件当 ESM 处理（顶层 await + import()）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== 类型 =====

interface FakeWc {
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}
interface SendCall {
  channel: string
  payload: { route?: string; focusStickyId?: string | null; callId?: string }
}

// ===== globalThis 注入 =====

;(globalThis as { __test_webContents?: Record<number, FakeWc> }).__test_webContents = {}
;(globalThis as { __test_callerWebContentsId?: number | null }).__test_callerWebContentsId = null
;(globalThis as { __test_ipcHandlers?: Record<string, unknown> }).__test_ipcHandlers = {}
;(globalThis as { __test_aiToolsCalls?: unknown[] }).__test_aiToolsCalls = []

function sendCalls(): SendCall[] {
  return ((globalThis as { __test_navigateSendCalls?: SendCall[] }).__test_navigateSendCalls ?? [])
}
function installFakeWc(wcId: number): { captured: SendCall[] } {
  const captured: SendCall[] = []
  const wc: FakeWc = {
    isDestroyed: () => false,
    send(channel, payload) {
      captured.push({ channel, payload: payload as SendCall['payload'] })
      ;(globalThis as { __test_navigateSendCalls?: SendCall[] }).__test_navigateSendCalls = captured
    },
  }
  ;(globalThis as { __test_webContents?: Record<number, FakeWc> }).__test_webContents = { [wcId]: wc }
  return { captured }
}

function resetAll(): void {
  ;(globalThis as { __test_webContents?: Record<number, FakeWc> }).__test_webContents = {}
  ;(globalThis as { __test_callerWebContentsId?: number | null }).__test_callerWebContentsId = null
  ;(globalThis as { __test_aiToolsCalls?: unknown[] }).__test_aiToolsCalls = []
  ;(globalThis as { __test_navigateSendCalls?: SendCall[] }).__test_navigateSendCalls = []
  // 注意：__test_ipcHandlers 不重置 —— navigateBridge 模块顶层有
  // ackHandlerRegistered 一次性 flag（注册完就不再 ipcMain.handle）。第
  // 一个测试触发注册，后续测试 resetAll 不会重注册。保留 ipcHandlers 让
  // 我们的 waitForAck 始终能拿到 app:navigate-ack handler。
}

/**
 * 模拟渲染端 ack —— 让 navigateTo 里的 ackPromise 立即 resolve。
 * 返回 callId + focusApplied（true=命中 / false=未命中 / null=未请求高亮）。
 */
async function waitForAck(): Promise<{ callId: string; channel: string; payload: SendCall['payload'] }> {
  // 等到 wc.send 被调（最多 200ms）。正常情况下 send 在 navigateTo 进入 await 之前就发生，
  // 用 setImmediate 把控制权让给事件循环让 send 调用落进 captured。
  for (let i = 0; i < 50; i++) {
    const list = sendCalls()
    if (list.length > 0) {
      const last = list[list.length - 1]
      const callId = String(last?.payload?.callId ?? '')
      if (!callId) throw new Error('send call did not contain callId')
      const ackHandler = (globalThis as {
        __test_ipcHandlers?: Record<string, (e: unknown, p: unknown) => unknown>
      }).__test_ipcHandlers?.['app:navigate-ack']
      if (typeof ackHandler !== 'function') {
        throw new Error('AI_NAVIGATE_ACK handler not registered by navigateTo')
      }
      ackHandler({}, { callId, focusApplied: true })
      // 让 await ackPromise 恢复 + 走到 log + return
      await new Promise((r) => setImmediate(r))
      return { callId, channel: last?.channel ?? '', payload: last?.payload ?? {} }
    }
    await new Promise((r) => setTimeout(r, 4))
  }
  throw new Error('timeout waiting for wc.send')
}

// ===== 加载被测模块 =====
const navBridge = await import('../src/main/ai/navigateBridge.ts')

// ===== Tests: parseRoute failure (no wc setup needed) =====

await test('parseRoute: protocol-relative URL //evil.com → ok:false before wc check', async () => {
  resetAll()
  const result = await navBridge.navigateTo('//evil.com')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持的路由/)
})

await test('parseRoute: javascript: scheme → ok:false', async () => {
  resetAll()
  const result = await navBridge.navigateTo('javascript:alert(1)')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持的路由/)
})

await test('parseRoute: unknown path /not-a-real-route → ok:false', async () => {
  resetAll()
  const result = await navBridge.navigateTo('/not-a-real-route')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持的路由/)
})

await test('parseRoute: 2025-02-30 (Feb 30 does not exist) → ok:false', async () => {
  resetAll()
  const result = await navBridge.navigateTo('/today?date=2025-02-30')
  assert.equal(result.ok, false, 'Feb 30 must be rejected as a non-existent calendar day')
  assert.match(result.error ?? '', /不支持的路由/)
})

await test('parseRoute: month=13 → ok:false', async () => {
  resetAll()
  const result = await navBridge.navigateTo('/today?date=2025-13-01')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持的路由/)
})

await test('parseRoute: day=00 → ok:false', async () => {
  resetAll()
  const result = await navBridge.navigateTo('/today?date=2025-01-00')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持的路由/)
})

await test('parseRoute: malformed date (not ISO) → ok:false', async () => {
  resetAll()
  const result = await navBridge.navigateTo('/today?date=2025/01/01')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持的路由/)
})

// ===== Tests: parseRoute success (need wc + ack) =====

const WC_ID = 11

async function setupWcAndCaller(): Promise<{ captured: SendCall[] }> {
  const { captured } = installFakeWc(WC_ID)
  ;(globalThis as { __test_callerWebContentsId?: number | null }).__test_callerWebContentsId = WC_ID
  return { captured }
}

await test('parseRoute: /today without query → ok:true, route=/today, date=null', async () => {
  resetAll()
  await setupWcAndCaller()
  const result = await navBridge.navigateTo('/today')
  // 等 send + ack
  const ack = await waitForAck()
  // 给 await ackPromise 恢复时间
  await new Promise((r) => setImmediate(r))
  assert.equal(result.ok, true)
  assert.equal(result.route, '/today')
  assert.equal(result.focusStickyId, null)
  // send 收到的 payload 中 route 就是 /today，没有 ?date=
  assert.equal(ack.payload?.route, '/today')
})

await test('parseRoute: /today?date=2026-09-14 → ok:true, date echoed back', async () => {
  resetAll()
  const { captured } = await setupWcAndCaller()
  const result = await navBridge.navigateTo('/today?date=2026-09-14', null)
  const ack = await waitForAck()
  await new Promise((r) => setImmediate(r))
  assert.equal(result.ok, true)
  assert.equal(result.route, '/today?date=2026-09-14')
  assert.equal(ack.payload?.route, '/today?date=2026-09-14')
  assert.equal(captured.length, 1)
})

await test('parseRoute: ?evil=1&date=2026-09-14 → unknown param silently dropped, date kept', async () => {
  resetAll()
  await setupWcAndCaller()
  const result = await navBridge.navigateTo('/today?evil=1&date=2026-09-14')
  const ack = await waitForAck()
  await new Promise((r) => setImmediate(r))
  assert.equal(result.ok, true)
  // evil 静默丢弃：路由只含 date=
  assert.equal(ack.payload?.route, '/today?date=2026-09-14')
  assert.equal(result.route, '/today?date=2026-09-14')
  // critically: no rejection —— LLM 常多带无害参数，静默丢弃比失败更可用
})

await test('parseRoute: ?date=2026-09-14&evil=1 → unknown param dropped regardless of order', async () => {
  resetAll()
  await setupWcAndCaller()
  const result = await navBridge.navigateTo('/today?date=2026-09-14&evil=1')
  const ack = await waitForAck()
  await new Promise((r) => setImmediate(r))
  assert.equal(result.ok, true)
  assert.equal(ack.payload?.route, '/today?date=2026-09-14')
})

await test('parseRoute: ?date only with no value → ok:false (regex fails on empty)', async () => {
  resetAll()
  const result = await navBridge.navigateTo('/today?date=')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持的路由/)
})

await test('parseRoute: ?date=2026-02-29 (leap year) → ok:true', async () => {
  resetAll()
  await setupWcAndCaller()
  const result = await navBridge.navigateTo('/today?date=2024-02-29')
  const ack = await waitForAck()
  await new Promise((r) => setImmediate(r))
  assert.equal(result.ok, true, '2024 is a leap year — Feb 29 must be accepted')
  assert.equal(ack.payload?.route, '/today?date=2024-02-29')
})

// =====================================================================
// Tests: navigateTo 1500ms ack timeout path + wc.isDestroyed() race
// （navigateBridge.ts:161 / 173-180）
// =====================================================================

await test('navigateTo: 1500ms timeout with no ack → ok:true + focusApplied=null (sticky==null)', async () => {
  resetAll()
  await setupWcAndCaller()
  // 不调 waitForAck —— 让 setTimeout(navigateBridge.ts:173) 自然 fire
  const start = Date.now()
  const result = await navBridge.navigateTo('/today')
  const elapsed = Date.now() - start
  // 关键防线：超时仍按 ok:true 处理（line 200-207），错误文案仅在白名单
  // 失败 / wc 不存在 / send 抛错时返 ok:false。focusApplied 在 sticky==null
  // 时按 null 返回（line 179），避免 LLM 误以为高亮成功。
  assert.equal(result.ok, true, 'timeout must still return ok:true')
  assert.equal(result.focusApplied, null, 'no focus request → null (not false, not true)')
  assert.ok(elapsed >= 1500, `must wait at least 1500ms; got ${elapsed}ms`)
  assert.ok(elapsed < 2000, `must not wait too long; got ${elapsed}ms`)
})

await test('navigateTo: 1500ms timeout with focusStickyId but no ack → focusApplied=false (not null)', async () => {
  resetAll()
  await setupWcAndCaller()
  const start = Date.now()
  const result = await navBridge.navigateTo('/today', 'abc-sticky-id-123')
  const elapsed = Date.now() - start
  // 关键防线：sticky != null + 超时 → focusApplied=false（line 179），
  // 区别于「未请求高亮 → null」。false 让 LLM 知道「点了高亮但没命中」
  // （比如便签不在 ±7 天窗口里 / StickyTimeline 未挂载），而不是误以为
  // 高亮成功。
  assert.equal(result.ok, true, 'timeout still returns ok:true')
  assert.equal(result.focusApplied, false, 'focus requested but no ack → false (not null)')
  assert.ok(elapsed >= 1500, `must wait at least 1500ms; got ${elapsed}ms`)
})

await test('navigateTo: wc.isDestroyed() returns true → ok:false "目标窗口已关闭"', async () => {
  resetAll()
  const wcId = 13
  // fake wc 在 wc.fromId 拿到时就 isDestroyed=true —— 模拟「渲染端窗口已
  // 关闭但 caller 上下文还残留」的场景（line 161 检查）。
  const fakeWc: FakeWc = {
    isDestroyed: () => true,
    send: () => {
      throw new Error('send must NOT be called on destroyed wc')
    },
  }
  ;(globalThis as { __test_webContents?: Record<number, FakeWc> }).__test_webContents = { [wcId]: fakeWc }
  ;(globalThis as { __test_callerWebContentsId?: number | null }).__test_callerWebContentsId = wcId
  const result = await navBridge.navigateTo('/today')
  // 关键防线：wc.isDestroyed() → 直接 return ok:false '目标窗口已关闭'，
  // 不进 pendingNavigates.set + setTimeout（避免 pending entry 泄漏）。
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /目标窗口已关闭/)
})
