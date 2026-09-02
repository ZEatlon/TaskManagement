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

// 安装番茄钟事件监听（主进程推送 -> store）
const disposePomodoroListeners = installPomodoroListeners()

// 安装 AI 流事件监听（主进程推送 -> store）
const disposeAiListeners = installAiListeners()

// 初始化 git store：注册主进程推送事件 + 拉取初始状态
// 必须在此处调用，否则主进程推送的 GIT_STATE_CHANGED / SYNC_START / SYNC_END / SYNC_ERROR
// 事件在渲染端无人订阅，UI 永远停留在 'idle'，同步指示器不会响应 autoSync。
void useGitStore.getState().init()

import.meta.hot?.dispose(() => {
  disposePomodoroListeners()
  disposeAiListeners()
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