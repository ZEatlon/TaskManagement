/**
 * Preload 脚本
 * 通过 contextBridge 暴露 window.api 给渲染进程
 * 渲染进程与主进程的唯一桥梁
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, type PingResponse } from '@shared/ipc/channels'
import type { AiStreamEvent } from '@shared/types/ai'

/**
 * R28-Sec-1 修复 (high security)：原版 `invoke` 完全不校验 channel 名称，
 * 渲染端被 XSS 注入或脚本异常后可以调任意 IPC（security:delete 抹掉 API
 * key、db:vacuum 删表、ai:abort 抢流等）。这里用 IPC_CHANNELS 已声明的
 * 通道白名单收紧：渲染端只能调已经在 channels.ts 注册的通道；任何未知
 * 字符串（即便前缀看起来像 system:/lib:/ai: 等）一律拒掉。
 */
const IPC_CHANNEL_VALUES = new Set<string>(Object.values(IPC_CHANNELS))

// 类型化 IPC 方法集合
const api = {
  /** 系统 ping（连通性检测） */
  ping: (): Promise<PingResponse> => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_PING),

  /** 通用 invoke 封装（仅允许 channels.ts 中已声明的通道） */
  invoke: <TReq = unknown, TRes = unknown>(channel: string, req?: TReq): Promise<TRes> => {
    if (!IPC_CHANNEL_VALUES.has(channel)) {
      return Promise.reject(
        new Error(
          `[preload] invoke 拒绝未知通道：'${channel}'（不在 IPC_CHANNELS 白名单内）`,
        ),
      ) as Promise<TRes>
    }
    return ipcRenderer.invoke(channel, req) as Promise<TRes>
  },

  /** 通用事件监听（支持泛型负载类型，避免渲染端重复断言） */
  on: <T = unknown>(
    channel: string,
    listener: (event: IpcRendererEvent, payload: T) => void,
  ): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: T) => listener(_e, payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  /** 一次性事件 */
  once: <T = unknown>(
    channel: string,
    listener: (event: IpcRendererEvent, payload: T) => void,
  ): void => {
    const handler = (_e: IpcRendererEvent, payload: T) => listener(_e, payload)
    ipcRenderer.once(channel, handler)
  },

  /** 移除所有监听 */
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel)
  },

  /** 平台信息 */
  platform: process.platform,

  /** 通知 API（模块 8） */
  notify: {
    /** 主动弹一条通知 */
    // R6I-5：补 silent 参数 —— 主进程 notify-handlers 已支持 `silent?: boolean`，
    // 这里加上后渲染端就能选择不发出系统提示音（如后台同步完成的静默通知）。
    show: (req: {
      title: string
      body?: string
      type?: 'due' | 'scheduled' | 'reminder'
      stickyNoteId?: string
      silent?: boolean
    }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_SHOW, req),

    /** 当前是否支持系统通知 */
    isSupported: (): Promise<{ supported: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_IS_SUPPORTED),

    /** 弹一条测试通知 */
    test: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_TEST),

    /** 监听"便签到期"事件（主进程推送） */
    onTaskDue: (cb: (event: IpcRendererEvent, payload: { id: string; title: string; dueAt?: string | null }) => void) => {
      const handler = (e: IpcRendererEvent, payload: { id: string; title: string; dueAt?: string | null }) => cb(e, payload)
      ipcRenderer.on(IPC_CHANNELS.STICKY_NOTE_DUE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.STICKY_NOTE_DUE, handler)
    },

    /** 监听"自定义提醒"事件 */
    onReminder: (cb: (event: IpcRendererEvent, payload: { id: string; stickyNoteId?: string | null; message: string }) => void) => {
      const handler = (e: IpcRendererEvent, payload: { id: string; stickyNoteId?: string | null; message: string }) => cb(e, payload)
      ipcRenderer.on(IPC_CHANNELS.NOTIFY_REMINDER, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFY_REMINDER, handler)
    },

    /** 监听通用通知显示事件（主进程推送，独立于 invoke 通道，避免自反馈） */
    onShow: (cb: (event: IpcRendererEvent, payload: { title: string; body: string; type: string; stickyNoteId?: string }) => void) => {
      const handler = (e: IpcRendererEvent, payload: { title: string; body: string; type: string; stickyNoteId?: string }) => cb(e, payload)
      // X1-fix：监听独立 NOTIFY_DISPATCH 通道，而不是 NOTIFY_SHOW（invoke 用），
      // 这样渲染端不会收到自己刚发出的通知。
      ipcRenderer.on(IPC_CHANNELS.NOTIFY_DISPATCH, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFY_DISPATCH, handler)
    },
  },

/** AI API（模块 P1-AI） */
  ai: {
    /** 监听主进程推送的流式增量片段 */
    onChunk: (
      cb: (event: IpcRendererEvent, payload: AiStreamEvent) => void,
    ): (() => void) => {
      const handler = (e: IpcRendererEvent, payload: AiStreamEvent) => cb(e, payload)
      ipcRenderer.on(IPC_CHANNELS.AI_CHUNK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AI_CHUNK, handler)
    },

    /** 列出所有可用 Provider（openai/anthropic/minimax）及各自的 models */
    listProviders: (): Promise<Array<{ id: 'openai' | 'anthropic' | 'minimax'; name: string; models: string[] }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_LIST_PROVIDERS),

    /** 列出某个 Provider 的可用模型 */
    listModels: (providerId: 'openai' | 'anthropic' | 'minimax'): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_LIST_MODELS, providerId),

    /** 测试 Provider 连接（不消耗大量 token） */
    testConnection: (
      providerId: 'openai' | 'anthropic' | 'minimax',
      model?: string,
    ): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.AI_TEST_CONNECTION,
        model ? { providerId, model } : providerId,
      ),

    /** 取系统提示词（system message） */
    systemPrompt: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_SYSTEM_PROMPT),

    /** 估算 messages 的 token 数 */
    estimateTokens: (
      messages: Array<{ role: string; content: string; name?: string }>,
    ): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_ESTIMATE_TOKENS, messages),

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
    }): Promise<{ ok: true; callId: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_STREAM, req),

    /** 主动中止某次流 */
    abort: (callId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_ABORT, callId),

    /**
     * 用户在 UI 明确同意后，真正落盘 AI createNote 工具请求的笔记。
     * 后端会写入文件并返回 { ok, id, filename, title }。
     */
    confirmCreateNote: (payload: {
      title: string
      content: string
    }): Promise<
      | { ok: true; id: string; filename: string; title: string }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.AI_CONFIRM_CREATE_NOTE, payload),

    /**
     * 告诉主进程"用户当前正在编辑的笔记 ID"；
     * 仅该笔记被 AI 的 summarizeNote 调用时返回正文，其他笔记只返回元数据
     * （防止 prompt injection 通过工具返回泄露）。
     * 关闭笔记时传 null。
     */
    setCurrentNoteId: (noteId: string | null): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_SET_CURRENT_NOTE_ID, noteId),
    /**
     * R27-Sec-9：NoteEditor mount/unmount 时调用，注册/反注册 noteId 到主
     * 进程 openedNotes 集合（per webContents）。summarizeNote 仅对该集合内
     * 的 noteId 返回正文，否则只返回元数据。
     */
    noteOpened: (noteId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTE_OPENED, { noteId }),
    noteClosed: (noteId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTE_CLOSED, { noteId }),
  },

/** 附件 API（模块 6） */
  attachments: {
    /** 上传图片（接收 base64 数据 + mime），返回 attachments:// 相对 URL */
    upload: (req: {
      base64: string
      mime: string
      filename?: string
    }): Promise<{ url: string; size: number; width: number; height: number; format: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_UPLOAD, req),

    /** 删除附件 */
    delete: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_DELETE, url),

    /** 检查附件是否存在 */
    exists: (url: string): Promise<{ exists: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_EXISTS, url),
  },

  /** 自定义窗口栏控制（frameless traffic lights） */
  window: {
    minimize: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    /** 最大化 / 还原（二选一，主进程根据当前状态判断） */
    toggleMaximize: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE),
    close: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    /** 主进程主动推送：maximize / unmaximize 状态变化 */
    onMaximizeChanged: (
      cb: (event: IpcRendererEvent, isMaximized: boolean) => void,
    ): (() => void) => {
      const handler = (e: IpcRendererEvent, payload: boolean) => cb(e, payload)
      ipcRenderer.on(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGED, handler)
    },
  },
} as const

try {
  contextBridge.exposeInMainWorld('api', api)
  console.log('[preload] window.api exposed successfully')
} catch (err) {
  console.error('[preload] Failed to expose API:', err)
}

export type TaskPilotApi = typeof api