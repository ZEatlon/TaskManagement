/**
 * 渲染端 IPC 封装层
 * 提供类型安全、统一的 API 调用入口
 */
import type {
  ID,
  Tag,
  BackfillResult,
  NoteFolder,
  NoteFolderColor,
  NoteMeta,
  StickyNote,
  StickyNoteCreate,
  StickyNoteUpdate,
  StickyNoteStep,
  StickyNoteStepPatch,
  StickyNoteFilter,
  StickyNoteSearchOptions,
} from '@shared/types'
import type { AiConversation, AiMessage, AiStreamEvent, AiConversationFolder } from '@shared/types/ai'
import type {
  GitStatusInfo,
  GitLogEntry,
  GitRemoteInfo,
  GitSyncState,
} from '@shared/ipc/channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'

// 重新导出 AI 共享类型（保持向后兼容 —— stores/ai.ts 等处通过 lib/ipc 引入）
export type { AiStreamEvent }

async function invoke<TReq, TRes>(channel: string, req?: TReq): Promise<TRes> {
  return window.api.invoke<TReq, TRes>(channel, req)
}

// ===== 标签 =====
export const tagsApi = {
  list: () => invoke<undefined, Tag[]>('tag:list'),
  get: (id: string) => invoke<string, Tag | null>('tag:get', id),
  create: (input: { name: string; parentId?: string | null; color?: string | null }) =>
    invoke<typeof input, Tag>('tag:create', input),
  update: (id: string, patch: Partial<Tag>) => invoke<{ id: string; patch: Partial<Tag> }, Tag | null>('tag:update', { id, patch }),
  delete: (id: string) => invoke<string, boolean>('tag:delete', id),
  findByName: (name: string) => invoke<string, Tag | null>('tag:find-by-name', name),
}

// ===== 设置 =====
export const settingsApi = {
  get: <T = unknown>(key: string) => invoke<string, T | null>('setting:get', key),
  set: (key: string, value: unknown) =>
    invoke<{ key: string; value: unknown }, { ok: true }>('setting:set', { key, value }),
  getAll: () => invoke<undefined, Record<string, unknown>>('setting:get-all'),
  delete: (key: string) => invoke<string, { ok: true }>('setting:delete', key),
}

// ===== 数据库 =====
export const dbApi = {
  status: () => invoke<undefined, { initialized: boolean; version: number; path: string; sizeBytes: number }>('db:status'),
  vacuum: () => invoke<undefined, { ok: true }>('db:vacuum'),
}

// ===== 安全 / API Key =====
export const securityApi = {
  isAvailable: () => invoke<undefined, boolean>('security:is-available'),
  set: (key: 'openai.apiKey' | 'anthropic.apiKey' | 'minimax.apiKey' | 'git.token', value: string) =>
    invoke<{ key: typeof key; value: string }, { ok: true }>('security:set', { key, value }),
  // R5S-6：安全 IPC 只返回 `{ present: true; length: number } | null`，
  // 不解密明文。renderer 之前声明成 `string | null` 与主进程契约不符，
  // 一旦有调用方误调 `.startsWith()` 等 string 操作就会运行时崩溃。
  get: (key: 'openai.apiKey' | 'anthropic.apiKey' | 'minimax.apiKey' | 'git.token') =>
    invoke<typeof key, { present: true; length: number } | null>('security:get', key),
  delete: (key: 'openai.apiKey' | 'anthropic.apiKey' | 'minimax.apiKey' | 'git.token') =>
    invoke<typeof key, { ok: true }>('security:delete', key),
  listKeys: () => invoke<undefined, string[]>('security:list-keys'),
}

// ===== AI 对话 =====
export const conversationsApi = {
  /** 旧调用方式：list(limit)；新方式：list({ limit, folderId }) */
  list: (
    limitOrOpts: number | { limit?: number; folderId?: string | null } = 100,
  ) =>
    typeof limitOrOpts === 'number'
      ? invoke<number, AiConversation[]>('ai:list-conversations', limitOrOpts)
      : invoke<typeof limitOrOpts, AiConversation[]>(
          'ai:list-conversations',
          limitOrOpts,
        ),
  get: (id: string) => invoke<string, AiConversation | null>('ai:get-conversation', id),
  create: (input: { provider: string; model: string; title?: string | null; folderId?: string | null }) =>
    invoke<typeof input, AiConversation>('ai:create-conversation', input),
  appendMessage: (id: string, message: AiMessage) =>
    invoke<{ id: string; message: AiMessage }, { ok: true }>('ai:append-message', { id, message }),
  updateTokens: (id: string, input: number, output: number) =>
    invoke<{ id: string; input: number; output: number }, { ok: true }>('ai:update-tokens', { id, input, output }),
  updateTitle: (id: string, title: string) =>
    invoke<{ id: string; title: string }, { ok: true }>('ai:update-title', { id, title }),
  delete: (id: string) =>
    invoke<string, { ok: true }>(IPC_CHANNELS.AI_DELETE_CONVERSATION, id),
  /**
   * 把对话移入指定文件夹（folderId = null = 未分类）。
   * 删除 folder 时主进程也会自动把内部对话 folder_id → NULL，调用方不需要先移走。
   */
  setFolder: (id: string, folderId: string | null) =>
    invoke<{ id: string; folderId: string | null }, { ok: true }>(
      IPC_CHANNELS.AI_SET_CONVERSATION_FOLDER,
      { id, folderId },
    ),
  /** 统计某 folder 下对话数（null = 未分类） */
  countByFolder: (folderId: string | null) =>
    invoke<{ folderId: string | null }, number>(
      IPC_CHANNELS.AI_COUNT_BY_FOLDER,
      { folderId },
    ),
  /**
   * R10 修复：sendMessage 失败时回滚尾部孤儿 userMsg。
   * 主进程 json_remove messages_json 末尾一条。best-effort，调用方不依赖返回值。
   */
  removeLastMessage: (id: string) =>
    invoke<string, { ok: true }>(IPC_CHANNELS.AI_REMOVE_LAST_MESSAGE, id),
  getTotalTokens: () =>
    invoke<undefined, { input: number; output: number }>(IPC_CHANNELS.AI_GET_TOTAL_TOKENS),
}

/** AI 对话文件夹 API（与 noteFoldersApi 隔离） */
export const aiConvFoldersApi = {
  list: () => invoke<undefined, AiConversationFolder[]>(
    IPC_CHANNELS.AI_LIST_CONV_FOLDERS,
  ),
  create: (input: { name: string; color?: NoteFolderColor | null }) =>
    invoke<typeof input, AiConversationFolder>(
      IPC_CHANNELS.AI_CREATE_CONV_FOLDER,
      input,
    ),
  update: (id: string, patch: { name?: string; color?: NoteFolderColor | null; order?: number }) =>
    invoke<{ id: string; patch: typeof patch }, AiConversationFolder | null>(
      IPC_CHANNELS.AI_UPDATE_CONV_FOLDER,
      { id, patch },
    ),
  delete: (id: string) =>
    invoke<string, { deleted: boolean; detachedConversations: number }>(
      IPC_CHANNELS.AI_DELETE_CONV_FOLDER,
      id,
    ),
}

// ===== 完成日志（热力图） =====
export const completionsApi = {
  record: (stickyNoteId: string | null, date: string, count = 1) =>
    invoke<{ stickyNoteId: string | null; date: string; count?: number }, { id: string; stickyNoteId: string | null; date: string; count: number; createdAt: string }>(
      'completion:record',
      { stickyNoteId, date, count },
    ),
  daily: (startDate: string, endDate: string) =>
    invoke<{ startDate: string; endDate: string }, Record<string, number>>('completion:daily', { startDate, endDate }),
  total: (startDate: string, endDate: string) =>
    invoke<{ startDate: string; endDate: string }, number>('completion:total', { startDate, endDate }),
}

export const noteEventsApi = {
  record: (noteId: string | null, date: string, type: 'create' | 'edit' | 'delete' = 'edit') =>
    invoke<{ noteId: string | null; date: string; type?: 'create' | 'edit' | 'delete' }, { ok: true }>(
      'note-event:record',
      { noteId, date, type },
    ),
  daily: (startDate: string, endDate: string) =>
    invoke<{ startDate: string; endDate: string }, Record<string, number>>('note-event:daily', { startDate, endDate }),
}

// ===== 番茄钟（热力图专用） =====
export const pomodorosDailyApi = {
  /** 区间内每日专注分钟数（YYYY-MM-DD → minutes） */
  daily: (startDate: string, endDate: string) =>
    invoke<{ start: string; end: string }, Record<string, number>>('pomodoro:daily', { start: startDate, end: endDate }),
}

// ===== AI（模块 P1-AI）=====
export interface AiProviderInfo {
  id: 'openai' | 'anthropic' | 'minimax'
  name: string
  models: string[]
}

// AiStreamEvent 从 @shared/types/ai 引入

export const aiApi = {
  listProviders: () => invoke<undefined, AiProviderInfo[]>('ai:list-providers'),
  listModels: (providerId: 'openai' | 'anthropic' | 'minimax') =>
    invoke<typeof providerId, string[]>('ai:list-models', providerId),
  testConnection: (
    providerId: 'openai' | 'anthropic' | 'minimax',
    model?: string,
  ) =>
    invoke<
      { providerId: typeof providerId; model?: string } | typeof providerId,
      { ok: boolean; message?: string }
    >('ai:test-connection', model ? { providerId, model } : providerId),
  systemPrompt: () => invoke<undefined, string>('ai:system-prompt'),
  estimateTokens: (
    messages: Array<{ role: string; content: string; name?: string }>,
  ) => invoke<typeof messages, number>('ai:estimate-tokens', messages),
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
  }) => invoke<typeof req, { ok: true; callId: string }>('ai:stream', req),
  abort: (callId: string) => invoke<typeof callId, { ok: boolean }>('ai:abort', callId),

  /**
   * 用户在 UI 明确同意后，真正落盘 AI createNote 工具请求的笔记。
   * 必须由渲染端弹窗确认后才能调用；后端不会重复校验用户意图。
   */
  confirmCreateNote: (payload: { title: string; content: string; toolCallId?: string }) =>
    invoke<
      typeof payload,
      | { ok: true; id: string; filename: string; title: string }
      | { ok: false; error: string }
    >(IPC_CHANNELS.AI_CONFIRM_CREATE_NOTE, payload),

  /**
   * 告诉主进程"用户当前正在编辑的笔记 ID"；
   * summarizeNote 仅对该笔记返回正文，其他笔记只返回元数据。
   * 关闭笔记（卸载编辑器）时传 null。
   */
  setCurrentNoteId: (noteId: string | null) =>
    invoke<typeof noteId, { ok: true }>(IPC_CHANNELS.AI_SET_CURRENT_NOTE_ID, noteId),

  /**
   * R27-Sec-9：NoteEditor mount 时调 noteOpened 把 noteId 注册到主进程的
   * openedNotes 集合（per webContents）；unmount 时调 noteClosed 反注册。
   * summarizeNote 仅对该集合内的 noteId 返回正文，否则只返回元数据。
   * 失败的 IPC 不可阻塞 UI；调用方 fire-and-forget 即可。
   */
  noteOpened: (noteId: string) =>
    invoke<{ noteId: string }, { ok: true }>(IPC_CHANNELS.NOTE_OPENED, { noteId }),
  noteClosed: (noteId: string) =>
    invoke<{ noteId: string }, { ok: true }>(IPC_CHANNELS.NOTE_CLOSED, { noteId }),

  /**
   * R8I-2：通用副作用确认（createSticky / updateSticky / completeSticky 等）。
   * approved=false 时主进程会跳过工具执行并把拒绝消息回灌给 LLM。
   *
   * R9 修复：传入复合键 (callId, toolCallId)，避免不同对话复用 toolCallId。
   *
   * R10 修复：返回类型明确 ok:false + error 字段，让渲染端能区分
   * "用户接受了"vs"等待已过期/已被处理"，不再被静默 no-op 欺骗。
   */
  confirmTool: (callId: string, toolCallId: string, approved: boolean) =>
    invoke<
      { callId: string; toolCallId: string; approved: boolean },
      { ok: true } | { ok: false; error: string }
    >(IPC_CHANNELS.AI_CONFIRM_TOOL, { callId, toolCallId, approved }),
}

// ===== Git 同步 =====
export const gitApi = {
  isRepo: () => invoke<undefined, { isRepo: boolean }>(IPC_CHANNELS.GIT_IS_REPO),
  status: () => invoke<undefined, GitStatusInfo>(IPC_CHANNELS.GIT_STATUS),
  init: () => invoke<undefined, { ok: true; path: string }>(IPC_CHANNELS.GIT_INIT),
  commit: (message: string, author?: { name: string; email: string }) =>
    invoke<{ message: string; author?: { name: string; email: string } }, { sha: string | null }>(
      IPC_CHANNELS.GIT_COMMIT,
      { message, author },
    ),
  pull: () => invoke<undefined, { ok: true }>(IPC_CHANNELS.GIT_PULL),
  push: () => invoke<undefined, { ok: true }>(IPC_CHANNELS.GIT_PUSH),
  log: (depth = 20) => invoke<{ depth?: number }, GitLogEntry[]>(IPC_CHANNELS.GIT_LOG, { depth }),
  getRemote: () => invoke<undefined, GitRemoteInfo | null>(IPC_CHANNELS.GIT_REMOTE_GET),
  setRemote: (url: string, remote = 'origin', confirmHostChange = false) =>
    invoke<{ url: string; remote?: string; confirmHostChange?: boolean }, { ok: true }>(
      IPC_CHANNELS.GIT_REMOTE_SET,
      { url, remote, confirmHostChange },
    ),
  syncNow: () =>
    invoke<undefined, { ok: boolean; error?: string; sha?: string | null }>(IPC_CHANNELS.GIT_SYNC_NOW),
  autoStart: () => invoke<undefined, { ok: true }>(IPC_CHANNELS.GIT_AUTO_START),
  autoStop: () => invoke<undefined, { ok: true }>(IPC_CHANNELS.GIT_AUTO_STOP),
  autoRestart: () => invoke<undefined, { ok: true }>(IPC_CHANNELS.GIT_AUTO_RESTART),
  state: () => invoke<undefined, GitSyncState & { running: boolean }>(IPC_CHANNELS.GIT_STATE),
  commitAndPush: (message: string) =>
    invoke<{ message: string }, { ok: boolean; sha: string | null; error?: string }>(
      IPC_CHANNELS.GIT_AUTO_COMMIT_PUSH,
      { message },
    ),
}

/** 手动触发历史回填（设置页用） */
export const heatmapApi = {
  backfill: (force = false) =>
    invoke<{ force?: boolean }, {
      completions: BackfillResult
      noteEvents: BackfillResult
    }>('completion:backfill', { force }),
}

// ===== 便签（多级待办 / 时间线 / 统一任务实体） =====
// StickyNoteFilter / StickyNoteSearchOptions 已经从 @shared/types 引入
export const stickyNotesApi = {
  /** 按日期范围查便签（含 steps；默认排除 archived） */
  list: (startDate: string, endDate: string) =>
    invoke<{ startDate: string; endDate: string }, StickyNote[]>(
      IPC_CHANNELS.STICKY_NOTE_LIST,
      { startDate, endDate },
    ),
  get: (id: ID) => invoke<ID, StickyNote | null>(IPC_CHANNELS.STICKY_NOTE_GET, id),
  create: (input: StickyNoteCreate) =>
    invoke<StickyNoteCreate, StickyNote>(IPC_CHANNELS.STICKY_NOTE_CREATE, input),
  update: (id: ID, patch: StickyNoteUpdate) =>
    invoke<{ id: ID; patch: StickyNoteUpdate }, StickyNote | null>(
      IPC_CHANNELS.STICKY_NOTE_UPDATE,
      { id, patch },
    ),
  remove: (id: ID) => invoke<ID, boolean>(IPC_CHANNELS.STICKY_NOTE_DELETE, id),
  addStep: (noteId: ID, content: string, order?: number) =>
    invoke<{ noteId: ID; content: string; order?: number }, StickyNoteStep>(
      IPC_CHANNELS.STICKY_NOTE_ADD_STEP,
      { noteId, content, order },
    ),
  updateStep: (stepId: ID, patch: StickyNoteStepPatch) =>
    invoke<{ stepId: ID; patch: StickyNoteStepPatch }, StickyNoteStep | null>(
      IPC_CHANNELS.STICKY_NOTE_UPDATE_STEP,
      { stepId, patch },
    ),
  removeStep: (stepId: ID) =>
    invoke<ID, boolean>(IPC_CHANNELS.STICKY_NOTE_REMOVE_STEP, stepId),

  /* ===== 统一后新增 ===== */

  /** 完成便签：自动写 completions 表 */
  complete: (id: ID, date?: string) =>
    invoke<{ id: ID; date?: string }, StickyNote | null>(
      IPC_CHANNELS.STICKY_NOTE_COMPLETE,
      date ? { id, date } : { id },
    ),
  /** 显式设置状态（todo / in_progress / done / cancelled） */
  setStatus: (id: ID, status: StickyNote['status']) =>
    invoke<{ id: ID; status: StickyNote['status'] }, StickyNote | null>(
      IPC_CHANNELS.STICKY_NOTE_SET_STATUS,
      { id, status },
    ),
  /** 归档 / 取消归档 */
  archive: (id: ID, archived: boolean) =>
    invoke<{ id: ID; archived: boolean }, StickyNote | null>(
      IPC_CHANNELS.STICKY_NOTE_ARCHIVE,
      { id, archived },
    ),
  /** 翻转星标 */
  toggleStarred: (id: ID) =>
    invoke<ID, StickyNote | null>(IPC_CHANNELS.STICKY_NOTE_TOGGLE_STARRED, id),
  /** 模糊搜索（title / description / step content） */
  search: (opts: StickyNoteSearchOptions) =>
    invoke<StickyNoteSearchOptions, StickyNote[]>(
      IPC_CHANNELS.STICKY_NOTE_SEARCH,
      opts,
    ),
  /** 多条件过滤列表 */
  listFiltered: (filter: StickyNoteFilter) =>
    invoke<StickyNoteFilter, StickyNote[]>(
      IPC_CHANNELS.STICKY_NOTE_LIST_FILTERED,
      filter,
    ),
  /** 单独写入 completions（不更新 status） */
  recordCompletion: (id: ID, date: string) =>
    invoke<{ id: ID; date: string }, { id: string; date: string }>(
      IPC_CHANNELS.STICKY_NOTE_RECORD_COMPLETION,
      { id, date },
    ),
}

// ===== 库目录 =====
export interface LibraryValidation {
  valid: boolean
  reason?: string
}

export const libraryApi = {
  selectDirectory: () => invoke<undefined, string | null>('lib:select-directory'),
  getCurrent: () => invoke<undefined, string | null>('lib:get-current'),
  setCurrent: (path: string) =>
    invoke<{ path: string }, { ok: true; path: string }>('lib:set-current', { path }),
  initialize: (path: string) =>
    invoke<{ path: string }, { ok: true; path: string; taskpilotDir: string }>(
      'lib:initialize',
      { path },
    ),
  validate: (path: string) =>
    invoke<{ path: string }, LibraryValidation>('lib:validate', { path }),
  isFirstRun: () => invoke<undefined, boolean>('lib:is-first-run'),
  clear: () => invoke<undefined, { ok: true }>('lib:clear'),
}

// ===== 附件（模块 6）=====
export interface AttachmentUploadResponse {
  url: string
  size: number
  width: number
  height: number
  format: string
}

export const attachmentsApi = {
  upload: (req: { base64: string; mime: string; filename?: string }) =>
    invoke<typeof req, AttachmentUploadResponse>('attachment:upload', req),
  delete: (url: string) =>
    invoke<string, { ok: boolean }>('attachment:delete', url),
  exists: (url: string) =>
    invoke<string, { exists: boolean }>('attachment:exists', url),
}

// ===== 笔记文件夹 =====
export const noteFoldersApi = {
  list: () => invoke<undefined, NoteFolder[]>(IPC_CHANNELS.NOTE_FOLDER_LIST),
  create: (input: { name: string; color?: NoteFolderColor | null }) =>
    invoke<typeof input, NoteFolder>(IPC_CHANNELS.NOTE_FOLDER_CREATE, input),
  update: (id: string, patch: { name?: string; color?: NoteFolderColor | null; order?: number }) =>
    invoke<{ id: string; patch: typeof patch }, NoteFolder | null>(
      IPC_CHANNELS.NOTE_FOLDER_UPDATE,
      { id, patch },
    ),
  delete: (id: string) =>
    invoke<string, { deleted: boolean; detachedNotes: number }>(IPC_CHANNELS.NOTE_FOLDER_DELETE, id),
  moveNote: (noteId: string, folderId: string | null) =>
    invoke<{ noteId: string; folderId: string | null }, NoteMeta | null>(
      IPC_CHANNELS.NOTE_MOVE_TO_FOLDER,
      { noteId, folderId },
    ),
  listByFolder: (
    folderId: string | null | undefined,
    opts?: { archived?: boolean; limit?: number },
  ) =>
    invoke<
      { folderId?: string | null; archived?: boolean; limit?: number },
      NoteMeta[]
    >(IPC_CHANNELS.NOTE_LIST_BY_FOLDER, { folderId, archived: opts?.archived, limit: opts?.limit }),
}

// ===== 笔记 =====
export const notesApi = {
  /** 解析 markdown 里的相对资源路径 → file:// URL（用于 <img>） */
  resolveAsset: (notePath: string, relativePath: string) =>
    invoke<{ notePath: string; relativePath: string }, { fileUrl: string } | null>(
      IPC_CHANNELS.NOTE_RESOLVE_ASSET,
      { notePath, relativePath },
    ),
  /** 导出当前笔记为 PDF（弹保存对话框 → 写盘 → 返回保存路径） */
  exportPdf: (html: string, defaultFilename?: string) =>
    invoke<
      { html: string; defaultFilename?: string },
      { savedPath: string } | null
    >(IPC_CHANNELS.NOTE_EXPORT_PDF, { html, defaultFilename }),
}