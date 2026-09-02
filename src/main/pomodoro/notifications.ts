/**
 * 番茄钟通知模块
 *
 * 封装番茄钟各阶段的系统通知与 IPC 推送逻辑：
 *   - focus 完成：弹"专注完成"通知 + 推 IPC
 *   - 短/长休息开始：弹"休息开始"通知 + 推 IPC
 *   - 休息结束（即将开始新一轮 focus）：弹"专注开始"通知
 *
 * 通过 BrowserWindow.webContents.send 主动推送事件给渲染端，
 * 渲染端 store 可订阅这些事件以刷新 UI（无需轮询）。
 */
import { BrowserWindow } from 'electron'
import log from '../log'
import { notify } from '../notifications/notify'
import { IPC_CHANNELS, type PomodoroState } from '@shared/ipc/channels'

/** 推送事件到所有渲染窗口 */
function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** focus 阶段完成：发通知并推送 phase-complete 事件
 *  P1-fix：completedMin 必须是已完成阶段的时长，不能从已经 advance 过的 state.totalSec 取。
 *  nextState 才是传入的 state，里面的 totalSec 是下一阶段（如短/长休）的时长。
 *  R5-1：休息时长原本硬编码 "15" / "5" 并用 % 4 判定 —— 完全无视用户的
 *       shortBreakMin / longBreakMin / cycleCount 配置。改为接受 config 并据此计算。
 *
 *  R11 修复 (medium #38)：原版 IPC payload 用 nextState.stickyNoteId，但 timerEngine
 *  的 advancePhase 已经把 stickyNoteId 置 null（focus → break 切换时不该带便签 id
 *  走 break 阶段），所以渲染端收到 phase-complete 时 stickyNoteId 永远为 null。
 *  改为让调用方显式传 stickyNoteId（来自「刚完成的那段 focus」）。
 */
export async function notifyFocusComplete(
  nextState: PomodoroState,
  stickyTitle: string | null,
  completedMin: number,
  config?: { shortBreakMin: number; longBreakMin: number; cycleCount: number },
  stickyNoteIdForRecord?: string | null,
): Promise<void> {
  const title = '🍅 专注完成'
  let restMin: number
  if (config) {
    const isLong =
      nextState.cycleIndex > 0 &&
      nextState.cycleIndex % config.cycleCount === 0
    restMin = isLong ? config.longBreakMin : config.shortBreakMin
  } else {
    // 兜底：沿用旧行为避免破坏调用方
    restMin = nextState.cycleIndex % 4 === 0 ? 15 : 5
  }
  const body = stickyTitle
    ? `已专注 ${completedMin} 分钟：${stickyTitle}\n休息 ${restMin} 分钟`
    : `已专注 ${completedMin} 分钟，进入休息`
  await notify({ title, body, type: 'reminder', silent: false })
  emit(IPC_CHANNELS.POMODORO_PHASE_COMPLETE, {
    mode: 'focus',
    stickyNoteId: stickyNoteIdForRecord ?? null,
    stickyTitle,
    durationMin: completedMin,
    nextMode: nextState.mode,
  })
  log.info('[pomodoro] focus complete notify sent')
}

/** 休息阶段完成（即将进入 focus）
 *  P1-fix：同 focusCompleted，传 completedMin 而非 nextState.totalSec
 *  R7P-5 修复：nextState.mode 已经是 'focus'（advancePhase 之后），原实现
 *   把 IPC payload 的 mode 设为 'focus' 与 nextMode:'focus' 完全相同，渲染端
 *   无法区分「刚完成的是 break」与「刚完成的是 focus」。新增 prevMode 参数，
 *   payload 改为 { mode: prevMode, nextMode: 'focus', ... }。
 */
export async function notifyBreakComplete(
  nextState: PomodoroState,
  completedMin: number,
  prevMode: 'shortBreak' | 'longBreak',
): Promise<void> {
  const title = '⏰ 休息结束'
  const body = '该开始下一轮专注了'
  await notify({ title, body, type: 'reminder' })
  emit(IPC_CHANNELS.POMODORO_PHASE_COMPLETE, {
    mode: prevMode,
    stickyNoteId: null,
    stickyTitle: null,
    durationMin: completedMin,
    nextMode: nextState.mode,
  })
  log.info(`[pomodoro] break complete notify sent (${prevMode})`)
}

/** 自动开始下一阶段时通知（专注开始 / 长休开始） */
export async function notifyAutoStart(state: PomodoroState): Promise<void> {
  if (state.mode === 'focus') return // 不打扰用户
  const title = state.mode === 'longBreak' ? '☕ 长休开始' : '☕ 短休开始'
  const body = state.mode === 'longBreak'
    ? `好好休息 ${state.totalSec / 60} 分钟`
    : `稍作休息 ${state.totalSec / 60} 分钟`
  await notify({ title, body, type: 'reminder', silent: true })
  emit(IPC_CHANNELS.POMODORO_STATE_CHANGED, {
    reason: 'auto-start',
    mode: state.mode,
  })
  log.info(`[pomodoro] auto-start notify ${state.mode}`)
}

/** 每秒 tick 事件 */
export function emitTick(state: PomodoroState): void {
  emit(IPC_CHANNELS.POMODORO_TICK, { ...state })
}

/** 状态变化事件 */
export function emitStateChanged(state: PomodoroState): void {
  emit(IPC_CHANNELS.POMODORO_STATE_CHANGED, { ...state, reason: 'state' })
}

/** 停止/重置 */
export function emitStopped(state: PomodoroState): void {
  emit(IPC_CHANNELS.POMODORO_STATE_CHANGED, { ...state, reason: 'stopped' })
}