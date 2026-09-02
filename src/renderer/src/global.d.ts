/// <reference types="vite/client" />

/**
 * window.api 类型声明（渲染端副本）
 *
 * src/preload/api.d.ts 仅在主/Preload 编译时被加载，
 * 渲染端 tsconfig.web.json 不包含 preload，因此在此处冗余声明以确保类型可用。
 * 结构与 src/preload/api.d.ts 保持同步。
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
  on: <T = unknown>(
    channel: string,
    listener: (event: IpcRendererEvent, payload: T) => void,
  ) => () => void
  once: <T = unknown>(
    channel: string,
    listener: (event: IpcRendererEvent, payload: T) => void,
  ) => void
  removeAllListeners: (channel: string) => void
  readonly platform: NodeJS.Platform
  readonly notify: TaskPilotNotifyApi
  readonly attachments: {
    upload: (req: { base64: string; mime: string; filename?: string }) => Promise<{
      url: string
      size: number
      width: number
      height: number
      format: string
    }>
    delete: (url: string) => Promise<{ ok: boolean }>
    exists: (url: string) => Promise<{ exists: boolean }>
  }
  readonly ai: {
    /** 监听主进程推送的流式增量片段 */
    onChunk: (
      cb: (event: IpcRendererEvent, payload: AiStreamEvent) => void,
    ) => () => void
  }
  readonly window: TaskPilotWindowApi
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

/** AI 流事件载荷从 @shared/types/ai 复用（与 preload 对齐） */

declare global {
  interface Window {
    api: TaskPilotApi
  }
}

export {}
