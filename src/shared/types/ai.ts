/**
 * 共享 AI 类型定义
 *
 * 把主进程的 ai_conversations 消息结构提到 shared，
 * 渲染端与主进程共用，避免跨边界相对导入。
 */

import type { NoteFolderColor } from './index'

// Re-export so backend repositories/handlers can `import type { NoteFolderColor } from '@shared/types/ai'`
// without reaching into `@shared/types/index` directly.
export type { NoteFolderColor }

/** AI 对话文件夹（与 note_folders 隔离的独立表） */
export interface AiConversationFolder {
  id: string
  name: string
  color: NoteFolderColor | null
  order: number
  createdAt: string
  updatedAt: string
}

/** AI 对话中的一条消息 */
export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  toolArgs?: unknown
  toolResult?: unknown
  /**
   * 助手消息携带的工具调用列表（仅 assistant）。
   * 持久化后保证 reload 时多轮工具链路（tool_call + tool 结果）仍可重建，
   * 否则 OpenAI 等接口会因为 assistant 消息后缺少对应 tool 消息而报错。
   */
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
  /** 工具结果消息对应的 toolCallId（仅 tool） */
  toolCallId?: string
  ts: string
}

/** 一个完整 AI 对话 */
export interface AiConversation {
  id: string
  title: string | null
  provider: string
  model: string
  messages: AiMessage[]
  tokenInput: number
  tokenOutput: number
  createdAt: string
  updatedAt: string
  /** 文件夹 ID（null = 未分类；undefined = 字段未读取，与 null 语义一致） */
  folderId: string | null
}

/** AI 流事件载荷（preload / renderer / 主进程共用） */
export interface AiStreamEvent {
  type:
    | 'text'
    | 'tool_call'
    | 'tool_result'
    | 'usage'
    | 'round_start'
    | 'round_end'
    | 'done'
    | 'error'
    | 'aborted'
    // R8I-2：主进程遇到 risk != 'none' 的工具时，先把工具挂起并发此事件
    | 'requires_confirmation'
    // R8I-3：one-shot 工具执行后通知前端"该 toolCallId 已失效，重放应忽略"
    | 'one_shot_consumed'
    // 自动生成标题后通过流事件通知渲染端（首轮对话结束后触发）
    | 'title_updated'
  callId: string
  text?: string
  toolName?: string
  /** R8I-2：UI 用 toolCallId 把确认结果回送给主进程；同一 id 不能复用 */
  toolCallId?: string
  /** R8I-2：风险等级 */
  risk?: 'side-effect' | 'destructive'
  /** R8I-2：人类可读的摘要（"创建便签: XXX"） */
  summary?: string
  args?: unknown
  result?: unknown
  input?: number
  output?: number
  round?: number
  message?: string
  /**
   * R27-Corr-3 修复 (high error-swallowing)：当 persist 阶段失败时主进程
   * 把错误消息通过 done 事件带回来，渲染端用 banner 提示用户「对话未
   * 持久化，下次重启会丢失」。
   */
  persistError?: string
  /** title_updated 事件专用：自动生成的新标题 */
  title?: string
  /** title_updated 事件专用：目标对话 id */
  conversationId?: string
}