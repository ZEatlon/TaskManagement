/**
 * 全局应用状态（Zustand）
 * 轻量：主题、笔记页左右侧栏折叠等 UI 状态
 * 业务数据放在各自的 store 中
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark'

interface AppState {
  theme: ThemeMode
  /** 笔记页左侧栏（笔记树）是否折叠 */
  notesLeftCollapsed: boolean
  /** 笔记页右侧栏（元数据面板）是否折叠 */
  notesRightCollapsed: boolean
  density: 'compact' | 'comfortable'
  ready: boolean

  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  toggleNotesLeftSidebar: () => void
  toggleNotesRightSidebar: () => void
  setDensity: (density: 'compact' | 'comfortable') => void
  setFontSize: (px: number) => void
  setReady: (ready: boolean) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      notesLeftCollapsed: false,
      notesRightCollapsed: false,
      density: 'comfortable',
      ready: false,

      setTheme: (theme) => {
        set({ theme })
        document.documentElement.dataset['theme'] = theme
      },
      toggleTheme: () => {
        const next = get().theme === 'dark' ? 'light' : 'dark'
        get().setTheme(next)
      },
      toggleNotesLeftSidebar: () =>
        set({ notesLeftCollapsed: !get().notesLeftCollapsed }),
      toggleNotesRightSidebar: () =>
        set({ notesRightCollapsed: !get().notesRightCollapsed }),
      setDensity: (density) => {
        set({ density })
        document.documentElement.dataset['density'] = density
      },
      setFontSize: (px) => {
        document.documentElement.style.setProperty('--font-size-base', `${px}px`)
      },
      setReady: (ready) => set({ ready }),
    }),
    {
      name: 'taskpilot:app',
      storage: createJSONStorage(() => localStorage),
      // 仅持久化 UI 偏好；ready/函数不写入 localStorage
      partialize: (state) => ({
        theme: state.theme,
        notesLeftCollapsed: state.notesLeftCollapsed,
        notesRightCollapsed: state.notesRightCollapsed,
        density: state.density,
      }),
      // 兼容旧版本 localStorage（key 为 `sidebarCollapsed` / `todayView`），
      // 自动把它的值迁移/丢弃，避免历史状态丢失或脏字段。
      version: 4,
      migrate: (persistedState, _version) => {
        const ps = (persistedState ?? {}) as Record<string, unknown>
        // 旧 key 还在 & 新 key 未设置 → 迁移
        if (
          typeof ps['sidebarCollapsed'] === 'boolean' &&
          ps['notesLeftCollapsed'] === undefined
        ) {
          ps['notesLeftCollapsed'] = ps['sidebarCollapsed']
        }
        delete ps['sidebarCollapsed']
        // v3 → v4：删 todayView（旧双视图字段已废弃）
        delete ps['todayView']
        return ps as never
      },
    },
  ),
)

// 初始化主题
if (typeof document !== 'undefined') {
  document.documentElement.dataset['theme'] = useAppStore.getState().theme
}
