/**
 * 渲染端 AI navigate 桥接层
 *
 * R33-fix：主进程 navigateBridge.ts 通过 `app:navigate` 通道把跳转指令
 * 推到渲染端。本模块负责：
 *   1. 监听 `app:navigate`（preload 已经把通道转成 window.api.ai.onNavigate）；
 *   2. 调 react-router 的 navigate()；
 *   3. 路由实际切完后通过 `app:navigate-ack` 回送 ack，主进程 await 后才
 *      返回 ok:true。
 *
 * 单例持有 router 实例：createAppRouter() 在 main.tsx 顶层创建，本模块
 * 通过 setAppRouter() 接收，避免循环依赖（lib/ 已被 routes 引用）。
 */
import type { createAppRouter } from '../router'

/** main.tsx 创建的 router 实例类型。显式 import-type 而非 `Router<...>`
 *  泛型 — 避免 tanstack-router 5-参 generic 在不同版本下签名差异。 */
type AppRouter = ReturnType<typeof createAppRouter>

let appRouter: AppRouter | null = null

/**
 * 把 main.tsx 创建的 router 实例注入进来。HMR 时也会再次注入——只需
 * 把新 router 替换旧值，无需 dispose（listener 仍指向已 unmount 的旧 router
 * 会 no-op，因为新 router 一旦注入就覆盖）。
 */
export function setAppRouter(router: AppRouter): void {
  appRouter = router
}

function getAppRouter(): AppRouter | null {
  return appRouter
}

/**
 * 安装 AI navigate 事件监听。由 main.tsx 在 React 根挂载之前调用一次，
 * 返回的解绑函数供 HMR dispose 使用。
 *
 * 为什么放在 main.tsx 而非某个组件的 useEffect：
 *   - 监听器必须存活到应用生命周期结束（任何时刻 LLM 都可能调 navigate）；
 *   - useEffect 在组件 unmount 时会被 dispose —— 一旦用户在 AI 流式过程中
 *     切换路由（Router 卸载部分子树）就可能丢监听；
 *   - 单例模式 + 模块级函数最稳。
 */

/** 等待 StickyTimeline 上报高亮结果的超时。StickyTimeline 是同步 querySelector
 *  后立刻 dispatch 结果事件的，正常情况下几 ms 内返回；给 500ms 足以覆盖主
 * 线程繁忙 / sticky timeline 刚挂载但尚未完成首次 fetch 等边角情况。 */
const FOCUS_RESULT_TIMEOUT_MS = 500

/**
 * 等待 StickyTimeline 通过 taskpilot:focus-sticky-result CustomEvent 上报
 * 高亮结果。若 sticky timeline 未挂载（当前不在 StickyTimeline 页面）或
 * 等待超时，则视为未命中（applied=false），让主进程如实告诉 LLM。
 */
function waitForFocusResult(stickyNoteId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ stickyNoteId?: unknown; applied?: unknown }>).detail
      if (!detail || typeof detail !== 'object') return
      if (detail.stickyNoteId !== stickyNoteId) return
      window.removeEventListener('taskpilot:focus-sticky-result', handler)
      window.clearTimeout(timer)
      resolve(detail.applied === true)
    }
    window.addEventListener('taskpilot:focus-sticky-result', handler)
    const timer = window.setTimeout(() => {
      window.removeEventListener('taskpilot:focus-sticky-result', handler)
      resolve(false)
    }, FOCUS_RESULT_TIMEOUT_MS)
  })
}

export function installNavigateListener(): () => void {
  if (typeof window === 'undefined' || !window.api?.ai?.onNavigate) {
    return () => {}
  }
  const dispose = window.api.ai.onNavigate((_event, payload) => {
    const { route, focusStickyId, callId } = payload
    const router = getAppRouter()
    if (!router) {
      // 路由未就绪（例如 FirstRunWizard 阶段）：仍回 ack 让主进程别阻塞，
      // 等 router 就绪后由用户手动操作即可（AI 提示用户「正在跳转到 X」
      // 已经是合理 UX；真正"页面没动"的死锁只会出现在 router 已就绪
      // 却没绑监听——本模块的 installNavigateListener 就是在根上兜底）。
      void window.api.ai.ackNavigate({ callId, focusApplied: null })
      return
    }

    // 把 `?date=YYYY-MM-DD` 拆成 search（react-router 内存模式不解析 query）
    const qIdx = route.indexOf('?')
    const to = qIdx === -1 ? route : route.slice(0, qIdx)
    const queryStr = qIdx === -1 ? '' : route.slice(qIdx + 1)
    const search: Record<string, unknown> = {}
    if (queryStr) {
      for (const pair of queryStr.split('&')) {
        const [k, v] = pair.split('=')
        if (!k) continue
        // 路由字符串由主进程白名单校验过，这里只解析不过滤；
        // 多带其它参数会被静默丢弃（同主进程 parseRoute 行为）。
        search[k] = v ?? ''
      }
    }

    // 触发 router.navigate。tanstack router 的 navigate 是 async —— 等待
    // 它完成再回 ack。如果失败（极罕见，如路径无效），仍回 ack 让主进程
    // 别阻塞，否则 LLM 整轮 stream 会被卡死。
    void router
      .navigate({ to, search })
      .catch((err) => {
        console.error('[navigateBridge] router.navigate failed:', err)
      })
      .finally(async () => {
        // 通知上层滚动 / 高亮：自定义事件，sticky timeline 自行订阅
        // （避免本模块反向依赖 sticky notes store）。focusStickyId 为
        // null 时跳过等待（navigate 未请求高亮），ack 也直接传 null。
        let focusApplied: boolean | null = null
        if (focusStickyId) {
          window.dispatchEvent(
            new CustomEvent('taskpilot:focus-sticky', {
              detail: { stickyNoteId: focusStickyId },
            }),
          )
          focusApplied = await waitForFocusResult(focusStickyId)
        }
        void window.api.ai.ackNavigate({ callId, focusApplied })
      })
  })
  return dispose
}
