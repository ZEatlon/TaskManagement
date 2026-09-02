/**
 * Git 同步状态（Zustand）
 *
 * 职责：
 *   - 维护仓库状态、最近同步时间、最近错误信息
 *   - 订阅主进程通过 IPC 推送的事件（state-changed / sync-start / sync-end / sync-error）
 *   - 提供手动拉取/推送/同步的 action
 *
 * 设计：
 *   - 启动时调用 init() 注册订阅 + 拉取一次状态
 *   - 状态变更采用全量替换 GitSyncState；组件可订阅具体字段避免不必要重渲染
 */
import { create } from 'zustand'
import type {
  GitStatusInfo,
  GitLogEntry,
  GitSyncState,
  GitSyncPhase,
} from '@shared/ipc/channels'
import { IPC_CHANNELS, defaultCommitMessage } from '@shared/ipc/channels'
import { gitApi } from '../lib/ipc'

/** 离线检测：最近一次操作成功时间，超时视为离线 */
const OFFLINE_TIMEOUT_MS = 60_000

/** 完整的 store state */
interface GitStoreState extends GitSyncState {
  /** 仓库是否初始化 */
  isRepo: boolean
  /** 详细状态（ahead/behind/modified/untracked 等） */
  status: GitStatusInfo | null
  /** 最近一次提交记录（缓存） */
  recentLog: GitLogEntry[]
  /** 是否在线（基于最近一次成功操作时间） */
  online: boolean

  // ---- actions ----
  /** 初始化：注册事件订阅 + 拉取初始状态 */
  init: () => Promise<void>
  /** R11 修复 (medium #32)：实际的初始化逻辑（被 init() 通过并发锁复用） */
  _initImpl: () => Promise<void>
  /** 释放订阅（窗口卸载时调用） */
  dispose: () => void

  /** 刷新仓库状态（status + log） */
  refresh: () => Promise<void>
  /** 拉取远端（pull） */
  pull: () => Promise<void>
  /** 推送到远端（push） */
  push: () => Promise<void>
  /** 完整同步（commit + push） */
  syncNow: (message?: string) => Promise<{ ok: boolean; error?: string }>
  /** 初始化仓库 */
  initRepo: () => Promise<void>
  /** 设置远程地址（切换到不同主机时需 confirmHostChange=true） */
  setRemote: (url: string, confirmHostChange?: boolean) => Promise<void>

  /** 更新同步状态（内部使用，监听主进程事件） */
  setSyncState: (next: Partial<GitSyncState>) => void
  /** 设置仓库状态 */
  setStatus: (s: GitStatusInfo) => void
  /** 设置日志 */
  setLog: (entries: GitLogEntry[]) => void
  /** 设置 online 标志 */
  setOnline: (online: boolean) => void
}

/** 全局 disposers 容器（确保 init() 幂等） */
let unsubscribeState: (() => void) | null = null
let unsubscribeStart: (() => void) | null = null
let unsubscribeEnd: (() => void) | null = null
let unsubscribeError: (() => void) | null = null
// R11 修复 (medium #32)：并发 init() 竞态。多个组件 mount / 路由切换会同时
// 触发 init()，每个都跑 Promise.all([isRepo, state]) + 条件 refresh —— 两个并发
// init 各自 set() 后状态被多次覆盖、refresh 重复触发。合并到同一个 promise。
let initInFlight: Promise<void> | null = null
/** 已完成过初始化（避免 dispose → init 后重复订阅拉取） */
let initialized = false

export const useGitStore = create<GitStoreState>((set, get) => ({
  // GitSyncState 字段
  phase: 'idle' as GitSyncPhase,
  lastSyncAt: null,
  lastError: null,
  autoEnabled: false,
  // store 扩展字段
  isRepo: false,
  status: null,
  recentLog: [],
  online: true,

  async init() {
    // R11 修复 (medium #32)：并发 init() 合并为同一个 promise，避免多个组件 mount
    // / 路由切换时各自跑一次 Promise.all + refresh 导致重复 IPC / 重复 set()。
    if (initInFlight) return initInFlight
    if (initialized) return
    initInFlight = (async () => {
      try {
        await this._initImpl()
        initialized = true
      } finally {
        initInFlight = null
      }
    })()
    return initInFlight
  },

  async _initImpl() {
    // 注册主进程事件订阅
    if (!unsubscribeState) {
      unsubscribeState = window.api.on(
        IPC_CHANNELS.GIT_STATE_CHANGED,
        (_event, payload: GitSyncState) => {
          set({
            phase: payload.phase,
            lastSyncAt: payload.lastSyncAt,
            lastError: payload.lastError,
            autoEnabled: payload.autoEnabled,
          })
        },
      )
    }
    if (!unsubscribeStart) {
      unsubscribeStart = window.api.on(
        IPC_CHANNELS.GIT_SYNC_START,
        (_event, payload: { phase: GitSyncPhase }) => {
          set({ phase: payload.phase, lastError: null })
        },
      )
    }
    if (!unsubscribeEnd) {
      unsubscribeEnd = window.api.on(
        IPC_CHANNELS.GIT_SYNC_END,
        (_event, _payload: { ok: boolean; sha?: string | null; noop?: boolean }) => {
          set({
            phase: 'idle',
            lastSyncAt: new Date().toISOString(),
            lastError: null,
            online: true,
          })
          // 同步成功后刷新仓库状态
          void get().refresh()
        },
      )
    }
    if (!unsubscribeError) {
      unsubscribeError = window.api.on(
        IPC_CHANNELS.GIT_SYNC_ERROR,
        (_event, payload: { message: string; kind: string; at: string }) => {
          set({
            phase: 'idle',
            lastError: payload.message,
          })
          // 网络错误 -> 标记离线
          if (payload.kind === 'network') set({ online: false })
        },
      )
    }

    // 拉取初始状态
    try {
      const [repo, state] = await Promise.all([gitApi.isRepo(), gitApi.state()])
      set({
        isRepo: repo.isRepo,
        phase: state.phase,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
        autoEnabled: state.autoEnabled,
      })
      if (repo.isRepo) {
        await get().refresh()
      }
    } catch (err) {
      console.warn('[git-store] initial fetch failed', err)
    }
  },

  dispose() {
    unsubscribeState?.()
    unsubscribeStart?.()
    unsubscribeEnd?.()
    unsubscribeError?.()
    unsubscribeState = null
    unsubscribeStart = null
    unsubscribeEnd = null
    unsubscribeError = null
    // R11 修复 (medium #32)：dispose 后再 init() 应重新订阅 + 重新拉取。
    initialized = false
  },

  async refresh() {
    try {
      const [status, log] = await Promise.all([
        gitApi.status(),
        gitApi.log(20).catch(() => [] as GitLogEntry[]),
      ])
      set({ status, recentLog: log, online: true })
    } catch (err) {
      const msg = (err as Error).message
      set({ online: false, lastError: msg })
    }
  },

  async pull() {
    set({ phase: 'pulling', lastError: null })
    try {
      await gitApi.pull()
      set({ phase: 'idle', lastSyncAt: new Date().toISOString(), online: true })
      await get().refresh()
    } catch (err) {
      const msg = (err as Error).message
      set({ phase: 'idle', lastError: msg })
      throw err
    }
  },

  async push() {
    set({ phase: 'pushing', lastError: null })
    try {
      await gitApi.push()
      set({ phase: 'idle', lastSyncAt: new Date().toISOString(), online: true })
      await get().refresh()
    } catch (err) {
      const msg = (err as Error).message
      set({ phase: 'idle', lastError: msg })
      throw err
    }
  },

  async syncNow(message) {
    const msg = message ?? defaultCommitMessage()
    set({ phase: 'committing', lastError: null })
    try {
      const result = await gitApi.commitAndPush(msg)
      if (result.ok) {
        set({ phase: 'idle', lastSyncAt: new Date().toISOString(), online: true })
        await get().refresh()
        return { ok: true }
      }
      set({ phase: 'idle', lastError: result.error ?? '同步失败' })
      return { ok: false, error: result.error }
    } catch (err) {
      const e = (err as Error).message
      set({ phase: 'idle', lastError: e })
      return { ok: false, error: e }
    }
  },

  async initRepo() {
    await gitApi.init()
    set({ isRepo: true })
    await get().refresh()
  },

  async setRemote(url: string, confirmHostChange = false) {
    await gitApi.setRemote(url, 'origin', confirmHostChange)
    await get().refresh()
  },

  setSyncState(next) {
    set(next)
  },

  setStatus(s) {
    set({ status: s })
  },

  setLog(entries) {
    set({ recentLog: entries })
  },

  setOnline(online) {
    set({ online })
  },
}))

/** 生成默认 commit 消息（与主进程 autoSync 保持一致 —— 已迁移到 @shared/ipc/channels） */

/**
 * 派生：是否处于同步中
 */
export function selectIsSyncing(state: { phase: GitSyncPhase }): boolean {
  return state.phase !== 'idle'
}

/**
 * 派生：显示用的"上次同步 X 秒前"
 */
export function selectLastSyncRelative(state: { lastSyncAt: string | null }): string {
  if (!state.lastSyncAt) return '尚未同步'
  const diff = Date.now() - new Date(state.lastSyncAt).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/**
 * 派生：判定"离线"（最近一次操作超时）
 */
export function computeOnline(state: { lastSyncAt: string | null; lastError: string | null }): boolean {
  if (state.lastError && /network|timeout|fetch/i.test(state.lastError)) return false
  if (!state.lastSyncAt) return true
  return Date.now() - new Date(state.lastSyncAt).getTime() < OFFLINE_TIMEOUT_MS
}
