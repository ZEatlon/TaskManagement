/**
 * W2-B assistant IPC handlers
 *
 * 注册以下通道：
 *   assistant:prefs-get    读偏好（无值返回 DEFAULT）
 *   assistant:prefs-set    写偏好（coerce 后回写 + 通知 daemon 刷新）
 *   assistant:chat-open    渲染端主动拉起对话（不经 daemon 决策；trigger a
 *                          user:manual-ask 事件 → ASSISTANT_CHAT push）
 *
 * 推送事件（无需 handle，daemon 直接 emitToRenderers）：
 *   assistant:hint   { id, category, text, atIso }
 *   assistant:chat   { id, category, prompt, atIso }
 */
import { handle } from './channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import {
  DEFAULT_ASSISTANT_PREFS,
  type AssistantEvent,
  type AssistantPrefs,
} from '../ai/assistantRules'
import {
  loadAssistantPrefs,
  saveAssistantPrefs,
  emitAssistantPrefsChange,
} from '../ai/assistantPrefs'
import { assistantDaemon } from '../ai/assistantDaemon'
import log from '../log'

export function registerAssistantHandlers(): void {
  /** 读偏好 —— 渲染端首次打开设置时调用。 */
  handle<undefined, AssistantPrefs>(IPC_CHANNELS.ASSISTANT_PREFS_GET, async () => {
    return loadAssistantPrefs()
  })

  /** 写偏好 —— daemon 不监听事件，靠 daemon.refreshPrefs() 拉新值。 */
  handle<AssistantPrefs, AssistantPrefs>(
    IPC_CHANNELS.ASSISTANT_PREFS_SET,
    async (_e, prefs) => {
      if (!prefs || typeof prefs !== 'object') {
        log.warn('[assistant-handlers] prefs-set received invalid payload, ignored')
        return DEFAULT_ASSISTANT_PREFS
      }
      const safe = await saveAssistantPrefs(prefs)
      emitAssistantPrefsChange(safe)
      // daemon 已经在 onAssistantPrefsChange 里更新；这里再显式 refresh 一次保险
      await assistantDaemon.refreshPrefs()
      return safe
    },
  )

  /**
   * 渲染端主动拉起对话（绕过 daemon 决策）。
   * - 不做频率上限（用户主动要的）
   * - 仍受「enabled」总开关约束 —— enabled=false 时给渲染端一个明确的 chat 推送，
   *   category = 'pomodoro-reflection'，prompt 写明「AI 助手未启用」，让 UI 显示
   *   「请先在设置开启 AI 助手」。这样比静默失败更清晰。
   */
  handle<{ question: string; category?: string }, { id: string; prompt: string }>(
    IPC_CHANNELS.ASSISTANT_CHAT_OPEN,
    async (_e, args) => {
      const question = typeof args?.question === 'string' ? args.question.trim() : ''
      const id = `manual-chat-${Date.now()}`
      const prefs = await loadAssistantPrefs()
      if (!prefs.enabled) {
        return {
          id,
          prompt: '（AI 助手尚未启用。请在「设置 → AI 助手通知」开启。）',
        }
      }
      const event: AssistantEvent = {
        type: 'user:manual-ask',
        atIso: new Date().toISOString(),
        payload: { question: question || '在吗？' },
      }
      // 让 daemon 走一遍完整决策 + 推送 chat 事件；这里不再单独 push。
      await assistantDaemon.handleEvent(event)
      return { id, prompt: event.payload?.question ?? '' }
    },
  )
}
