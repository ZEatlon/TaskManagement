/**
 * 番茄钟 IPC 处理器
 *
 * 注册通道（来自 IPC_CHANNELS）：
 *   - pomodoro:get-state         -> PomodoroState
 *   - pomodoro:get-config        -> PomodoroConfig
 *   - pomodoro:update-config     -> PomodoroConfig
 *   - pomodoro:start             -> PomodoroState
 *   - pomodoro:pause             -> PomodoroState
 *   - pomodoro:resume            -> PomodoroState
 *   - pomodoro:stop              -> PomodoroState
 *   - pomodoro:skip              -> PomodoroState
 *   - pomodoro:reset             -> PomodoroState
 *   - pomodoro:today             -> PomodoroRecord[]
 *   - pomodoro:recent            -> PomodoroRecord[]
 *
 * 推送事件（主 -> 渲染）：
 *   - pomodoro:tick
 *   - pomodoro:phase-complete
 *   - pomodoro:state-changed
 */
import { handle } from './channels'
import { IPC_CHANNELS, type PomodoroConfig } from '@shared/ipc/channels'
import {
  getState,
  start,
  pause,
  resume,
  stop,
  skip,
  reset,
  loadConfig,
  saveConfig,
  listToday,
  listRecent,
} from '../pomodoro/pomodoroService'
import { pomodorosRepo } from '../db/repositories/pomodoros'

export function registerPomodoroHandlers(): void {
  /** 查询当前计时状态 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_GET_STATE,
    async () => getState(),
  )

  /** 查询番茄钟配置 */
  handle<undefined, PomodoroConfig>(
    IPC_CHANNELS.POMODORO_GET_CONFIG,
    async () => loadConfig(),
  )

  /** 更新番茄钟配置 */
  handle<Partial<PomodoroConfig>, PomodoroConfig>(
    IPC_CHANNELS.POMODORO_UPDATE_CONFIG,
    async (_e, patch) => saveConfig(patch),
  )

  /** 开始计时（不再需要关联便签参数 —— 调用方已下线 stickyNoteId 选择器） */
  // 渲染端 stores/pomodoro.ts:start() 现在以无参形式调用，handler 仍保留
  // null/undefined 容错（兼容旧调用）。
  handle<string | null | undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_START,
    async (_e, stickyNoteId) => start(stickyNoteId ?? null),
  )

  /** 暂停 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_PAUSE,
    async () => pause(),
  )

  /** 恢复 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_RESUME,
    async () => resume(),
  )

  /** 停止（清零回到初始 focus 阶段） */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_STOP,
    async () => stop(),
  )

  /** 跳过当前阶段 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_SKIP,
    async () => skip(),
  )

  /** 重置（=stop） */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_RESET,
    async () => reset(),
  )

  /** 今日完成列表 */
  handle<undefined, Awaited<ReturnType<typeof listToday>>>(
    IPC_CHANNELS.POMODORO_TODAY,
    async () => listToday(),
  )

  /** 最近 N 条 */
  handle<number | undefined, Awaited<ReturnType<typeof listRecent>>>(
    IPC_CHANNELS.POMODORO_RECENT,
    async (_e, limit) => listRecent(limit ?? 50),
  )

  /**
   * 热力图数据：区间内每日专注分钟数（YYYY-MM-DD → minutes）
   * 完成口径与 pomodoros 表 completed=1 一致。
   */
  handle<{ start: string; end: string }, Record<string, number>>(
    IPC_CHANNELS.POMODORO_DAILY,
    async (_e, { start, end }) => pomodorosRepo.dailyMinutes(start, end),
  )
}