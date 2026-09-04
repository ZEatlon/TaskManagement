/**
 * TanStack Router 配置（内存路由模式）
 * 适合 Electron 单窗口应用，无需 URL 地址栏
 */
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { RootRoute } from './routes/__root'
import { DashboardRoute } from './routes/dashboard'
import { TodayRoute } from './routes/today'
import { SettingsRoute } from './routes/settings'
import { AiRoute } from './routes/ai'
import { NotesRoute } from './routes/notes'

const rootRoute = createRootRoute({
  component: RootRoute,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardRoute,
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