/**
 * window.api 类型声明
 * 渲染进程通过 window.api 访问主进程能力
 */
import type { IpcRendererEvent } from 'electron'
import type { PingResponse } from '@shared/ipc/channels'
import type { AiStreamEvent } from '@shared/types/ai'

export interface TaskPilotNotifyApi {
  show: (req: {
    title: string
    body?: string
    type?: 'due' | 'scheduled' | 'reminder'
    stickyNoteId?: string
    /** R6I-5：true 时主进程用 Notification.show({ silent: true })，不发系统音 */
    silent?: boolean
  }) => Promise<{ ok: boolean }>
  isSupported: () => Promise<{ supported: boolean }>
  test: () => Promise<{ ok: boolean }>
  onTaskDue: (
    cb: (event: IpcRendererEvent, payload: { id: string; title: string; dueAt?: string | null }) => void,
  ) => () => void
  onReminder: (
    cb: (event: IpcRendererEvent, payload: { id: string; stickyNoteId?: string | null; message: string }) => void,
  ) => () => void
  onShow: (
    cb: (event: IpcRendererEvent, payload: { title: string; body: string; type: string; stickyNoteId?: string }) => void,
  ) => () => void
}

export interface TaskPilotApi {
  ping: () => Promise<PingResponse>
  invoke: <TReq = unknown, TRes = unknown>(channel: string, req?: TReq) => Promise<TRes>
  on: (
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ) => () => void
  once: (
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ) => void
  removeAllListeners: (channel: string) => void
  readonly platform: NodeJS.Platform
  readonly notify: TaskPilotNotifyApi
  readonly attachments: TaskPilotAttachmentApi
  readonly ai: TaskPilotAiApi
  readonly window: TaskPilotWindowApi
}

export interface TaskPilotAttachmentApi {
  upload: (req: {
    base64: string
    mime: string
    filename?: string
  }) => Promise<{ url: string; size: number; width: number; height: number; format: string }>
  delete: (url: string) => Promise<{ ok: boolean }>
  exists: (url: string) => Promise<{ exists: boolean }>
}

/** AI 流事件载荷复用 @shared/types/ai 中的 AiStreamEvent（与 renderer 对齐） */

export interface TaskPilotAiApi {
  /** 监听主进程推送的流式增量片段，返回解绑函数 */
  onChunk: (
    cb: (event: IpcRendererEvent, payload: AiStreamEvent) => void,
  ) => () => void

  /** 列出所有可用 Provider（openai/anthropic/minimax）及各自的 models */
  listProviders: () => Promise<
    Array<{ id: 'openai' | 'anthropic' | 'minimax'; name: string; models: string[] }>
  >

  /** 列出某个 Provider 的可用模型 */
  listModels: (
    providerId: 'openai' | 'anthropic' | 'minimax',
  ) => Promise<string[]>

  /** 测试 Provider 连接（不消耗大量 token） */
  testConnection: (
    providerId: 'openai' | 'anthropic' | 'minimax',
    model?: string,
  ) => Promise<{ ok: boolean; message?: string }>

  /** 取系统提示词（system message） */
  systemPrompt: () => Promise<string>

  /** 估算 messages 的 token 数 */
  estimateTokens: (
    messages: Array<{ role: string; content: string; name?: string }>,
  ) => Promise<number>

  /** 启动一次流式对话（主进程通过 ai:chunk 推送事件） */
  stream: (req: {
    callId: string
    conversationId: string
    messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool'
      content: string
      toolCallId?: string
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
      name?: string
    }>
    model?: string
    temperature?: number
  }) => Promise<{ ok: true; callId: string }>

  /** 主动中止某次流 */
  abort: (callId: string) => Promise<{ ok: boolean }>

  /**
   * 用户在 UI 明确同意后，真正落盘 AI createNote 工具请求的笔记。
   * 后端会写入文件并返回 { ok, id, filename, title }。
   */
  confirmCreateNote: (payload: {
    title: string
    content: string
  }) => Promise<
    | { ok: true; id: string; filename: string; title: string }
    | { ok: false; error: string }
  >

  /**
   * 告诉主进程"用户当前正在编辑的笔记 ID"；
   * 仅该笔记被 AI 的 summarizeNote 调用时返回正文，其他笔记只返回元数据
   * （防止 prompt injection 通过工具返回泄露）。
   * 关闭笔记时传 null。
   */
  setCurrentNoteId: (noteId: string | null) => Promise<{ ok: true }>
  /**
   * R27-Sec-9：NoteEditor mount/unmount 时注册/反注册 noteId 到主进程
   * openedNotes 集合（per webContents）。
   */
  noteOpened: (noteId: string) => Promise<{ ok: true }>
  noteClosed: (noteId: string) => Promise<{ ok: true }>
}

/** 自定义窗口栏控制（frameless traffic lights） */
export interface TaskPilotWindowApi {
  minimize: () => Promise<{ ok: boolean }>
  /** 最大化 / 还原（二选一，主进程根据当前状态判断） */
  toggleMaximize: () => Promise<{ ok: boolean }>
  close: () => Promise<{ ok: boolean }>
  isMaximized: () => Promise<boolean>
  /** 主进程主动推送：maximize / unmaximize 状态变化 */
  onMaximizeChanged: (
    cb: (event: IpcRendererEvent, isMaximized: boolean) => void,
  ) => () => void
}

declare global {
  interface Window {
    api: TaskPilotApi
  }
}

export {}