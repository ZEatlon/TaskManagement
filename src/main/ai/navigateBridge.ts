/**
 * AI → 路由跳转桥接层
 *
 * 通过 `app:navigate` IPC 事件把「切换到某个路由」推给渲染端。渲染端
 * （由 Agent 5 在 ai store / App 层接线）监听该通道后调 react-router 的
 * navigate()。主进程这边**不感知** routes/ 的实现，只负责：
 *   1. 白名单校验路由（防 LLM 生成 `javascript:` / `//evil.com` /
 *      `../../` 这类会被 HashRouter 直接吞进 URL 的字符串）；
 *   2. 找到发起本次 AI 流的 webContents（多窗口时不要广播到别的窗口）；
 *   3. send 事件；
 *   4. R33-fix：await 渲染端回送的 `app:navigate-ack` 才返回 ok:true，
 *      避免「事件已发出但渲染端没监听 / router 未切」的乐观成功。
 *
 * 安全：路由字符串完全由 LLM 生成，属于不可信输入。这里用「固定
 * 路径白名单 + 受限 query 参数」双重校验，绝不透传任意字符串 ——
 * 渲染端拿到后是直接喂给 router 的，注入一个外部 URL 等于在应用内
 * 打开任意页面。
 */
import { webContents as electronWebContents, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { getCurrentCallerWebContentsId } from './tools'
import { isValidDayKey } from '@shared/lib/dayKey'
import log from '../log'

/** 允许跳转的路由路径（不含 query）。同时作为 schema enum 与运行时白名单的
 *  唯一权威源 —— 任何新增/删除合法路由必须同步两处，避免漂移。 */
export const ALLOWED_ROUTES: readonly string[] = [
  '/',
  '/today',
  '/notes',
  '/ai',
  '/settings',
] as const

const ALLOWED_ROUTES_SET: ReadonlySet<string> = new Set(ALLOWED_ROUTES)

/** app:navigate IPC 通道名（渲染端 preload 里监听同名通道）。
 *  R33-fix：常量与 channels.ts 同步，避免主进程发「app:navigate」但
 *  preload 监听了别名导致事件丢失。 */
export const NAVIGATE_CHANNEL = IPC_CHANNELS.AI_NAVIGATE

/**
 * R33-fix：等待渲染端 ack 的超时（毫秒）。超时仍按 ok:true 处理 —
 * 用户可能在 routing 未就绪（如 FirstRunWizard 阶段）就调了 navigate，
 * 但事件已送达、等待路由就绪时回送 ack 会失败；返回 ok:false 反而误报失败。
 * 仅在「明确报错」路径（白名单失败 / wc 不存在 / send 抛错）返回 ok:false。
 */
const NAVIGATE_ACK_TIMEOUT_MS = 1500

interface PendingNavigate {
  resolve: (focusApplied: boolean | null) => void
  timer: ReturnType<typeof setTimeout>
  /** R-fix-navigate-ack-cross-window-forgery (HIGH sender-validation)：
   *  记录发起本次 navigate 的 webContents.id，回 ack 时校验 sender 与之
   *  匹配。任意被劫持渲染端 / 跨窗口伪造 ack 都会被这里的 ownership
   *  守卫拒绝，防止"清掉别人的 pending / 喂 LLM 假 focusApplied"。 */
  ownerWcId: number
}

/** R33-fix：每个 navigate() 调用分配一个 callId，渲染端 ack 时带回，
 *  主进程按 callId 取出对应 promise resolve。允许同一 wc 上多次 navigate
 *  并发而不互相错乱（上一版用 wcId 单一 pending 时会丢 ack）。
 *  resolve 接受的 focusApplied 是渲染端 StickyTimeline 实际高亮结果：
 *  true=命中 / false=未命中 / null=未请求高亮（navigate 没带 focusStickyId）。 */
const pendingNavigates = new Map<string, PendingNavigate>()

/** ipcMain.handle 只能注册一次 — 模块加载时一次性挂上，后续 navigate
 *  调用都通过这张表查找 pending promise。重复 register 会抛 EEXIST。 */
let ackHandlerRegistered = false
function ensureAckHandlerRegistered(): void {
  if (ackHandlerRegistered) return
  ackHandlerRegistered = true
  ipcMain.handle(
    IPC_CHANNELS.AI_NAVIGATE_ACK,
    (
      event,
      payload?: { callId?: unknown; focusApplied?: unknown },
    ) => {
      const callId =
        payload && typeof payload === 'object' && typeof payload.callId === 'string'
          ? payload.callId
          : ''
      if (!callId) return { ok: true as const }
      const pending = pendingNavigates.get(callId)
      if (!pending) return { ok: true as const }
      // R-fix-navigate-ack-cross-window-forgery：拒绝非发起者 webContents
      // 的 ack。被劫持渲染端可在另一窗口伪造 {callId, focusApplied} 试图
      // 清掉别人的 pending 或注入假高亮结果。event.sender.id 是 IPC 边
      // 界由 Electron 注入的可信值，不受渲染端 payload 操控。
      const senderId = event.sender?.id
      if (typeof senderId !== 'number' || senderId !== pending.ownerWcId) {
        log.warn(
          `[ai/navigateBridge] ack sender mismatch: sender=${String(senderId)} owner=${pending.ownerWcId} callId=${callId}; refusing`,
        )
        return { ok: false, error: 'sender mismatch' } as const
      }
      clearTimeout(pending.timer)
      pendingNavigates.delete(callId)
      // focusApplied 仅在 navigate 时带了 focusStickyId 的路径下才会有值。
      // 渲染端 StickyTimeline 同步 querySelector 后通过 focus-sticky-result
      // CustomEvent 把结果回给 navigateBridge，由 navigateBridge 透传到 ack。
      // null → 未请求高亮；true → 命中；false → 未命中。
      const fa = payload?.focusApplied
      const focusApplied: boolean | null =
        fa === true ? true : fa === false ? false : null
      pending.resolve(focusApplied)
      return { ok: true as const }
    },
  )
}

export interface NavigateResult {
  ok: boolean
  error?: string
  route?: string
  focusStickyId?: string | null
  /**
   * 渲染端实际尝试 focusStickyId 高亮的结果（仅在 navigate 时带了
   * focusStickyId 时才返回 boolean；未传 focusStickyId 时为 null）：
   *   - true   命中（DOM 找到对应便签卡片，2.5s 高亮 + scrollIntoView）
   *   - false  未命中（便签不在当前 ±7 天窗口 / 已删除 / StickyTimeline 未挂载）
   *   - null   navigate 未请求高亮
   */
  focusApplied?: boolean | null
}

/** `/today?date=2025-01-02` → { path: '/today', date: '2025-01-02' } */
function parseRoute(raw: string): { path: string; date: string | null } | null {
  const s = raw.trim()
  if (!s.startsWith('/')) return null
  const qIdx = s.indexOf('?')
  const path = qIdx === -1 ? s : s.slice(0, qIdx)
  if (!ALLOWED_ROUTES_SET.has(path)) return null
  if (qIdx === -1) return { path, date: null }

  // 只认 `date=YYYY-MM-DD` 一个参数，其它一律丢弃（而不是拒绝整条路由，
  // LLM 常多带一个无害参数，静默丢弃比失败更可用）。
  const query = s.slice(qIdx + 1)
  for (const pair of query.split('&')) {
    const [k, v] = pair.split('=')
    if (k !== 'date') continue
    // R-fix-daykey-dedup (MEDIUM)：复用 @shared/lib/dayKey.isValidDayKey
    // 与 validators.parseSafeDayKey / completions.validateDayKey 共享
    // 同一权威源；真实日期判定（含 2025-02-30 之类伪日期拦截）在 helper 内。
    if (!isValidDayKey(v)) return null
    return { path, date: v }
  }
  return { path, date: null }
}

/**
 * 跳转到指定路由。
 *
 * R32-Corr-2 修复 (MEDIUM structure)：canonical 命名 navigateTo(route, focusStickyId?)，
 * 走 `bridge/types.ts` 的 BridgeResult<T> 联合返回。
 *
 * @param route         白名单内的路由，可带 `?date=YYYY-MM-DD`
 * @param focusStickyId 可选：跳转后需要高亮/滚动到的便签 ID
 */
export async function navigateTo(
  route: string,
  focusStickyId?: string | null,
): Promise<NavigateResult> {
  const parsed = parseRoute(String(route ?? ''))
  if (!parsed) {
    return {
      ok: false,
      error: `不支持的路由：${String(route).slice(0, 60)}。可选：/ , /today , /notes , /ai , /settings ，或 /today?date=YYYY-MM-DD`,
    }
  }

  const wcId = getCurrentCallerWebContentsId()
  if (wcId === null) {
    return { ok: false, error: '无法确定目标窗口（调用方上下文缺失）' }
  }
  const wc = electronWebContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) {
    return { ok: false, error: '目标窗口已关闭' }
  }

  const finalRoute = parsed.date ? `${parsed.path}?date=${parsed.date}` : parsed.path
  const sticky =
    typeof focusStickyId === 'string' && focusStickyId.trim() ? focusStickyId.trim() : null

  // R33-fix：分配 callId + 注册 pending ack。确保 ack handler 已挂载。
  ensureAckHandlerRegistered()
  const navCallId = `nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const ackPromise = new Promise<boolean | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingNavigates.delete(navCallId)
      // 超时仍 resolve（视为发送成功；事件本身没丢，渲染端稍后会自行应用）。
      // 未请求高亮 → null；请求了高亮但渲染端没回 focusApplied（极少：sticky
      // timeline 未挂载 / 渲染端 bug）→ false（保守按"未命中"处理，避免 LLM
      // 以为高亮成功而告诉用户"已跳转到便签 X"）。
      resolve(sticky === null ? null : false)
    }, NAVIGATE_ACK_TIMEOUT_MS)
    pendingNavigates.set(navCallId, { resolve, timer, ownerWcId: wcId })
  })

  try {
    wc.send(NAVIGATE_CHANNEL, {
      route: finalRoute,
      focusStickyId: sticky,
      callId: navCallId,
    })
  } catch (err) {
    const pending = pendingNavigates.get(navCallId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingNavigates.delete(navCallId)
    }
    log.warn('[ai/navigateBridge] send failed', err)
    return { ok: false, error: '导航事件发送失败' }
  }

  // R33-fix：await 渲染端 ack 后才返回 ok:true。超时仍按 ok:true 处理
  // （用户可能路由未就绪，事件已送达，下一次就绪时由 UI 自行应用）。
  const focusApplied = await ackPromise

  log.info(
    `[ai/navigateBridge] navigate → ${finalRoute} focusStickyId=${sticky ?? 'null'} focusApplied=${focusApplied === null ? 'null' : String(focusApplied)}`,
  )
  return { ok: true, route: finalRoute, focusStickyId: sticky, focusApplied }
}
