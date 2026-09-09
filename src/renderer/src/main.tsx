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
import { useGitStore } from './stores/git'
import { ErrorBoundary } from './components/common/ErrorBoundary'
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
/* dashboard.css 必须放在 pomodoro.css 之后 —— 让嵌入态 .is-embedded 覆盖
   pomodoro.css 里的玻璃感 backdrop-filter / box-shadow 等重样式。 */
import './styles/dashboard.css'

const router = createAppRouter()

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
    </ErrorBoundary>
  </React.StrictMode>,
)