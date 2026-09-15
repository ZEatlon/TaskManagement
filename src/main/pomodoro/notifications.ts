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
import log from '../log'
import { notify } from '../notifications/notify'
import { emitToRenderers } from '../ipc/emit'
import { IPC_CHANNELS, type PomodoroState } from '@shared/ipc/channels'
import { settingsRepo } from '../db/repositories/settings'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/channels'
import { getNotificationMessages, type NotificationMessages } from '@shared/i18n/locales'

/** 推送事件到所有渲染窗口（统一走 src/main/ipc/emit.ts，本地不再定义） */
const emit = emitToRenderers

/**
 * 拉取当前 locale 对应的通知文案字典。settings 读取失败 / 字段损坏时
 * 由 getNotificationMessages() 内部 toLocaleValue 回退默认 locale
 * （与 notify.ts:resolveNotificationMessages 一致）。
 *
 * 抽成独立函数：4 类通知（focus 完成 / break 完成 / 长休开始 / 短休开始）
 * 共享同一份字典，未来加新 locale 时只在 NOTIFICATION_MESSAGES 加条目，
 * 调用方零改动。
 */
async function resolvePomodoroMessages(): Promise<NotificationMessages> {
  try {
    const settings = (await settingsRepo.get<AppSettings>('app.settings')) ?? DEFAULT_SETTINGS
    return getNotificationMessages(settings.language)
  } catch {
    return getNotificationMessages(undefined)
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
 *
 *  R-fix-i18n-pomodoro-notification (high)：title / body 改走
 *  getNotificationMessages()，跟随 settings.language 切换。修复前 4 类
 *  番茄钟通知（focus 完成 / break 完成 / 长休开始 / 短休开始）全部硬编码
 *  中文，加 en-US locale 后立即成为 first bug。
 */
export async function notifyFocusComplete(
  nextState: PomodoroState,
  stickyTitle: string | null,
  completedMin: number,
  config?: { shortBreakMin: number; longBreakMin: number; cycleCount: number },
  stickyNoteIdForRecord?: string | null,
): Promise<void> {
  const messages = await resolvePomodoroMessages()
  let restMin: number
  let restKind: 'shortBreak' | 'longBreak'
  if (config) {
    const isLong =
      nextState.cycleIndex > 0 &&
      nextState.cycleIndex % config.cycleCount === 0
    restMin = isLong ? config.longBreakMin : config.shortBreakMin
    restKind = isLong ? 'longBreak' : 'shortBreak'
  } else {
    // 兜底：沿用旧行为避免破坏调用方
    const isLong = nextState.cycleIndex % 4 === 0
    restMin = isLong ? 15 : 5
    restKind = isLong ? 'longBreak' : 'shortBreak'
  }
  const title = messages.pomodoroFocusCompleteTitle
  const body = messages.pomodoroFocusCompleteBody({
    stickyTitle,
    completedMin,
    restMin,
    restKind,
  })
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
 *
 *  R-fix-i18n-pomodoro-notification (high)：title / body 改走字典。
 */
export async function notifyBreakComplete(
  nextState: PomodoroState,
  completedMin: number,
  prevMode: 'shortBreak' | 'longBreak',
): Promise<void> {
  const messages = await resolvePomodoroMessages()
  const title = messages.pomodoroBreakCompleteTitle
  const body = messages.pomodoroBreakCompleteBody
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

/** 自动开始下一阶段时通知（专注开始 / 长休开始）
 *  R-fix-i18n-pomodoro-notification (high)：title / body 改走字典。
 */
export async function notifyAutoStart(state: PomodoroState): Promise<void> {
  if (state.mode === 'focus') return // 不打扰用户
  const messages = await resolvePomodoroMessages()
  const restMin = state.totalSec / 60
  const isLong = state.mode === 'longBreak'
  const title = isLong
    ? messages.pomodoroLongBreakStartTitle
    : messages.pomodoroShortBreakStartTitle
  const body = isLong
    ? messages.pomodoroLongBreakStartBody(restMin)
    : messages.pomodoroShortBreakStartBody(restMin)
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

/**
 * 推送专注模式（focus mode overlay）状态变更。
 * reason：
 *   - 'start'   — 番茄钟 start() 且 config.autoEnterFocusMode
 *   - 'stop'    — stop() 或 service 关闭
 *   - 'complete'— focus 阶段自然完成
 *   - 'manual'  — 渲染端手动 enter/exit（保留扩展位）
 */
export function emitFocusMode(
  focusMode: boolean,
  reason: 'start' | 'stop' | 'complete' | 'manual',
): void {
  emit(IPC_CHANNELS.POMODORO_FOCUS_MODE_CHANGED, { focusMode, reason })
  log.info(`[pomodoro] focus mode ${focusMode ? 'enter' : 'exit'} (reason=${reason})`)
}

/**
 * 推送「番茄专注记录持久化失败」事件（主进程 → 渲染进程）。
 *
 * R-fix-pomodoro-persist-silent-fail (medium error-handling)：历史上
 * pomodoroService.handlePhaseComplete 在 recordPomodoro 失败时只在
 * log.error 里写一句，UI 端没有任何感知 —— 用户看到计时停了但听不到
 * 完成音、看不到系统通知、热力图/统计里这次完成没被算上，还以为
 * 自己刚才的 25 分钟专注从没发生过。
 *
 * 现在单次重试后仍失败时调本函数推 IPC，渲染端 dashboard 弹 toast
 * 「本次专注未记录：<原因>」，让用户至少知情。
 *
 * @param phase       刚完成的阶段（focus / shortBreak / longBreak）
 * @param durationMin 真实经过分钟数（与通知/统计口径一致）
 * @param reason      失败原因（来自 recordPomodoro / runInTransaction
 *                    抛出的原始 err.message，给 log/调试留痕迹；前端
 *                    可选择简化展示，避免把底层 SQL 错误文本直接抛给用户）
 */
export function emitPomodoroPersistFailed(
  phase: 'focus' | 'shortBreak' | 'longBreak',
  durationMin: number,
  reason: string,
): void {
  emit(IPC_CHANNELS.POMODORO_PERSIST_FAILED, {
    phase,
    durationMin,
    reason,
  })
  log.warn(`[pomodoro] persist failed phase=${phase} durationMin=${durationMin} reason=${reason}`)
}