/**
 * 应用设置管理
 *
 * 启动时从 settingsApi 加载全部设置到内存，
 * 写入时同时持久化到数据库。
 *
 * 模块 9 新增：
 *   - libraryPath setter：与设置一并持久化
 *   - checkLibraryReady()：从主进程同步最新 libraryPath 并做存在性检查，
 *     返回 { path, exists }，供首启动向导弹窗使用
 */
import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/channels'
import { settingsApi, libraryApi } from '../lib/ipc'

interface SettingsState extends AppSettings {
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
  /** 仅设置 libraryPath 字段（其它设置保持不变） */
  setLibraryPath: (path: string | null) => Promise<void>
  /**
   * 从主进程同步当前 libraryPath 与存在性
   * - 更新 store 中的 libraryPath
   * - 返回 { path, exists }
   */
  checkLibraryReady: () => Promise<{ path: string | null; exists: boolean }>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,

  async load() {
    try {
      const all = await settingsApi.getAll()
      const merged: AppSettings = { ...DEFAULT_SETTINGS, ...(all['app.settings'] as Partial<AppSettings> | undefined) }
      set({ ...merged, loaded: true })
      // X5-fix：boot 时也要把 accentColor 落到 CSS 变量上。
      // AppearanceTab.handleAccent 在运行时写 --accent / --accent-hover，
      // 但 boot 时没有任何地方读 accentColor 把 CSS 恢复回去，重启后主题色失效。
      if (typeof document !== 'undefined' && merged.accentColor) {
        const root = document.documentElement.style
        const c = String(merged.accentColor)
        root.setProperty('--accent', c)
        root.setProperty('--accent-hover', c)
      }
    } catch (_) {
      set({ loaded: true })
    }
  },

  async update(patch) {
    const before = get()
    const next = { ...before, ...patch }
    set(patch)
    try {
      const { loaded: _l, load: _ld, update: _u, setLibraryPath: _sl, checkLibraryReady: _cr, ...persistable } = next
      await settingsApi.set('app.settings', persistable)
    } catch (err) {
      // R6S-5：IPC 失败时回滚本地 state，避免下次 reload 后本地与 DB 永久不一致。
      console.error('[settings] save failed', err)
      const { loaded: _l2, load: _ld2, update: _u2, setLibraryPath: _sl2, checkLibraryReady: _cr2, ...beforePersistable } = before
      void _l2; void _ld2; void _u2; void _sl2; void _cr2
      set(beforePersistable as Partial<AppSettings>)
      throw err
    }
  },

  async setLibraryPath(path) {
    const before = get()
    set({ libraryPath: path })
    try {
      // X3-fix：之前 setLibraryPath 构造的 persistable 漏掉了 AI 相关字段
      // （aiProvider / aiEnabled / 各 provider 的 model + baseUrl），
      // 一旦切换 library 就会把这些配置悄悄清空。改为：只剥离方法/loaded，
      // 保留全部 AppSettings 字段（包括 AI），再覆盖 libraryPath。
      const next = { ...get(), libraryPath: path }
      const { loaded: _l, load: _ld, update: _u, setLibraryPath: _sl, checkLibraryReady: _cr, ...persistable } = next
      void _l; void _ld; void _u; void _sl; void _cr
      await settingsApi.set('app.settings', persistable)
    } catch (err) {
      console.error('[settings] setLibraryPath save failed', err)
      // R6S-5：回滚 libraryPath 字段。
      set({ libraryPath: before.libraryPath })
      throw err
    }
  },

  async checkLibraryReady() {
    let path: string | null = null
    try {
      path = await libraryApi.getCurrent()
    } catch (err) {
      console.error('[settings] getCurrent failed', err)
      return { path: null, exists: false }
    }

    // 同步到 store
    if (path !== get().libraryPath) {
      set({ libraryPath: path })
    }

    if (!path) {
      return { path: null, exists: false }
    }

    try {
      const v = await libraryApi.validate(path)
      return { path, exists: v.valid }
    } catch (err) {
      console.error('[settings] validate failed', err)
      return { path, exists: false }
    }
  },
}))
