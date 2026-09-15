/**
 * 番茄钟计时器引擎（主进程侧）
 *
 * 职责：
 *   - 精确计时：基于 setInterval + 累计 elapsed，避免后台漂移
 *   - 状态机：focus -> shortBreak/longBreak -> focus ...
 *   - 暂停/恢复/重置/跳过
 *   - 通过 onTick / onComplete 回调通知外部（service 层桥接到 IPC）
 *
 * 注意：单例；运行于主进程，setInterval 不会被 renderer 卸载影响。
 */
import type {
  PomodoroConfig,
  PomodoroMode,
  PomodoroState,
} from '@shared/ipc/channels'
import { DEFAULT_POMODORO_CONFIG } from '@shared/ipc/channels'
import log from '../log'

/** 每阶段总秒数 */
function totalSecOf(mode: PomodoroMode, cfg: PomodoroConfig): number {
  if (mode === 'focus') return cfg.focusMin * 60
  if (mode === 'shortBreak') return cfg.shortBreakMin * 60
  return cfg.longBreakMin * 60
}

export function makeInitialState(): PomodoroState {
  return {
    mode: 'focus',
    remainingSec: DEFAULT_POMODORO_CONFIG.focusMin * 60,
    totalSec: DEFAULT_POMODORO_CONFIG.focusMin * 60,
    cycleIndex: 0,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  }
}

export class TimerEngine {
  /** 当前状态 */
  state: PomodoroState
  /** 当前配置 */
  config: PomodoroConfig

  /** 每秒 tick 回调 */
  onTick: ((s: PomodoroState) => void) | null = null
  /** 当前阶段完成回调（自动切换阶段后触发）
   *  参数：(刚结束阶段的状态快照, 下一阶段状态, 上一阶段的 mode)
   *  快照中 elapsedSec 为阶段结束时已流逝的秒数（用于判定是否"完整完成"）
   *  userSkipped 区分「自然到期」与「用户主动 skip」—— service 层据此
   *  决定是否自动勾掉关联便签（skip 不应触发 sticky.complete）。
   */
  onPhaseComplete: ((
    finished: {
      mode: PomodoroMode
      startedAt: string | null
      stickyNoteId: string | null
      totalSec: number
      elapsedSec: number
      userSkipped: boolean
    },
    next: PomodoroState,
    prevMode: PomodoroMode,
  ) => void) | null = null
  /** 整体停止回调（stop/reset 后） */
  onStopped: ((s: PomodoroState) => void) | null = null
  /**
   * 状态变化 —— emitChange() 触发时回调，**整个 state 可能任意字段变化**
   * （running / mode / cycleIndex / totalSec / remainingSec / elapsedSec /
   * startedAt / stickyNoteId 等都可能变）。订阅者必须基于新 state 与 prev
   * state 做完整 diff，**不要**基于「某些字段在该事件中不变」之类字段子集
   * 假设来决定是否应用。pause() 同步设 running=false 后会 emitChange()，
   * setConfig() 在 wasRunning / wasPaused / 未开始 三种分支也都会
   * emitChange()（参见 pause / setConfig 内部调用点）。
   */
  onStateChanged: ((s: PomodoroState) => void) | null = null

  private timer: NodeJS.Timeout | null = null
  /** 暂停时刻（wall-clock ms），用于 resume 时把 startedAt 偏移，把暂停时长从 elapsed 中扣除 */
  private pausedAt: number | null = null
  // R-fix-skip-after-natural-complete (MEDIUM concurrency)：最近一次 onPhaseComplete
  // 触发时的 prevMode —— tick() 自然到期后立刻跳到下一阶段（autoStartNext=true
  // 时 break 已 running），用户此时再点 skip() 会被 advancePhase + onPhaseComplete
  // 再触发一次，UX 上收到一条"刚休息就完成"的幽灵通知。skip() 顶部若发现
  // 当前 mode === lastPhaseCompleteMode，意味着上一阶段刚被自然完成 —— 静默
  // 丢弃这次 skip，由 advancePhase 进入时清空字段让后续真正的用户 skip 仍生效。
  private lastPhaseCompleteMode: PomodoroMode | null = null

  constructor(config?: PomodoroConfig) {
    this.config = config ?? { ...DEFAULT_POMODORO_CONFIG }
    this.state = makeInitialState()
    this.state.totalSec = totalSecOf(this.state.mode, this.config)
    this.state.remainingSec = this.state.totalSec
  }

  /** 应用新配置；若有运行中阶段，重置其总时长（保持 remaining 比例） */
  setConfig(c: PomodoroConfig): void {
    const wasRunning = this.state.running
    const wasMode = this.state.mode
    // R22 修复 (medium correctness)：原 `wasRunning = state.running` 在用户
    // 暂停时是 false（非运行中分支），导致 elapsedSec 被无条件清零 —— 用户
    // 18:00/25:00 暂停，把 focusMin 从 25 改成 30，进度瞬间从 7 分钟掉到 0。
    // 区分两种非运行状态：(a) 根本没开始过（elapsedSec=0, startedAt=null），
    // 走原 reset-to-full 分支；(b) 暂停中（startedAt 非空），按比例缩放与
    // 运行中分支对齐。pausedAt 也要清掉，否则 resume() 用 stale 值计算
    // 暂停时长会得到一个非常大的值。
    const wasPaused = !wasRunning && this.state.startedAt != null && this.state.elapsedSec > 0
    this.config = { ...c }
    const newTotal = totalSecOf(wasMode, this.config)
    if (wasRunning || wasPaused) {
      // 运行中或暂停中：按比例缩放 remaining，避免用户改配置后进度丢失
      const ratio = this.state.totalSec > 0 ? this.state.remainingSec / this.state.totalSec : 1
      const newRemaining = Math.max(0, Math.round(newTotal * ratio))
      this.state.totalSec = newTotal
      this.state.remainingSec = newRemaining
      this.state.elapsedSec = newTotal - newRemaining
      // R5-4：缩放后必须重新锚定 startedAt，否则下一帧 tick() 仍按
      // 旧的 wall-clock 计算 elapsed，会把 remainingSec 一秒内打成 0，
      // 立刻触发 advancePhase。把 startedAt 偏移到 "elapsed 已经过去了" 的位置。
      // 暂停状态下，startedAt 已经不参与 tick（由 elapsedSec + pausedAt 决定），
      // 但仍更新以保持字段语义一致；pausedAt 清掉，resume 时不会用 stale 时间。
      if (this.state.startedAt) {
        const targetStartMs = Date.now() - this.state.elapsedSec * 1000
        this.state.startedAt = new Date(targetStartMs).toISOString()
      }
      this.pausedAt = null
      this.emitChange()
    } else {
      // 全新未开始：直接把状态切回该阶段的完整时长
      this.state.totalSec = newTotal
      this.state.remainingSec = newTotal
      this.state.elapsedSec = 0
      this.emitChange()
    }
  }

  /** 开始一个 focus 阶段 */
  start(stickyNoteId: string | null = null): void {
    // P2-fix (timer-race)：若已在运行，覆盖 startedAt 会把 elapsed 悄悄归零，
    // 让用户看起来像「重置了」。改为直接拒绝并发出 log，让上层决定怎么处理。
    if (this.state.running) {
      log.warn('[pomodoro] start() called while running; ignoring to avoid resetting elapsed')
      return
    }
    // R7P-1 修复：若处于暂停中且已有累积 elapsed，start() 应当走 resume 路径，
    // 而不是用「now」覆盖 startedAt 把累积时间悄悄清零（pause→start 期望恢复，
    // 不是重启一个完整阶段）。把 startedAt 往后偏移已暂停的时长，pausedAt 清空。
    if (this.pausedAt !== null && this.state.elapsedSec > 0 && this.state.startedAt) {
      const pauseMs = Date.now() - this.pausedAt
      const newStartedMs = Date.parse(this.state.startedAt) + pauseMs
      this.state.startedAt = new Date(newStartedMs).toISOString()
      this.pausedAt = null
      this.state.running = true
      // stickyNoteId 仅在「全新启动」时传入覆盖；pause→start 保留关联便签
      if (stickyNoteId !== null) this.state.stickyNoteId = stickyNoteId
      this.ensureTicking()
      this.emitTick()
      log.info(`[pomodoro] start->resume (paused) mode=${this.state.mode}`)
      return
    }
    this.state.running = true
    this.state.startedAt = new Date().toISOString()
    this.state.stickyNoteId = stickyNoteId
    // P5-fix (pausedAt-stale)：start 而非 resume 时也要清掉 pausedAt，
    // 否则下一次 pause 时 pausedAt 还是上次的旧值。
    this.pausedAt = null
    // 若已在 focus/break 中点 reset 后又 start，则保持当前 mode（不重置）
    if (this.state.elapsedSec === 0 && this.state.remainingSec === this.state.totalSec) {
      // 全新启动，不变
    }
    this.ensureTicking()
    this.emitTick()
    log.info(`[pomodoro] start mode=${this.state.mode} sticky=${stickyNoteId ?? '-'}`)
  }

  /** 暂停 */
  pause(): void {
    if (!this.state.running) return
    this.state.running = false
    this.pausedAt = Date.now()
    this.stopTimer()
    this.emitChange()
    log.info('[pomodoro] pause')
  }

  /** 恢复 */
  resume(): void {
    if (this.state.running) return
    if (this.state.remainingSec <= 0) return
    // 若 pause 期间有记录 pausedAt，把 startedAt 往后偏移 pause 时长，
    // 这样下一帧 tick() 用 wall-clock 计算 elapsed 时不会跳过暂停。
    if (this.pausedAt !== null && this.state.startedAt) {
      const pauseMs = Date.now() - this.pausedAt
      const newStartedMs = Date.parse(this.state.startedAt) + pauseMs
      this.state.startedAt = new Date(newStartedMs).toISOString()
    } else if (!this.state.startedAt) {
      this.state.startedAt = new Date().toISOString()
    }
    this.pausedAt = null
    this.state.running = true
    this.ensureTicking()
    this.emitTick()
    log.info('[pomodoro] resume')
  }

  /** 完全停止（清除计时，回到初始 focus 阶段） */
  stop(): void {
    const prev = { ...this.state }
    this.stopTimer()
    this.pausedAt = null
    // R-fix-nan-selfheal-skip-suppression (LOW correctness)：stop() 之后
    // state.mode 回到 'focus'，与 lastPhaseCompleteMode='focus' 同名会
    // 触发 skip() 的静默丢弃。完全停止时应一并清掉 skip 抑制窗口，
    // 与 reset() 的「全局回到初始」语义对齐。
    this.lastPhaseCompleteMode = null
    this.state = makeInitialState()
    this.state.totalSec = totalSecOf(this.state.mode, this.config)
    this.state.remainingSec = this.state.totalSec
    this.onStopped?.({ ...prev })
    this.emitChange()
    log.info('[pomodoro] stop')
  }

  /** 跳过当前阶段（直接进入下一阶段，但不自动开始） */
  skip(): void {
    this.stopTimer()
    const prevMode = this.state.mode
    // R-fix-skip-after-natural-complete (MEDIUM concurrency)：若当前 mode 与
    // 上次自然到期的 prevMode 一致，说明 tick() 刚推进到这个阶段（autoStartNext=true
    // 时 break 已经在跑了），用户随后点的 skip 会再触发一次 advancePhase +
    // onPhaseComplete —— UX 上看到"刚休息就完成"的幽灵通知。静默丢弃。
    if (this.lastPhaseCompleteMode !== null && this.state.mode === this.lastPhaseCompleteMode) {
      // 刚被自然进入的下一阶段：静默丢弃这次 skip，并清掉标记让后续真正
      // 的用户 skip（连点 / 第二次点击）能正常生效。
      log.info(
        `[pomodoro] skip() suppressed immediately after natural complete; clearing flag`,
      )
      this.lastPhaseCompleteMode = null
      return
    }
    const finishedSnapshot = {
      mode: prevMode,
      startedAt: this.state.startedAt,
      stickyNoteId: this.state.stickyNoteId,
      totalSec: this.state.totalSec,
      elapsedSec: this.state.elapsedSec,
      // R-fix-skip-sticky-complete (MEDIUM correctness)：把「用户主动跳过」
      // 显式传给 service 层 —— 用户点 skip 的本意是「不想要这次番茄」，
      // 不该把关联便签自动勾掉 status='done'。userSkipped=true 让
      // handlePhaseComplete 知道这是 skip 路径而不是自然完成。
      userSkipped: true,
    }
    this.advancePhase(false)
    // onPhaseComplete 用于在跳过时也允许 service 记录（如 focus 阶段被跳过也记一条未完成的）
    this.onPhaseComplete?.(finishedSnapshot, { ...this.state }, prevMode)
    log.info(`[pomodoro] skip ${prevMode} -> ${this.state.mode}`)
  }

  /** 重置（回到初始 focus 阶段，running=false）。
   *
   * R-fix-timer-engine-reset-stop-drift (LOW structure-drift)：历史上 reset()
   * 一直直接转发到 stop()，但渲染端 store / IPC handler 仍把二者当成独立
   * action 暴露 —— 实际上 service 层 stop() 还有 white-noise / focus-mode
   * 清理副作用，reset() 没有；上层看似两条路径实则行为不一致，是文档与代码
   * 漂移的温床。保留 reset() 仅为向后兼容（外部 / 测试可能直接 import），
   * service 层不再 export reset，所有"重置"动作统一走 stop()。 */
  reset(): void {
    this.stop()
  }

  // ===== 内部 =====

  private ensureTicking(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 每秒滴答 */
  private tick(): void {
    if (!this.state.running) return
    // 基于 wall clock 推导 elapsed/remaining，避免 setInterval 漂移累积
    //
    // R29-Corr-2 修复 (HIGH null/undefined handling)：原版
    // `startedAt ? Date.parse(startedAt) : Date.now()` 在 startedAt 是
    // 非空但非法字符串（null 序列化、损坏、序列化失败）时 Date.parse 返回 NaN，
    // 后续 elapsedSec = (Date.now() - NaN) / 1000 = NaN，`remainingSec <= 0`
    // 判定失败 → emitTick 把 `{remainingSec: NaN}` 广播给所有渲染端，
    // 渲染端格式化 / 进度条数学全崩。修复：检测 NaN 时主动 stop() + reset()
    // 自愈，不再 emitTick。
    let startedAtMs: number
    if (this.state.startedAt) {
      const parsed = Date.parse(this.state.startedAt)
      if (Number.isNaN(parsed)) {
        log.warn(
          `[pomodoro] tick: state.startedAt=${this.state.startedAt} parsed as NaN; self-healing`,
        )
        this.stop()
        // R-fix-nan-selfheal-skip-suppression (LOW correctness)：stop() 之后
        // state.mode 回到 'focus'（makeInitialState 的默认值）。若
        // lastPhaseCompleteMode 之前恰好是 'focus'（自然完成 break 后进入
        // focus 阶段的情形），用户接下来立刻点 skip() 会被顶部的
        // state.mode === lastPhaseCompleteMode 守卫静默丢弃——用户看到的
        // 是「focus 计时器还在跑、我的 skip 不生效」。显式清掉标记。
        this.lastPhaseCompleteMode = null
        this.state.startedAt = null
        this.state.elapsedSec = 0
        this.state.remainingSec = this.state.totalSec
        return
      }
      startedAtMs = parsed
    } else {
      startedAtMs = Date.now()
    }
    const elapsedSec = Math.min(
      this.state.totalSec,
      Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
    )
    this.state.elapsedSec = elapsedSec
    this.state.remainingSec = Math.max(0, this.state.totalSec - elapsedSec)
    // R-fix-skip-after-natural-complete：一旦新阶段实际推进了（elapsedSec > 0），
    // 抑制窗口自然过期 —— 用户对当前阶段有真实时间投入，skip() 不再被静默。
    // 与 advancePhase 的清空形成「tick 推进 / 显式 advance 二选一」的双重保险。
    if (elapsedSec > 0 && this.lastPhaseCompleteMode !== null) {
      this.lastPhaseCompleteMode = null
    }
    if (this.state.remainingSec <= 0) {
      // 阶段完成：先停 timer 并把当前阶段 running 置 false，
      // 再推进到下一阶段（next state 完全确定），
      // 最后才发出完成事件，保证外部观察者看到的事件顺序稳定：
      //   state-changed（advancePhase 内部发出） -> phase-complete
      const prevMode = this.state.mode
      const finishedSnapshot = {
        mode: prevMode,
        startedAt: this.state.startedAt,
        stickyNoteId: this.state.stickyNoteId,
        totalSec: this.state.totalSec,
        elapsedSec: this.state.elapsedSec,
        // 自然到期：与 skip 路径区分，让 service 知道这次完成是「系统判定」
        // 而不是「用户主动放弃」。
        userSkipped: false,
      }
      this.stopTimer()
      this.state.running = false
      this.advancePhase(this.config.autoStartNext)
      // R-fix-skip-after-natural-complete：标记「刚被自然进入的下一阶段」，
      // 后续若用户立刻点 skip()（autoStartNext=true 时新阶段已 running），
      // skip() 顶部检测 state.mode === lastPhaseCompleteMode 即可静默丢弃，
      // 避免对刚启动的 break 多触发一次 onPhaseComplete。
      this.lastPhaseCompleteMode = this.state.mode
      this.onPhaseComplete?.(finishedSnapshot, { ...this.state }, prevMode)
      log.info(`[pomodoro] phase complete ${prevMode} -> ${this.state.mode}`)
    } else {
      this.emitTick()
    }
  }

  /**
   * 切换到下一阶段。
   *   - focus 完成后：cycleIndex+1，根据 (cycleIndex % cycleCount) 决定进入 shortBreak 还是 longBreak
   *   - 任意 break 完成后：进入 focus
   */
  private advancePhase(autoStart: boolean): void {
    // R-fix-skip-after-natural-complete：advancePhase 进入新阶段时清掉
    // lastPhaseCompleteMode（防御性，与 tick() 自然到期后的 set 形成对称）。
    // skip() 路径也会调 advancePhase —— 一旦真的 advancePhase 跑了，说明
    // 这次 skip 是有效的（已经被用户实际经历过的阶段），后续不应再抑制。
    this.lastPhaseCompleteMode = null
    let nextMode: PomodoroMode
    if (this.state.mode === 'focus') {
      const completed = this.state.cycleIndex + 1
      // 第 N 个 focus 完成后进入长休息（默认 N=4）
      const isLong = completed > 0 && completed % this.config.cycleCount === 0
      nextMode = isLong ? 'longBreak' : 'shortBreak'
      this.state.cycleIndex = completed
    } else {
      nextMode = 'focus'
    }
    this.state.mode = nextMode
    this.state.totalSec = totalSecOf(nextMode, this.config)
    this.state.remainingSec = this.state.totalSec
    this.state.elapsedSec = 0
    this.state.startedAt = null
    // R7P-2 修复：推进阶段时清掉 stickyNoteId，否则 break 阶段仍带 focus 的
    // 便签 id，notifyBreakComplete 会以旧便签身份弹通知，handlePhaseComplete
    // 也可能对同一便签重复计数。若未来需要"跨阶段续绑"，应该用显式参数。
    this.state.stickyNoteId = null
    this.state.running = autoStart
    if (autoStart) {
      this.state.startedAt = new Date().toISOString()
      this.ensureTicking()
    }
    this.emitChange()
  }

  private emitTick(): void {
    try {
      this.onTick?.({ ...this.state })
    } catch (err) {
      log.warn('[pomodoro] onTick callback error', err)
    }
  }

  private emitChange(): void {
    try {
      this.onStateChanged?.({ ...this.state })
    } catch (err) {
      log.warn('[pomodoro] onStateChanged callback error', err)
    }
  }
}

/** 全局单例 */
export const timerEngine = new TimerEngine()