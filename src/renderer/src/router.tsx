/**
 * TanStack Router 配置（内存路由模式）
 * 适合 Electron 单窗口应用，无需 URL 地址栏
 */
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { RootRoute } from './routes/__root'
import { ClockRoute } from './routes/clock'
import { TodayRoute } from './routes/today'
import { SettingsRoute } from './routes/settings'
import { AiRoute } from './routes/ai'
import { NotesRoute } from './routes/notes'

const rootRoute = createRootRoute({
  component: RootRoute,
})

// W3-A：删除 Dashboard，/ 直接落地 Clock 页（番茄钟为新首页）。
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ClockRoute,
})

const clockRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clock',
  component: ClockRoute,
})

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/today',
  component: TodayRoute,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsRoute,
})

const aiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ai',
  component: AiRoute,
})

const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notes',
  component: NotesRoute,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  clockRoute,
  todayRoute,
  settingsRoute,
  aiRoute,
  notesRoute,
])

export function createAppRouter() {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}