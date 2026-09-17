/**
 * 渲染端 IPC 封装层
 * 提供类型安全、统一的 API 调用入口
 */
import type {
  ID,
  Tag,
  BackfillResult,
  Note,
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
  list: () => invoke<undefined, Tag[]>(IPC_CHANNELS.TAG_LIST),
  get: (id: string) => invoke<string, Tag | null>(IPC_CHANNELS.TAG_GET, id),
  create: (input: { name: string; parentId?: string | null; color?: string | null }) =>
    invoke<typeof input, Tag>(IPC_CHANNELS.TAG_CREATE, input),
  update: (id: string, patch: Partial<Tag>) => invoke<{ id: string; patch: Partial<Tag> }, Tag | null>(IPC_CHANNELS.TAG_UPDATE, { id, patch }),
  delete: (id: string) => invoke<string, boolean>(IPC_CHANNELS.TAG_DELETE, id),
  findByName: (name: string) => invoke<string, Tag | null>(IPC_CHANNELS.TAG_FIND_BY_NAME, name),
}

// ===== 设置 =====
export const settingsApi = {
  get: <T = unknown>(key: string) => invoke<string, T | null>(IPC_CHANNELS.SETTING_GET, key),
  set: (key: string, value: unknown) =>
    invoke<{ key: string; value: unknown }, { ok: true }>(IPC_CHANNELS.SETTING_SET, { key, value }),
  getAll: () => invoke<undefined, Record<string, unknown>>(IPC_CHANNELS.SETTING_GET_ALL),
  delete: (key: string) => invoke<string, { ok: true }>(IPC_CHANNELS.SETTING_DELETE, key),
}

// ===== 数据库 =====
export const dbApi = {
  status: () => invoke<undefined, { initialized: boolean; version: number; path: string; sizeBytes: number }>(IPC_CHANNELS.DB_STATUS),
  vacuum: () => invoke<undefined, { ok: true }>(IPC_CHANNELS.DB_VACUUM),
}

// ===== 安全 / API Key =====
export const securityApi = {
  isAvailable: () => invoke<undefined, boolean>(IPC_CHANNELS.SECURITY_IS_AVAILABLE),
  set: (key: 'openai.apiKey' | 'anthropic.apiKey' | 'minimax.apiKey' | 'git.token', value: string) =>
    invoke<{ key: typeof key; value: string }, { ok: true }>(IPC_CHANNELS.SECURITY_SET, { key, value }),
  // R-fix-security-get-contract-drift (LOW contract-drift)：与 main 进程
  // security-handlers.ts:59 对齐 —— handler 只返回 `{ present: true } | null`，
  // 不返回 length。R11 修复 (low #5) 已经把 length 字段从 IPC payload 中
  // 删掉以避免「密文长度 → 间接区分 provider」的信息泄漏；renderer 侧
  // 类型与 preload api.d.ts 没同步收紧是文档漂移，让「支持 bundle 读 length」
  // 的潜在需求一旦引入就会 undefined-crash。同步把类型收紧。
  get: (key: 'openai.apiKey' | 'anthropic.apiKey' | 'minimax.apiKey' | 'git.token') =>
    invoke<typeof key, { present: true } | null>(IPC_CHANNELS.SECURITY_GET, key),
  delete: (key: 'openai.apiKey' | 'anthropic.apiKey' | 'minimax.apiKey' | 'git.token') =>
    invoke<typeof key, { ok: true }>(IPC_CHANNELS.SECURITY_DELETE, key),
  listKeys: () => invoke<undefined, string[]>(IPC_CHANNELS.SECURITY_LIST_KEYS),
}

// ===== W2-B：AI 助手 daemon =====
// 与 main/ai/assistantRules.ts 类型对齐 —— 注释「source of truth」。
interface AssistantPrefs {
  enabled: boolean
  workHours: { startHour: number; endHour: number }
  frequencyCapPerHour: number
  mutedCategories: AssistantCategory[]
  customHints: Partial<Record<AssistantCategory, string>>
}
type AssistantCategory =
  | 'focus-streak'
  | 'sedentary-reminder'
  | 'motivational-quote'
  | 'sticky-overdue'
  | 'pomodoro-reflection'
  | 'long-edit-nudge'

export const assistantApi = {
  /** 读偏好（无值返回 DEFAULT）。 */
  getPrefs: () =>
    invoke<undefined, AssistantPrefs>(IPC_CHANNELS.ASSISTANT_PREFS_GET, undefined),
  /** 写偏好（主进程 coerce 后回写并通知 daemon）。 */
  setPrefs: (prefs: AssistantPrefs) =>
    invoke<AssistantPrefs, AssistantPrefs>(IPC_CHANNELS.ASSISTANT_PREFS_SET, prefs),
  /** 渲染端主动拉起对话 —— 走 daemon.handleEvent 走完整决策链路。 */
  openChat: (question: string) =>
    invoke<{ question: string }, { id: string; prompt: string }>(
      IPC_CHANNELS.ASSISTANT_CHAT_OPEN,
      { question },
    ),
}

// ===== AI 对话 =====
export const conversationsApi = {
  /** 旧调用方式：list(limit)；新方式：list({ limit, folderId }) */
  list: (
    limitOrOpts: number | { limit?: number; folderId?: string | null } = 100,
  ) =>
    typeof limitOrOpts === 'number'
      ? invoke<number, AiConversation[]>(IPC_CHANNELS.AI_LIST_CONVERSATIONS, limitOrOpts)
      : invoke<typeof limitOrOpts, AiConversation[]>(
          IPC_CHANNELS.AI_LIST_CONVERSATIONS,
          limitOrOpts,
        ),
  get: (id: string) => invoke<string, AiConversation | null>(IPC_CHANNELS.AI_GET_CONVERSATION, id),
  create: (input: { provider: string; model: string; title?: string | null; folderId?: string | null }) =>
    invoke<typeof input, AiConversation>(IPC_CHANNELS.AI_CREATE_CONVERSATION, input),
  appendMessage: (id: string, message: AiMessage) =>
    invoke<{ id: string; message: AiMessage }, { ok: true }>(IPC_CHANNELS.AI_APPEND_MESSAGE, { id, message }),
  updateTokens: (id: string, input: number, output: number) =>
    invoke<{ id: string; input: number; output: number }, { ok: true }>(IPC_CHANNELS.AI_UPDATE_TOKENS, { id, input, output }),
  updateTitle: (id: string, title: string) =>
    invoke<{ id: string; title: string }, { ok: true }>(IPC_CHANNELS.AI_UPDATE_TITLE, { id, title }),
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
      IPC_CHANNELS.COMPLETION_RECORD,
      { stickyNoteId, date, count },
    ),
  daily: (startDate: string, endDate: string) =>
    invoke<{ startDate: string; endDate: string }, Record<string, number>>(IPC_CHANNELS.COMPLETION_DAILY, { startDate, endDate }),
  total: (startDate: string, endDate: string) =>
    invoke<{ startDate: string; endDate: string }, number>(IPC_CHANNELS.COMPLETION_TOTAL, { startDate, endDate }),
}

export const noteEventsApi = {
  record: (noteId: string | null, date: string, type: 'create' | 'edit' | 'delete' = 'edit') =>
    invoke<{ noteId: string | null; date: string; type?: 'create' | 'edit' | 'delete' }, { ok: true }>(
      IPC_CHANNELS.NOTE_EVENT_RECORD,
      { noteId, date, type },
    ),
  daily: (startDate: string, endDate: string) =>
    invoke<{ startDate: string; endDate: string }, Record<string, number>>(IPC_CHANNELS.NOTE_EVENT_DAILY, { startDate, endDate }),
}

// ===== 番茄钟（热力图专用） =====
export const pomodorosDailyApi = {
  /** 区间内每日专注分钟数（YYYY-MM-DD → minutes） */
  daily: (startDate: string, endDate: string) =>
    invoke<{ start: string; end: string }, Record<string, number>>(IPC_CHANNELS.POMODORO_DAILY, { start: startDate, end: endDate }),
}

// ===== AI（模块 P1-AI）=====
export interface AiProviderInfo {
  id: 'openai' | 'anthropic' | 'minimax'
  name: string
  models: string[]
}

// AiStreamEvent 从 @shared/types/ai 引入

export const aiApi = {
  listProviders: () => invoke<undefined, AiProviderInfo[]>(IPC_CHANNELS.AI_LIST_PROVIDERS),
  listModels: (providerId: 'openai' | 'anthropic' | 'minimax') =>
    invoke<typeof providerId, string[]>(IPC_CHANNELS.AI_LIST_MODELS, providerId),
  testConnection: (
    providerId: 'openai' | 'anthropic' | 'minimax',
    model?: string,
  ) =>
    invoke<
      { providerId: typeof providerId; model?: string } | typeof providerId,
      { ok: boolean; message?: string }
    >(IPC_CHANNELS.AI_TEST_CONNECTION, model ? { providerId, model } : providerId),
  systemPrompt: () => invoke<undefined, string>(IPC_CHANNELS.AI_SYSTEM_PROMPT),
  estimateTokens: (
    messages: Array<{ role: string; content: string; name?: string }>,
  ) => invoke<typeof messages, number>(IPC_CHANNELS.AI_ESTIMATE_TOKENS, messages),
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
  }) => invoke<typeof req, { ok: true; callId: string }>(IPC_CHANNELS.AI_STREAM, req),
  abort: (callId: string) => invoke<typeof callId, { ok: boolean }>(IPC_CHANNELS.AI_ABORT, callId),

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
   * 把"用户当前正在操作的便签 ID"推到主进程。仅用作 system prompt
   * 上下文提示（advisory），不参与权限校验。卸载便签时传 null。
   * 失败的 IPC 不可阻塞 UI；调用方 fire-and-forget 即可。
   */
  setCurrentStickyId: (stickyId: string | null) =>
    invoke<typeof stickyId, { ok: true }>(
      IPC_CHANNELS.AI_SET_CURRENT_STICKY_ID,
      stickyId,
    ),

  /**
   * R33 修复 (medium #2)：compare-and-clear。
   * StickyNoteCard unmount 时调用，传入当前 noteId；主进程仅在 stickyId
   * 仍等于 noteId 时才清空。避免多张同 id 卡同挂时 A 卸载把 B 推过来的
   * stickyId 误清。失败的 IPC 不可阻塞 UI；调用方 fire-and-forget 即可。
   */
  clearStickyIdIfMatches: (noteId: string) =>
    invoke<{ noteId: string }, { ok: true; cleared: boolean }>(
      IPC_CHANNELS.AI_CLEAR_STICKY_ID_IF_MATCHES,
      { noteId },
    ),

  /**
   * 把"番茄钟当前阶段"推到主进程。仅用作 system prompt 上下文提示
   * （advisory），不参与权限校验。停止时传 null。
   */
  setCurrentPomodoroContext: (
    payload:
      | {
          running: boolean
          mode: 'focus' | 'shortBreak' | 'longBreak'
          stickyNoteId: string | null
        }
      | null,
  ) =>
    invoke<typeof payload, { ok: true }>(
      IPC_CHANNELS.AI_SET_CURRENT_POMODORO_CONTEXT,
      payload,
    ),

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
  /**
   * R-fix-git-tab-broken (critical correctness)：持久化自动推送配置
   * （gitAutoPushEnabled / gitPushIntervalMinutes）到 app.settings。
   * 走 setting:set 通用通道会被主进程拒收（详见 git-handlers.ts 中
   * GIT_SET_CONFIG 注释）。调用方传入 undefined 字段表示「保持原值」。
   */
  setConfig: (cfg: { enabled?: boolean; intervalMinutes?: number }) =>
    invoke<
      { enabled?: boolean; intervalMinutes?: number },
      { ok: true; enabled: boolean; intervalMinutes: number }
    >(IPC_CHANNELS.GIT_SET_CONFIG, cfg),
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
    }>(IPC_CHANNELS.COMPLETION_BACKFILL, { force }),
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

export interface LibraryScanResult {
  path: string
  hasTaskpilotDir: boolean
  noteCount: number
  attachmentCount: number
  totalBytes: number
  extraSubdirCount: number
  error?: string
}

export interface LibraryMigrateResult {
  copiedFiles: number
  copiedBytes: number
  sourcePath: string
  destPath: string
  sourceHadData: boolean
}

export const libraryApi = {
  selectDirectory: () => invoke<undefined, string | null>(IPC_CHANNELS.LIB_SELECT_DIRECTORY),
  getCurrent: () => invoke<undefined, string | null>(IPC_CHANNELS.LIB_GET_CURRENT),
  setCurrent: (path: string) =>
    invoke<{ path: string }, { ok: true; path: string }>(IPC_CHANNELS.LIB_SET_CURRENT, { path }),
  initialize: (path: string) =>
    invoke<{ path: string }, { ok: true; path: string; taskpilotDir: string }>(
      IPC_CHANNELS.LIB_INITIALIZE,
      { path },
    ),
  validate: (path: string) =>
    invoke<{ path: string }, LibraryValidation>(IPC_CHANNELS.LIB_VALIDATE, { path }),
  isFirstRun: () => invoke<undefined, boolean>(IPC_CHANNELS.LIB_IS_FIRST_RUN),
  clear: () => invoke<undefined, { ok: true }>(IPC_CHANNELS.LIB_CLEAR),
  /**
   * 扫描指定路径：返回 .taskpilot 子目录的数据现状（笔记数 / 附件数 /
   * 占用字节 / 子目录数 / error）。
   *
   * 用于「切换库目录」前先预览新目录里已有多少数据：
   *   - hasTaskpilotDir=false → 新目录为空，可选初始化
   *   - hasTaskpilotDir=true && noteCount>0 → 新目录里已有数据
   *     （"解析原有仓库数据"模式：直接 setCurrent 即可）
   *   - error 有值 → 路径无效 / 不可读，不阻塞流程
   */
  scan: (path: string) =>
    invoke<{ path: string }, LibraryScanResult>(IPC_CHANNELS.LIB_SCAN, { path }),
  /**
   * 把当前库（<libraryPath>/.taskpilot/）数据复制到 destPath。
   * 复制完成后 .taskpilot/notes 下既有 src 笔记 + dest 笔记（如有），
   * chokidar 自动 ingest；调用方接着 setCurrent 切到新路径。
   */
  migrate: (destPath: string) =>
    invoke<{ destPath: string }, LibraryMigrateResult>(
      IPC_CHANNELS.LIB_MIGRATE,
      { destPath },
    ),
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
    invoke<typeof req, AttachmentUploadResponse>(IPC_CHANNELS.ATTACHMENT_UPLOAD, req),
  delete: (url: string) =>
    invoke<string, { ok: boolean }>(IPC_CHANNELS.ATTACHMENT_DELETE, url),
  exists: (url: string) =>
    invoke<string, { exists: boolean }>(IPC_CHANNELS.ATTACHMENT_EXISTS, url),
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
  /**
   * 批量按多 folderId 拉笔记：sidebar 多文件夹预览场景。单 IPC + 单 SQL
   * 比连点 listByFolder 节省 N-1 轮 round-trip（20 个文件夹 ≈ 20-60ms）。
   * 返回 Record<folderId, NoteMeta[]>；null（未分类）以 key `'null'` 返回。
   */
  listByFolders: (
    folderIds: Array<string | null>,
    opts?: { archived?: boolean; limit?: number },
  ) =>
    invoke<
      { folderIds: Array<string | null>; archived?: boolean; limit?: number },
      Record<string, NoteMeta[]>
    >(IPC_CHANNELS.NOTE_LIST_BY_FOLDERS, {
      folderIds,
      archived: opts?.archived,
      limit: opts?.limit,
    }),
}

// ===== 笔记 =====
// 笔记模块的本地端 IPC 三态（与主进程 ConflictResolution / notesManager 共享）
type NoteLocalFileState = 'clean' | 'modified' | 'conflict'
type NoteConflictResolution = 'keepLocal' | 'keepRemote' | 'merge'

export const notesApi = {
  /**
   * 列出笔记（按 archived / starred / limit 过滤）。
   * R39-fix-notes-store-typed-wrapper (high structure)：stores/notes.ts 原先
   * 三处裸调 `window.api.invoke('note:list', ...)`，绕过 lib/ipc.ts 类型
   * 安全网，主进程 handler 入参 schema 变更时无法编译报错暴露调用方。
   * 全部 11 处裸调用收敛到本对象后，wrapper 成为 single source of truth。
   */
  list: (opts?: { archived?: boolean; starred?: boolean; limit?: number }) =>
    invoke<typeof opts, NoteMeta[]>(IPC_CHANNELS.NOTE_LIST, opts),
  /** 读取完整笔记（按绝对 path），未找到返回 null */
  read: (path: string) =>
    invoke<string, Note | null>(IPC_CHANNELS.NOTE_READ, path),
  /**
   * 写入或新建笔记：传 path = 覆盖已有；只传 filename / content = 新建；
   * frontmatter（tags / starred / archived）会落到 YAML frontmatter。
   * 主进程 MAX_CONTENT_BYTES = 5 MiB 上限在此不重复校验，handler 内已做。
   */
  write: (payload: {
    path?: string
    filename?: string
    content: string
    frontmatter?: Record<string, unknown>
    folderId?: string | null
  }) =>
    invoke<typeof payload, Note>(IPC_CHANNELS.NOTE_WRITE, payload),
  /** 按绝对 path 删除笔记，返回成功与否（主进程 handler 不抛错） */
  remove: (path: string) =>
    invoke<string, boolean>(IPC_CHANNELS.NOTE_DELETE, path),
  /**
   * 模糊搜索：query + limit + folderId 收窄。folderId = string 收窄到该文件夹；
   * folderId = null 仅在「未分类」；folderId 缺省跨文件夹搜。
   */
  search: (payload: { query: string; limit?: number; folderId?: string | null }) =>
    invoke<typeof payload, NoteMeta[]>(IPC_CHANNELS.NOTE_SEARCH, payload),
  /** 按 tag 列出（folderId 收窄语义同上） */
  listByTag: (payload: { tag: string; folderId?: string | null }) =>
    invoke<typeof payload, NoteMeta[]>(IPC_CHANNELS.NOTE_TAG_LIST, payload),
  /**
   * 上报内存编辑（驱动 conflict 状态机），返回主进程维护的最新 state。
   * 失败 IPC 在 stores/notes.ts reportEdit 内仅 console.warn，不阻塞 UI。
   */
  reportEdit: (payload: { path: string; content: string }) =>
    invoke<typeof payload, { state: NoteLocalFileState }>(
      IPC_CHANNELS.NOTE_REPORT_EDIT,
      payload,
    ),
  /**
   * 解决冲突（keepLocal / keepRemote / merge + 可选 mergedContent）。
   * state 在 keepLocal / merge 后续由前端 open() 重读决定，handler 仅返回
   * `{ state: NoteLocalFileState | null }`，null 通常代表冲突已不存在。
   */
  resolve: (payload: {
    path: string
    resolution: NoteConflictResolution
    mergedContent?: string
  }) =>
    invoke<typeof payload, { state: NoteLocalFileState | null }>(
      IPC_CHANNELS.NOTE_RESOLVE,
      payload,
    ),
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

  // ─── W2-A④：回收站（软删除 + 还原 + 永久删除）───
  /** 软删除（移到回收站，磁盘文件保留）。 */
  trash: (path: string) =>
    invoke<string, NoteMeta | null>(IPC_CHANNELS.NOTE_TRASH, path),
  /** 从回收站还原（清 deleted_at）。 */
  restore: (path: string) =>
    invoke<string, NoteMeta | null>(IPC_CHANNELS.NOTE_RESTORE, path),
  /** 永久删除（清磁盘 + DB row + revisions）。 */
  purge: (path: string) =>
    invoke<string, boolean>(IPC_CHANNELS.NOTE_PURGE, path),
  /** 列回收站里的笔记（deleted_at IS NOT NULL）。 */
  listTrash: () =>
    invoke<undefined, NoteMeta[]>(IPC_CHANNELS.NOTE_LIST_TRASH, undefined),

  // ─── W2-A④：版本历史（每条笔记最多 50 个 snapshot）───
  listRevisions: (noteId: string) =>
    invoke<
      { noteId: string },
      Array<{
        id: number
        noteId: string
        createdAt: string
        length: number
        source: 'auto' | 'manual'
      }>
    >(IPC_CHANNELS.NOTE_LIST_REVISIONS, { noteId }),
  readRevision: (revisionId: number) =>
    invoke<
      { revisionId: number },
      {
        id: number
        noteId: string
        createdAt: string
        length: number
        source: 'auto' | 'manual'
        content: string
        frontmatter: string
      } | null
    >(IPC_CHANNELS.NOTE_READ_REVISION, { revisionId }),
  /** 还原某条 revision 为当前正文（同时把当前正文 snapshot 进 history）。 */
  restoreRevision: (revisionId: number) =>
    invoke<{ revisionId: number }, Note | null>(
      IPC_CHANNELS.NOTE_RESTORE_REVISION,
      { revisionId },
    ),
}

// ===== Mock 数据清理（一次性：移除历史版本自动写入的 mock 数据）=====
export const mockApi = {
  /**
   * 把 mock 自动塞的笔记 / sticky / pomodoros 从用户 library 移除。
   * 幂等：找不到任何匹配时返回全 0。
   */
  cleanup: () =>
    invoke<
      undefined,
      { deletedNotes: number; deletedStickies: number; deletedPomodoros: number }
    >(IPC_CHANNELS.MOCK_CLEANUP),
}