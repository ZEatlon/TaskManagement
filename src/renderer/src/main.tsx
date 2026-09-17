/**
 * 渲染进程入口
 * 创建 React 根，挂载 Router
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from './router'
import { installPomodoroListeners } from './stores/pomodoro'
import { installAiListeners } from './stores/ai'
import { installNotifyDiagnosticsListeners } from './stores/notify'
import { useGitStore } from './stores/git'
import {
  setAppRouter,
  installNavigateListener,
} from './lib/navigateBridge'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { AINotificationHost } from './components/ai/AINotificationHost'
import { AriaAnnouncerMount } from './components/common/AriaAnnouncer'
import './styles/index.css'
import './styles/tasks.css'
import './styles/library.css'
import './styles/git.css'
import './styles/pomodoro.css'
import './styles/settings.css'
import './styles/editor.css'
import './styles/ai.css'
import './styles/notes.css'
import './styles/today.css'
import './styles/sticky-notes.css'
import './styles/clock.css'

const router = createAppRouter()
// R33-fix：把 router 实例注入到 lib/navigateBridge，AI navigate 工具的
// `app:navigate` 事件会通过它调 router.navigate()。必须在 installNavigateListener
// 之前调用，否则 listener 收到的首条事件会因 router 为 null 而 no-op。
setAppRouter(router)

// W3-A 一次性清理：Dashboard widget 编辑器已在 W2-C① 下线、路由在 W3-A
// 注销，但旧 localStorage key（如 `dashboard.layout.v5`）仍可能残留在用户
// profile 里，污染未来的 store 重命名空间 / 让人怀疑 widget 编辑器是不是
// 被某个 if 分支偷偷复活。启动时扫一遍 localStorage，匹配 `dashboard.*`
// 前缀的全部清掉。仅此一次，未来若再加 widget 编辑器应走独立前缀。
if (typeof localStorage !== 'undefined') {
  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('dashboard.')) keysToRemove.push(k)
    }
    for (const k of keysToRemove) localStorage.removeItem(k)
  } catch {
    /* localStorage 不可用（隐私模式 / 极端配置）吞掉 */
  }
}

/**
 * H4 修复 (high reliability)：原版 installPomodoroListeners /
 * installAiListeners / useGitStore.getState().init() 任一抛错都会让整个
 * React 树挂不上 —— 用户看到的就是一个完全空白、连错误提示都没有的窗口。
 * 这里把每个 setup 步骤用 try/catch 包起来，单独失败不影响其他模块的
 * 挂载（番茄钟 store 初始化失败 → AI 流监听还能继续；git store 初始化
 * 失败 → 用户仍能看到 Tasks / Notes，只是同步指示器一直 idle）。
 */
function safeInstall(label: string, fn: () => () => void): (() => void) | null {
  try {
    return fn()
  } catch (err) {
    console.error(`[main] failed to install ${label}`, err)
    // 上报主进程 boot-trace，便于事后定位
    try {
      void window.api?.invoke('app:error', {
        message: `[main] install ${label} failed`,
        stack: err instanceof Error ? err.stack : null,
        componentStack: null,
      })
    } catch {
      /* boot-trace 上报失败吞掉 */
    }
    return null
  }
}

// 安装番茄钟事件监听（主进程推送 -> store）
const disposePomodoroListeners = safeInstall('pomodoro listeners', installPomodoroListeners)

// 安装 AI 流事件监听（主进程推送 -> store）
const disposeAiListeners = safeInstall('ai listeners', installAiListeners)

// 安装通知失败诊断监听（NOTIFY_PERSIST_FAILED / NOTIFY_TOAST_FAILED）。
// 这两条通道历史上 main 进程有 emit 但渲染端 0 订阅者，用户漏看
// 通知 / OS toast 弹失败时排查无门。订阅到 useNotifyDiagnosticsStore，
// UI 可在支持 bundle / 调试面板导出最近一次失败 payload。
const disposeNotifyDiagnosticsListeners = safeInstall(
  'notify diagnostics listeners',
  installNotifyDiagnosticsListeners,
)

// R33-fix：安装 AI navigate 事件监听（主进程 app:navigate -> router.navigate）。
// 必须在 router 实例注入之后安装；不需要 React 树就绪，模块级监听即可。
const disposeNavigateListener = safeInstall('navigate listener', installNavigateListener)

// 初始化 git store：注册主进程推送事件 + 拉取初始状态
// 必须在此处调用，否则主进程推送的 GIT_STATE_CHANGED / SYNC_START / SYNC_END / SYNC_ERROR
// 事件在渲染端无人订阅，UI 永远停留在 'idle'，同步指示器不会响应 autoSync。
try {
  void useGitStore.getState().init()
} catch (err) {
  console.error('[main] failed to init git store', err)
  try {
    void window.api?.invoke('app:error', {
      message: '[main] git store init failed',
      stack: err instanceof Error ? err.stack : null,
      componentStack: null,
    })
  } catch {
    /* boot-trace 上报失败吞掉 */
  }
}

import.meta.hot?.dispose(() => {
  disposePomodoroListeners?.()
  disposeAiListeners?.()
  disposeNavigateListener?.()
  disposeNotifyDiagnosticsListeners?.()
  useGitStore.getState().dispose()
})

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element not found')
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    {/* R7S-2：顶层 ErrorBoundary 包住 Router —— 任何子树 render 抛错
        都不会让整个 UI 空白，至少显示错误卡片并提供恢复按钮。 */}
    <ErrorBoundary>
      <RouterProvider router={router} />
      {/* R8A-5/R8A-6：全局 aria-live 公告器，屏幕阅读器用户也能感知到
          后台状态变化（"已创建便签"、"已删除笔记"等）。 */}
      <AriaAnnouncerMount />
      {/* W2-B：AI 助手 daemon 的 hint toast 容器 + chat 触发跳转。
          挂在 RouterProvider 之外、ErrorBoundary 之内的「旁路」位置，
          toast 不受路由切换影响、抛错也不会让整个 UI 空白。 */}
      <AINotificationHost />
    </ErrorBoundary>
  </React.StrictMode>,
)