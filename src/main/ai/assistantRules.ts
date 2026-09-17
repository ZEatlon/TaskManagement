/**
 * W2-B 助手规则引擎（纯函数）
 *
 * 输入：事件（pomodoro:phase-complete / sticky-note:due / sticky-note:overdue /
 *                   user:manual-ask / app:work-hours-tick）
 *       用户偏好 + 当前时间 + 上次触发时间戳
 * 输出：AssistantAction = ignore | hint | chat
 *
 * 设计原则：
 *   - 全部纯函数，无 IO —— 测试不需要 mock 数据库 / Electron
 *   - 默认偏好「保守」：所有 hint/chat 默认关闭，由用户在 Settings 显式开启
 *   - 频率上限：每个 category 每 60 分钟最多触发一次（默认 3/小时）
 *   - 工作时段外：所有 hint/chat → ignore；manual-ask 不受此限制
 *   - manual-ask 是用户主动拉起 → 不做频率限制 + 不做静音，直接 chat
 */

export type AssistantCategory =
  | 'focus-streak'        // 连续完成番茄的里程碑
  | 'sedentary-reminder'  // 久坐提醒（每 60 分钟）
  | 'motivational-quote'  // 每日励志名言（每日 1 条）
  | 'sticky-overdue'      // 便签超期
  | 'pomodoro-reflection' // 完成时让 AI 反思（chat 而非 hint）
  | 'long-edit-nudge'     // 笔记编辑过久（隐私白纸黑字：只计时，不传内容）

export type AssistantAction = 'ignore' | 'hint' | 'chat'

/** 事件 payload 最小集 —— daemon 监听上游事件时投影成的统一格式 */
export interface AssistantEvent {
  type: 'pomodoro:phase-complete'
    | 'sticky-note:due'
    | 'sticky-note:overdue'
    | 'user:manual-ask'
    | 'app:work-hours-tick'
    | 'note-event:long-edit'
  atIso: string  // 事件时间戳（ISO 字符串）
  /** 事件上下文 —— 规则引擎只读取它，不修改。 */
  payload?: {
    pomodoro?: { mode: 'focus' | 'shortBreak' | 'longBreak'; cycleIndex: number }
    stickyNoteId?: string
    stickyTitle?: string
    /** 距 due 的分钟数；仅 sticky-note:overdue 有 */
    overdueMinutes?: number
    /** long-edit 持续分钟数；仅 note-event:long-edit 有 */
    editingMinutes?: number
    /** 用户主动问的 prompt；仅 user:manual-ask 有 */
    question?: string
  }
}

/** 助手偏好 —— 与 settings 存储一致 */
export interface AssistantPrefs {
  enabled: boolean               // 总开关（关闭后所有规则 → ignore）
  workHours: { startHour: number; endHour: number }   // 工作时段 [start, end)
  frequencyCapPerHour: number    // 每 category 每小时上限（默认 3）
  mutedCategories: AssistantCategory[]  // 静音列表（默认全空）
  customHints: Partial<Record<AssistantCategory, string>>  // 用户自定义文案
}

export const DEFAULT_ASSISTANT_PREFS: AssistantPrefs = {
  enabled: false,
  workHours: { startHour: 9, endHour: 18 },
  frequencyCapPerHour: 3,
  mutedCategories: [],
  customHints: {},
}

/** 决策依赖的运行时上下文（不持有 React/IO 状态） */
export interface RuleContext {
  prefs: AssistantPrefs
  /** 上次成功触发该 category 的时间戳（毫秒） */
  lastFiredMs: Partial<Record<AssistantCategory, number>>
  /** 当前时间（毫秒）—— 注入便于测试 */
  nowMs: number
}

export interface RuleDecision {
  action: AssistantAction
  /** 当 action !== 'ignore' 时填充：路由到哪个 category + 默认文案 */
  category?: AssistantCategory
  hintText?: string
  /** 当 action === 'chat' 时填充：拼好的 prompt（rule 自己拼最简单文案） */
  chatPrompt?: string
}

// ───── 辅助判定 ─────

/** 「工作时段内」—— 用本地小时（用户偏好也是本地概念；不归一化到 UTC）。 */
export function isWithinWorkHours(nowMs: number, prefs: AssistantPrefs): boolean {
  const hour = new Date(nowMs).getHours()
  const { startHour, endHour } = prefs.workHours
  // 支持 start > end（跨夜，例如 22 → 6）的情况：先把 hour 投影到 [start, start+24)
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour
  }
  return hour >= startHour || hour < endHour
}

/** 频率上限：距上次触发 < (60min / cap) 分钟则 suppress。 */
export function isWithinRateLimit(
  category: AssistantCategory,
  ctx: RuleContext,
): boolean {
  const last = ctx.lastFiredMs[category]
  if (!last) return true
  const cap = Math.max(1, ctx.prefs.frequencyCapPerHour)
  const minIntervalMs = (60 * 60 * 1000) / cap
  return ctx.nowMs - last >= minIntervalMs
}

// ───── 默认 hint 文案 ─────

const DEFAULT_HINT_TEXT: Record<AssistantCategory, string> = {
  'focus-streak':       '又完成一个专注番茄。要不要起来走 2 分钟？',
  'sedentary-reminder': '你已经伏案超过 60 分钟，建议站起来拉伸一下。',
  'motivational-quote': '专注是稀缺的资产，今天的每一分钟都在为未来储蓄。',
  'sticky-overdue':     '有便签已经超期 —— 是否要重新评估优先级？',
  'pomodoro-reflection': '这次专注有什么值得记住的？打开 AI 助手回顾一下。',
  'long-edit-nudge':    '你已经在笔记上连续工作 25 分钟 —— 短暂休息能让思路更清晰。',
}

// ───── 决策入口 ─────

/**
 * 主决策函数 —— 全部规则汇总。
 *
 * 顺序：
 *   1. 总开关 enabled=false → ignore
 *   2. event → category 映射
 *   3. category 在静音列表 → ignore
 *   4. 工作时段外（user:manual-ask 除外） → ignore
 *   5. 频率上限抑制 → ignore
 *   6. 选择 action（hint vs chat）
 */
export function decide(event: AssistantEvent, ctx: RuleContext): RuleDecision {
  if (!ctx.prefs.enabled) return { action: 'ignore' }

  const category = mapEventToCategory(event)
  if (!category) return { action: 'ignore' }
  if (ctx.prefs.mutedCategories.includes(category)) return { action: 'ignore' }
  if (event.type !== 'user:manual-ask' && !isWithinWorkHours(ctx.nowMs, ctx.prefs)) {
    return { action: 'ignore' }
  }
  if (event.type !== 'user:manual-ask' && !isWithinRateLimit(category, ctx)) {
    return { action: 'ignore' }
  }

  // user:manual-ask 永远走 chat，不做 hint 化（用户主动要的就是对话）
  if (event.type === 'user:manual-ask') {
    return {
      action: 'chat',
      category,
      chatPrompt: event.payload?.question ?? '在吗？',
    }
  }

  // pomodoro-reflection 与 long-edit-nudge：默认 chat（用户要思考）
  // 其余：hint
  const wantsChat = category === 'pomodoro-reflection'

  const customText = ctx.prefs.customHints[category]
  const text = customText?.trim() ? customText : DEFAULT_HINT_TEXT[category]

  return wantsChat
    ? { action: 'chat', category, chatPrompt: text }
    : { action: 'hint', category, hintText: text }
}

/** 把事件归一到一个 category。返回 null 表示「这条事件不在我们关心范围内」。 */
export function mapEventToCategory(event: AssistantEvent): AssistantCategory | null {
  switch (event.type) {
    case 'pomodoro:phase-complete': {
      const mode = event.payload?.pomodoro?.mode
      // focus 完成才算「里程碑」；break 完成不打扰
      return mode === 'focus' ? 'focus-streak' : null
    }
    case 'sticky-note:due':
      // 在 due 时点是中性提示；直接 ignore（系统通知已经发了）
      return null
    case 'sticky-note:overdue':
      return 'sticky-overdue'
    case 'app:work-hours-tick':
      return 'sedentary-reminder'
    case 'note-event:long-edit':
      return 'long-edit-nudge'
    case 'user:manual-ask':
      return 'pomodoro-reflection' // 当作 chat category 但 prompt 由 event 注入
    default:
      return null
  }
}
