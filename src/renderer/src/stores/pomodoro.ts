/**
 * 番茄钟状态管理（Zustand）
 *
 * - 通过 IPC 与主进程 timerEngine 通信
 * - 订阅主进程推送的 tick / state-changed / phase-complete 事件以保持 UI 同步
 * - 提供 start/pause/resume/stop/skip/reset 操作
 *
 * 性能说明：
 *   为避免每秒 tick 触发整棵组件树重渲染，我们将 `PomodoroState` 拆为两个独立 slice：
 *     - `control`：mode / running / cycleIndex / startedAt / totalSec（仅在阶段切换或启停时变化）
 *     - `timer`  ：remainingSec / elapsedSec（每秒变化）
 *   组件可按需订阅其中一个切片：
 *     - 只关心倒计时显示的组件订阅 `timer`，每秒重渲染即可
 *     - 关心模式 / 状态徽章 / 设置的组件订阅 `control`，极少重渲染
 *
 *   此外 `applyState` 内部仅对实际发生变化的字段做 partial set，
 *   若 payload 与当前 state 完全一致则不会触发任何订阅者。
 */
import { create } from 'zustand'
import {
  DEFAULT_POMODORO_CONFIG,
  IPC_CHANNELS,
  type PomodoroConfig,
  type PomodoroMode,
  type PomodoroRecord,
  type PomodoroState,
} from '@shared/ipc/channels'

/** 控制状态切片：仅在阶段切换 / 启停时更新 */
export interface PomodoroControl {
  mode: PomodoroMode
  running: boolean
  cycleIndex: number
  startedAt: string | null
  totalSec: number
}

/** 计时快照切片：每秒 tick 时更新 */
export interface PomodoroTimer {
  remainingSec: number
  elapsedSec: number
}

/** 主进程推送的 payload 类型（与 PomodoroState 相同，本地复用别名） */
type IncomingPomodoroState = PomodoroState

interface PomodoroStoreState {
  /** 控制状态切片（低频变化） */
  control: PomodoroControl
  /** 计时快照切片（每秒变化） */
  timer: PomodoroTimer
  /** 配置 */
  config: PomodoroConfig
  /** 是否已加载配置 */
  loaded: boolean
  /** 今日完成列表 */
  todayRecords: PomodoroRecord[]

  // ===== actions =====
  loadConfig: () => Promise<void>
  updateConfig: (patch: Partial<PomodoroConfig>) => Promise<void>
  loadState: () => Promise<void>
  loadToday: () => Promise<void>

  start: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  skip: () => Promise<void>
  reset: () => Promise<void>

  /** 应用主进程推送的状态（供事件监听器调用）；仅对变更字段做 partial set */
  applyState: (s: IncomingPomodoroState) => void
  /** 应用 phase-complete 事件（可触发刷新今日列表） */
  applyPhaseComplete: () => void
}

/** 通用 IPC 调用包装 */
async function invoke<TReq, TRes>(channel: string, req?: TReq): Promise<TRes> {
  return window.api.invoke<TReq, TRes>(channel, req)
}

/** 把主进程 payload 拆成两个切片 */
function splitIncoming(s: IncomingPomodoroState): {
  control: PomodoroControl
  timer: PomodoroTimer
} {
  return {
    control: {
      mode: s.mode,
      running: s.running,
      cycleIndex: s.cycleIndex,
      startedAt: s.startedAt,
      totalSec: s.totalSec,
    },
    timer: {
      remainingSec: s.remainingSec,
      elapsedSec: s.elapsedSec,
    },
  }
}

/** 计算两个控制切片之间的差异字段；若无变化返回 null */
function diffControl(
  prev: PomodoroControl,
  next: PomodoroControl,
): Partial<PomodoroControl> | null {
  const patch: Partial<PomodoroControl> = {}
  if (prev.mode !== next.mode) patch.mode = next.mode
  if (prev.running !== next.running) patch.running = next.running
  if (prev.cycleIndex !== next.cycleIndex) patch.cycleIndex = next.cycleIndex
  if (prev.startedAt !== next.startedAt) patch.startedAt = next.startedAt
  if (prev.totalSec !== next.totalSec) patch.totalSec = next.totalSec
  return Object.keys(patch).length > 0 ? patch : null
}

/** 计算两个计时切片之间的差异字段；若无变化返回 null */
function diffTimer(
  prev: PomodoroTimer,
  next: PomodoroTimer,
): Partial<PomodoroTimer> | null {
  const patch: Partial<PomodoroTimer> = {}
  if (prev.remainingSec !== next.remainingSec) patch.remainingSec = next.remainingSec
  if (prev.elapsedSec !== next.elapsedSec) patch.elapsedSec = next.elapsedSec
  return Object.keys(patch).length > 0 ? patch : null
}

const INITIAL_CONTROL: PomodoroControl = {
  mode: 'focus',
  running: false,
  cycleIndex: 0,
  startedAt: null,
  totalSec: DEFAULT_POMODORO_CONFIG.focusMin * 60,
}

const INITIAL_TIMER: PomodoroTimer = {
  remainingSec: DEFAULT_POMODORO_CONFIG.focusMin * 60,
  elapsedSec: 0,
}

export const usePomodoroStore = create<PomodoroStoreState>((set, get) => ({
  control: { ...INITIAL_CONTROL },
  timer: { ...INITIAL_TIMER },
  config: { ...DEFAULT_POMODORO_CONFIG },
  loaded: false,
  todayRecords: [],

  async loadConfig() {
    try {
      const cfg = await invoke<undefined, PomodoroConfig>(
        IPC_CHANNELS.POMODORO_GET_CONFIG,
      )
      set({ config: cfg, loaded: true })
    } catch (err) {
      console.error('[pomodoro] loadConfig failed', err)
      set({ loaded: true })
    }
  },

  async updateConfig(patch) {
    const next = await invoke<Partial<PomodoroConfig>, PomodoroConfig>(
      IPC_CHANNELS.POMODORO_UPDATE_CONFIG,
      patch,
    )
    set({ config: next })
  },

  async loadState() {
    try {
      const s = await invoke<undefined, PomodoroState>(
        IPC_CHANNELS.POMODORO_GET_STATE,
      )
      get().applyState(s)
    } catch (err) {
      console.error('[pomodoro] loadState failed', err)
    }
  },

  async loadToday() {
    try {
      const list = await invoke<undefined, PomodoroRecord[]>(
        IPC_CHANNELS.POMODORO_TODAY,
      )
      set({ todayRecords: list })
    } catch (err) {
      console.error('[pomodoro] loadToday failed', err)
    }
  },

  async start() {
    const s = await invoke<undefined, PomodoroState>(
      IPC_CHANNELS.POMODORO_START,
      undefined,
    )
    get().applyState(s)
  },

  async pause() {
    const s = await invoke<undefined, PomodoroState>(
      IPC_CHANNELS.POMODORO_PAUSE,
    )
    get().applyState(s)
  },

  async resume() {
    const s = await invoke<undefined, PomodoroState>(
      IPC_CHANNELS.POMODORO_RESUME,
    )
    get().applyState(s)
  },

  async stop() {
    const s = await invoke<undefined, PomodoroState>(
      IPC_CHANNELS.POMODORO_STOP,
    )
    get().applyState(s)
  },

  async skip() {
    const s = await invoke<undefined, PomodoroState>(
      IPC_CHANNELS.POMODORO_SKIP,
    )
    get().applyState(s)
    // 跳过阶段也可能算完成，刷新今日列表
    void get().loadToday()
  },

  async reset() {
    const s = await invoke<undefined, PomodoroState>(
      IPC_CHANNELS.POMODORO_RESET,
    )
    get().applyState(s)
  },

  applyState(s) {
    const incoming = splitIncoming(s)
    set((prev) => {
      const cPatch = diffControl(prev.control, incoming.control)
      const tPatch = diffTimer(prev.timer, incoming.timer)
      if (!cPatch && !tPatch) return prev
      return {
        ...(cPatch ? { control: { ...prev.control, ...cPatch } } : {}),
        ...(tPatch ? { timer: { ...prev.timer, ...tPatch } } : {}),
      }
    })
  },

  applyPhaseComplete() {
    void get().loadToday()
  },
}))

/**
 * 安装事件监听：主进程推送 tick / state-changed / phase-complete 时自动更新 store
 * 在渲染端入口（main.tsx）调用一次即可。
 */
export function installPomodoroListeners(): () => void {
  const offTick = window.api.on(
    IPC_CHANNELS.POMODORO_TICK,
    (_e, payload: PomodoroState) => {
      usePomodoroStore.getState().applyState(payload)
    },
  )

  const offStateChanged = window.api.on(
    IPC_CHANNELS.POMODORO_STATE_CHANGED,
    (_e, payload: PomodoroState & { reason?: string }) => {
      // 主进程推送的 state-changed 事件可能携带不同的 reason：
      //   - 'state' / 'stopped'：附带完整 PomodoroState，需要应用到 store
      //   - 'auto-start'：仅附带 { reason, mode }，不应覆盖当前状态
      const reason = payload?.reason
      if (reason !== 'state' && reason !== 'stopped') return
      usePomodoroStore.getState().applyState(payload)
    },
  )

  const offPhaseComplete = window.api.on(
    IPC_CHANNELS.POMODORO_PHASE_COMPLETE,
    () => {
      usePomodoroStore.getState().applyPhaseComplete()
    },
  )

  return () => {
    offTick?.()
    offStateChanged?.()
    offPhaseComplete?.()
  }
}