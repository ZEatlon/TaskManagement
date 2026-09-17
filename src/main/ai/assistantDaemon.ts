/**
 * W2-B 助手 daemon（混合型）
 *
 * 监听事件源：
 *   - pomodoro:phase-complete —— TimerEngine.onPhaseComplete hook
 *   - sticky-note:due / sticky-note:overdue —— StickyNotifier 钩子（占位：
 *     现有 notifier 已用 OS toast 提醒 due，daemon 只补一条 hint 即可）
 *   - app:work-hours-tick —— 每分钟定时器（用于 sedentary reminder）
 *   - user:manual-ask —— 渲染端通过 IPC 主动调用（user:prefs:set 内置
 *     assistant:chat:open 通道，不走 daemon 决策；但 daemon 也要知道
 *     以便 lastFired 不被错算）
 *
 * 决策：assistantRules.decide(event, ctx)
 * 输出：
 *   - hint  → emitToRenderers(ASSISTANT_HINT, {category, text, id})
 *   - chat  → emitToRenderers(ASSISTANT_CHAT, {category, prompt, id})
 *
 * 持久化：lastFiredMs 不入库 —— 仅内存即可（重启后重新累计；频率上限
 *   是分钟级别，重启间隙天然允许 1 次噪声）。
 */
import * as assistantRules from './assistantRules'
import {
  DEFAULT_ASSISTANT_PREFS,
  type AssistantCategory,
  type AssistantEvent,
  type AssistantPrefs,
  type RuleDecision,
} from './assistantRules'
import { loadAssistantPrefs, saveAssistantPrefs, onAssistantPrefsChange } from './assistantPrefs'
import { emitToRenderers } from '../ipc/emit'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import log from '../log'

/** 工作时段 tick 的间隔：1 分钟（用于 sedentary reminder 的「每 60 分钟」判断） */
const WORK_HOURS_TICK_INTERVAL_MS = 60 * 1000

class AssistantDaemon {
  private prefs: AssistantPrefs = { ...DEFAULT_ASSISTANT_PREFS }
  private lastFiredMs: Partial<Record<AssistantCategory, number>> = {}
  private workHoursTimer: NodeJS.Timeout | null = null
  private sedEntryMs: number | null = null  // 进入工作时段的时刻；60min 后提醒
  private running = false
  private seq = 0  // 推送给渲染端的 id 序号

  /** 在 index.ts 启动后调用一次。 */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.prefs = await loadAssistantPrefs()
    onAssistantPrefsChange((p) => {
      this.prefs = p
      this.sedEntryMs = null  // 偏好变了重置 sedentary 计数
    })
    this.startWorkHoursTicker()
    log.info('[assistant-daemon] started, enabled =', this.prefs.enabled)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.workHoursTimer) {
      clearInterval(this.workHoursTimer)
      this.workHoursTimer = null
    }
  }

  /** 渲染端更新偏好后由 IPC handler 调用。 */
  async refreshPrefs(): Promise<void> {
    this.prefs = await loadAssistantPrefs()
  }

  /** 渲染端 / 其他模块主动触发事件（不走 hook 的临时通道）。 */
  async handleEvent(event: AssistantEvent): Promise<RuleDecision> {
    if (!this.running) return { action: 'ignore' }
    const ctx = {
      prefs: this.prefs,
      lastFiredMs: this.lastFiredMs,
      nowMs: Date.now(),
    }
    const decision = assistantRules.decide(event, ctx)
    if (decision.action === 'ignore') return decision

    // 命中频率上限后已经记录 lastFired；保证「刚刚判断 ignore」的下次也走完路径
    this.lastFiredMs[decision.category!] = ctx.nowMs

    if (decision.action === 'hint') {
      const id = `hint-${++this.seq}`
      emitToRenderers(IPC_CHANNELS.ASSISTANT_HINT, {
        id,
        category: decision.category,
        text: decision.hintText,
        atIso: new Date().toISOString(),
      })
    } else if (decision.action === 'chat') {
      const id = `chat-${++this.seq}`
      emitToRenderers(IPC_CHANNELS.ASSISTANT_CHAT, {
        id,
        category: decision.category,
        prompt: decision.chatPrompt,
        atIso: new Date().toISOString(),
      })
    }
    log.info(
      `[assistant-daemon] ${event.type} → ${decision.action} (${decision.category ?? '?'})`,
    )
    return decision
  }

  // ───── 工作时段 + sedentary 计时 ─────

  private startWorkHoursTicker(): void {
    this.tick()  // 启动后立刻跑一次（让 sedentary 计数从 0 开始）
    this.workHoursTimer = setInterval(() => this.tick(), WORK_HOURS_TICK_INTERVAL_MS)
  }

  private tick(): void {
    const now = Date.now()
    const inside = assistantRules.isWithinWorkHours(now, this.prefs)
    if (!inside) {
      this.sedEntryMs = null
      return
    }
    if (this.sedEntryMs === null) {
      this.sedEntryMs = now
      return
    }
    // 进入工作时段 ≥ 60 分钟 → 触发 sedentary hint（如果静音/未启用则 ignore）
    if (now - this.sedEntryMs >= 60 * 60 * 1000) {
      void this.handleEvent({ type: 'app:work-hours-tick', atIso: new Date(now).toISOString() })
      // 触发后把基准往后推 60 分钟，避免每分钟连发（频率上限本来也会拦截，
      // 但不依赖那个保险）
      this.sedEntryMs = now
    }
  }

  // ───── Hook 形式：直接挂到 TimerEngine.onPhaseComplete ─────

  /** TimerEngine.onPhaseComplete 钩子 —— 替代默认 undefined callback。 */
  onPomodoroPhaseComplete(finished: {
    mode: 'focus' | 'shortBreak' | 'longBreak'
    cycleIndex: number
  }): void {
    void this.handleEvent({
      type: 'pomodoro:phase-complete',
      atIso: new Date().toISOString(),
      payload: { pomodoro: finished },
    })
  }

  /** StickyService 钩子 —— 由 notifier 在 due/overdue 时调用。 */
  onStickyOverdue(stickyNoteId: string, stickyTitle: string, overdueMinutes: number): void {
    void this.handleEvent({
      type: 'sticky-note:overdue',
      atIso: new Date().toISOString(),
      payload: { stickyNoteId, stickyTitle, overdueMinutes },
    })
  }

  /** NoteService 钩子 —— 笔记连续编辑超过 N 分钟（不上传内容，仅计时）。 */
  onNoteLongEdit(editingMinutes: number): void {
    void this.handleEvent({
      type: 'note-event:long-edit',
      atIso: new Date().toISOString(),
      payload: { editingMinutes },
    })
  }
}

export const assistantDaemon = new AssistantDaemon()

// 进程关闭时清理 timer
process.once('beforeExit', () => {
  assistantDaemon.stop()
})

// Re-export 类型/常量让 IPC handler 直接 import
export { saveAssistantPrefs, loadAssistantPrefs }
