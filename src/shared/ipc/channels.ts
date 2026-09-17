/**
 * 共享 IPC 通道常量与类型
 * 主进程、preload、渲染进程三方共用
 * 新增通道时在此处集中声明
 */
import type { LocaleValue } from '../i18n/locales'

/**
 * 设置仓库中的 sub-key 常量
 * 跨主进程 / 渲染进程共享，避免字符串硬编码
 */
export const SETTINGS_KEY_APP = 'app.settings'
export const SETTINGS_KEY_AI = 'app.ai'

/**
 * 通道名称常量
 */
export const IPC_CHANNELS = {
  // 系统
  SYSTEM_PING: 'system:ping',
  SYSTEM_OPEN_EXTERNAL: 'system:open-external',
  /**
   * 渲染端报告运行时错误（ErrorBoundary / window.onerror / unhandledrejection），
   * 主进程收下后写 log（已含 stack + componentStack）。原 R7S-2 设计：让主
   * 进程 boot-trace 能拿到渲染端 crash；旧实现漏注册 → preload 白名单
   * 静默 reject，错误报告全丢。
   */
  APP_ERROR: 'app:error',
  // Shell（唤起系统资源管理器等）
  SHELL_OPEN_PATH: 'shell:open-path',

  // 库目录
  LIB_SELECT_DIRECTORY: 'lib:select-directory',
  LIB_GET_CURRENT: 'lib:get-current',
  LIB_SET_CURRENT: 'lib:set-current',
  LIB_INITIALIZE: 'lib:initialize',
  LIB_VALIDATE: 'lib:validate',
  LIB_IS_FIRST_RUN: 'lib:is-first-run',
  LIB_CLEAR: 'lib:clear',
  /**
   * 扫描指定路径：报告是否有 .taskpilot 子目录、笔记 / 附件 / 占用大小。
   * 切换库目录前用于预览"新目录是否已有数据"（解析原有仓库数据路径）。
   */
  LIB_SCAN: 'lib:scan',
  /**
   * 把当前库的数据（.taskpilot/ 整棵子树）复制到新路径；之后 setCurrent。
   * 出参 { copiedFiles, copiedBytes, sourcePath, destPath }。
   */
  LIB_MIGRATE: 'lib:migrate',

  // 便签（多级待办 / 时间线 / 统一任务实体）
  STICKY_NOTE_LIST: 'sticky-note:list',
  STICKY_NOTE_GET: 'sticky-note:get',
  STICKY_NOTE_CREATE: 'sticky-note:create',
  STICKY_NOTE_UPDATE: 'sticky-note:update',
  STICKY_NOTE_DELETE: 'sticky-note:delete',
  STICKY_NOTE_ADD_STEP: 'sticky-note:add-step',
  STICKY_NOTE_UPDATE_STEP: 'sticky-note:update-step',
  STICKY_NOTE_REMOVE_STEP: 'sticky-note:remove-step',
  // 统一后新增的能力：完成 / 状态 / 归档 / 星标 / 搜索 / 过滤 / 完成记录
  STICKY_NOTE_COMPLETE: 'sticky-note:complete',
  STICKY_NOTE_SET_STATUS: 'sticky-note:set-status',
  STICKY_NOTE_ARCHIVE: 'sticky-note:archive',
  STICKY_NOTE_TOGGLE_STARRED: 'sticky-note:toggle-starred',
  STICKY_NOTE_SEARCH: 'sticky-note:search',
  STICKY_NOTE_LIST_FILTERED: 'sticky-note:list-filtered',
  STICKY_NOTE_RECORD_COMPLETION: 'sticky-note:record-completion',

  // 标签
  TAG_LIST: 'tag:list',
  TAG_GET: 'tag:get',
  TAG_CREATE: 'tag:create',
  TAG_UPDATE: 'tag:update',
  TAG_DELETE: 'tag:delete',
  TAG_FIND_BY_NAME: 'tag:find-by-name',
  // W1-D：笔记 ↔ 标签关系（单一真源 note_tags 表）
  TAG_LIST_FOR_NOTE: 'tag:list-for-note',
  TAG_SET_FOR_NOTE: 'tag:set-for-note',

  // 设置（key/value 存储）
  SETTING_GET: 'setting:get',
  SETTING_SET: 'setting:set',
  SETTING_GET_ALL: 'setting:get-all',
  SETTING_DELETE: 'setting:delete',

  // 笔记（模块 4 占位）
  NOTE_LIST: 'note:list',
  NOTE_READ: 'note:read',
  NOTE_WRITE: 'note:write',
  NOTE_DELETE: 'note:delete',
  NOTE_WATCH_START: 'note:watch-start',
  NOTE_WATCH_STOP: 'note:watch-stop',
  NOTE_SEARCH: 'note:search',
  NOTE_TAGS: 'note:tags',
  NOTE_TAG_LIST: 'note:tag-list',
  NOTE_REPORT_EDIT: 'note:report-edit',
  NOTE_RESOLVE: 'note:resolve',
  NOTE_FILE_STATE: 'note:file-state',
  NOTE_FILE_STATES: 'note:file-states',
  NOTE_RENAME: 'note:rename',
  NOTE_SET_STARRED: 'note:set-starred',
  /**
   * 解析 markdown 里的相对资源路径（图片 / 附件）为 file:// URL。
   * 入参 notePath 用于解析相对路径（相对当前笔记所在目录），
   * 出参 { fileUrl } 可直接放进 <img src>。解析失败 / 越界返回 null。
   */
  NOTE_RESOLVE_ASSET: 'note:resolve-asset',
  /**
   * 导出当前笔记为 PDF：渲染端把待打印 HTML 文本发给主进程，
   * 主进程用隐藏 BrowserWindow 调用 webContents.printToPDF() 落盘。
   * 入参 { html, defaultFilename }，出参 { savedPath } | null（用户取消）。
   */
  NOTE_EXPORT_PDF: 'note:export-pdf',
  // W2-A④：回收站（soft delete + restore + 永久删除）
  NOTE_TRASH: 'note:trash',
  NOTE_RESTORE: 'note:restore',
  NOTE_PURGE: 'note:purge',
  NOTE_LIST_TRASH: 'note:list-trash',
  // W2-A④：版本历史
  NOTE_LIST_REVISIONS: 'note:list-revisions',
  NOTE_READ_REVISION: 'note:read-revision',
  NOTE_RESTORE_REVISION: 'note:restore-revision',
  /**
   * 一次性清理历史版本自动写入的 mock 数据（笔记 + sticky + pomodoros）。
   * 出参 { deletedNotes, deletedStickies, deletedPomodoros }。
   */
  MOCK_CLEANUP: 'mock:cleanup',

  // W2-B：混合型 AI 助手 daemon（偏好 + 主动拉起对话 + 推送 hint/chat）
  ASSISTANT_PREFS_GET: 'assistant:prefs-get',
  ASSISTANT_PREFS_SET: 'assistant:prefs-set',
  ASSISTANT_CHAT_OPEN: 'assistant:chat-open',
  // 主进程主动推送到渲染进程的事件
  ASSISTANT_HINT: 'assistant:hint',
  ASSISTANT_CHAT: 'assistant:chat',
  // 主进程主动推送到渲染进程的笔记事件
  NOTE_FS_EVENT: 'note:fs-event',

  // 笔记文件夹（v1：扁平列表，无嵌套；详见 migrations/005-note-folders.sql）
  NOTE_FOLDER_LIST: 'note-folder:list',
  NOTE_FOLDER_CREATE: 'note-folder:create',
  NOTE_FOLDER_UPDATE: 'note-folder:update',
  NOTE_FOLDER_DELETE: 'note-folder:delete',
  NOTE_LIST_BY_FOLDER: 'note:list-by-folder',
  /**
   * 批量按多文件夹拉笔记：sidebar / 多文件夹预览场景用，单 SQL 走
   * `folder_id IN (...)` 减少 N 轮 round-trip。
   * 入参 { folderIds: (string|null)[], archived?, limit? }
   * 出参 Record<string|null, NoteMeta[]>（key = folderId；null = 未分类）
   */
  NOTE_LIST_BY_FOLDERS: 'note:list-by-folders',
  NOTE_MOVE_TO_FOLDER: 'note:move-to-folder',

  // 完成日志（热力图）
  COMPLETION_RECORD: 'completion:record',
  COMPLETION_DAILY: 'completion:daily',
  COMPLETION_TOTAL: 'completion:total',
  COMPLETION_BACKFILL: 'completion:backfill',
  NOTE_EVENT_RECORD: 'note-event:record',
  NOTE_EVENT_DAILY: 'note-event:daily',

  // 安全 / API Key
  SECURITY_IS_AVAILABLE: 'security:is-available',
  SECURITY_SET: 'security:set',
  SECURITY_GET: 'security:get',
  SECURITY_DELETE: 'security:delete',
  SECURITY_LIST_KEYS: 'security:list-keys',

  // AI 对话（持久化）
  AI_LIST_CONVERSATIONS: 'ai:list-conversations',
  AI_GET_CONVERSATION: 'ai:get-conversation',
  AI_CREATE_CONVERSATION: 'ai:create-conversation',
  AI_APPEND_MESSAGE: 'ai:append-message',
  AI_UPDATE_TOKENS: 'ai:update-tokens',
  AI_UPDATE_TITLE: 'ai:update-title',
  AI_DELETE_CONVERSATION: 'ai:delete-conversation',
  AI_GET_TOTAL_TOKENS: 'ai:get-total-tokens',
  /** R10 修复：sendMessage 失败时回滚尾部孤儿 userMsg */
  AI_REMOVE_LAST_MESSAGE: 'ai:remove-last-message',
  /** 把对话移入指定文件夹（null = 未分类） */
  AI_SET_CONVERSATION_FOLDER: 'ai:set-conversation-folder',
  /** 统计某 folder 下对话数（null = 未分类） */
  AI_COUNT_BY_FOLDER: 'ai:count-by-folder',

  // AI 对话文件夹（与 note_folders 隔离的独立表）
  AI_LIST_CONV_FOLDERS: 'ai-conv-folder:list',
  AI_CREATE_CONV_FOLDER: 'ai-conv-folder:create',
  AI_UPDATE_CONV_FOLDER: 'ai-conv-folder:update',
  AI_DELETE_CONV_FOLDER: 'ai-conv-folder:delete',

  // 数据库（模块 2 占位）
  DB_STATUS: 'db:status',
  DB_VACUUM: 'db:vacuum',

  // AI（模块 P1-AI）
  AI_STREAM: 'ai:stream',
  AI_CHUNK: 'ai:chunk', // 主进程主动推送：流式增量片段
  AI_LIST_PROVIDERS: 'ai:list-providers',
  AI_LIST_MODELS: 'ai:list-models',
  AI_ESTIMATE_TOKENS: 'ai:estimate-tokens',
  AI_SYSTEM_PROMPT: 'ai:system-prompt',
  AI_TEST_CONNECTION: 'ai:test-connection',
  AI_ABORT: 'ai:abort',
  /** AI 工具请求创建笔记后，由渲染端在用户明确同意后调用真正落盘 */
  AI_CONFIRM_CREATE_NOTE: 'ai:confirm-create-note',
  // R8I-2：通用副作用确认（createSticky / updateSticky / completeSticky 等）
  AI_CONFIRM_TOOL: 'ai:confirm-tool',
  /** 渲染端告知主进程当前正在编辑的笔记 ID；用于控制 summarizeNote 是否返回正文 */
  AI_SET_CURRENT_NOTE_ID: 'ai:set-current-note-id',
  // R27-Sec-9：NoteEditor mount/unmount 时调用，注册/反注册当前打开的笔记；
  // main process 据此决定 summarizeNote 是否返回正文。
  NOTE_OPENED: 'note:opened',
  NOTE_CLOSED: 'note:closed',
  /**
   * InlineAIButton 上下文同步：StickyNoteCard mount/unmount 时调用，
   * 把当前便签 ID 推到主进程的 aiContextByWebContents 供 stream.ts
   * 注入 system prompt。仅 advisory —— 不参与权限校验。
   */
  AI_SET_CURRENT_STICKY_ID: 'ai:set-current-sticky-id',
  /**
   * R33 修复 (medium #2)：compare-and-clear 通道。
   * StickyNoteCard unmount 时调用，传入当前 noteId；主进程仅在 stickyId
   * 仍等于 noteId 时才清空，避免多卡同挂时 A 卸载把 B 推过来的 stickyId
   * 误清。详见 src/main/ai/tools.ts:clearStickyIdIfMatches。
   */
  AI_CLEAR_STICKY_ID_IF_MATCHES: 'ai:clear-sticky-id-if-matches',
  /**
   * InlineAIButton 上下文同步：PomodoroTimerPanel 订阅 mode / running /
   * stickyNoteId 变化时调用，把番茄钟状态推到主进程。仅 advisory。
   */
  AI_SET_CURRENT_POMODORO_CONTEXT: 'ai:set-current-pomodoro-context',
  /**
   * R33-fix：AI 工具 navigate() 跳路由时主进程主动推送给渲染端的事件通道。
   * payload: { route: string, focusStickyId: string | null }。
   * 渲染端 preload 监听后桥接到 react-router 的 navigate()。
   * 配套的 AI_NAVIGATE_ACK 是渲染端回执：应用路由后再回送 ack，主进程
   * 端 await ack 才返回 ok:true，避免「事件已发出但页面没动」的乐观成功。
   */
  AI_NAVIGATE: 'app:navigate',
  AI_NAVIGATE_ACK: 'app:navigate-ack',

  // Git 同步（模块 P0-12）
  GIT_STATUS: 'git:status',
  GIT_PULL: 'git:pull',
  GIT_PUSH: 'git:push',
  GIT_INIT: 'git:init',
  GIT_COMMIT: 'git:commit',
  GIT_LOG: 'git:log',
  GIT_REMOTE_GET: 'git:remote-get',
  GIT_REMOTE_SET: 'git:remote-set',
  GIT_IS_REPO: 'git:is-repo',
  GIT_SYNC_NOW: 'git:sync-now',
  GIT_AUTO_START: 'git:auto-start',
  GIT_AUTO_STOP: 'git:auto-stop',
  GIT_AUTO_RESTART: 'git:auto-restart',
  GIT_STATE: 'git:state',
  GIT_AUTO_COMMIT_PUSH: 'git:auto-commit-push',
  /**
   * R-fix-git-tab-broken (critical correctness)：GitTab 原版把
   * gitAutoPushEnabled / gitPushIntervalMinutes / remoteUrl 塞进
   * setting:set({key:'app.git', value:{...}}) 走通用通道 —— 三者都是
   * app.git 的 privileged 字段，主进程 assertPrivilegedFieldsNotTouched
   * 直接拒（"field 'X' in 'app.git' is privileged"），设置 UI 静默失效。
   * remoteUrl 走已有的 git:remote-set；自动推送配置需要专用通道，因为：
   *   - 这两个字段实际存储在 app.settings（不是 app.git）
   *   - setting:set 顶层 key 'gitAutoPushEnabled' 也会被拒（TOP_LEVEL_KEY_TO_DOC 命中）
   *   - 设置 app.settings 含 gitAutoPushEnabled 同样被拒（PRIVILEGED_FIELDS_BY_DOC.settings 命中）
   * 新通道只持久化这两个字段到 app.settings，调用方可以安全地批量写入。
   */
  GIT_SET_CONFIG: 'git:set-config',
  // 主进程主动推送到渲染进程的事件
  GIT_STATE_CHANGED: 'git:state-changed',
  GIT_SYNC_START: 'git:sync-start',
  GIT_SYNC_END: 'git:sync-end',
  GIT_SYNC_ERROR: 'git:sync-error',

  // 自定义窗口栏控制（frameless window traffic lights）
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  // 主进程主动推送：maximize / unmaximize 状态变化
  WINDOW_ON_MAXIMIZE_CHANGED: 'window:on-maximize-changed',

  // 通知（模块 P0-8 占位）
  NOTIFY_SHOW: 'notify:show',
  /** 主进程 → 渲染进程的「通知已派发」事件通道。
   *  与 NOTIFY_SHOW（renderer→main invoke）分离，避免渲染端 onShow 收到自己刚发出的通知。 */
  NOTIFY_DISPATCH: 'notify:dispatch',
  NOTIFY_IS_SUPPORTED: 'notify:is-supported',
  NOTIFY_TEST: 'notify:test',
  // 主进程主动推送到渲染进程的事件
  STICKY_NOTE_DUE: 'sticky-note:due',
  NOTIFY_REMINDER: 'notify:reminder',
  /**
   * R-fix-notify-persist-failed (medium silent-error)：notifications 表 INSERT
   * 失败（SQLITE_FULL / SQLITE_BUSY / schema 漂移导致 no such column 等）时
   * 主进程推送，渲染端可弹一次性 sticky diagnostic「通知写入失败：<reason>」。
   * payload: { title: string, stickyNoteId?: string, reason: string }
   * 与 NOTIFY_DISPATCH 互斥：本通道失败时不派发 in-app banner（历史表里也
   * 没记录），所以 UI 需要另一条独立通道告知用户。
   */
  NOTIFY_PERSIST_FAILED: 'notify:persist-failed',
  /**
   * R-fix-notify-toast-failed (medium silent-error)：OS toast 弹失败
   * （Windows Focus Assist / 通知被组策略关闭 / macOS 通知权限被拒 /
   * Linux libnotify 缺失）时主进程推送，渲染端写入诊断 bundle。语义是
   * 「系统 toast 这一个渠道失败」，不影响 in-app banner（NOTIFY_DISPATCH）
   * —— 所以本通道不替代 NOTIFY_DISPATCH，只是给支持 bundle 多一条线索。
   * payload: { title: string, reason: string }
   */
  NOTIFY_TOAST_FAILED: 'notify:toast-failed',

  // 番茄钟（模块 P1-Pomodoro）
  POMODORO_START: 'pomodoro:start',
  POMODORO_PAUSE: 'pomodoro:pause',
  POMODORO_RESUME: 'pomodoro:resume',
  POMODORO_STOP: 'pomodoro:stop',
  POMODORO_SKIP: 'pomodoro:skip',
  POMODORO_RESET: 'pomodoro:reset',
  POMODORO_GET_STATE: 'pomodoro:get-state',
  POMODORO_GET_CONFIG: 'pomodoro:get-config',
  POMODORO_UPDATE_CONFIG: 'pomodoro:update-config',
  POMODORO_TODAY: 'pomodoro:today',
  POMODORO_DAILY: 'pomodoro:daily',
  /**
   * 最近 N 条 focus 完成记录（默认 50）。渲染端「历史专注」/ 调试面板可
   * 用其替代 listToday 拿全量窗口。补齐 pomodoroService.listRecent
   * 的 IPC 暴露面（详见 R-fix-pomodoro-listrecent-unexposed）。
   * payload: PomodoroRecord[]
   */
  POMODORO_RECENT: 'pomodoro:recent',
  // 主进程主动推送到渲染进程的事件
  POMODORO_TICK: 'pomodoro:tick',
  POMODORO_PHASE_COMPLETE: 'pomodoro:phase-complete',
  POMODORO_STATE_CHANGED: 'pomodoro:state-changed',
  /**
   * R-fix-pomodoro-persist-silent-fail (medium error-handling)：phase
   * 完成写入 pomodoros 表失败（且单次重试仍失败）时主进程推送，渲染
   * 端弹 toast「本次专注未记录：<原因>」让用户知情。原本只在 log
   * 里报错，用户看不到失败现象（计时停了但通知/热力图/统计都没更新）。
   * payload: { phase: 'focus' | 'shortBreak' | 'longBreak', durationMin: number, reason: string }
   */
  POMODORO_PERSIST_FAILED: 'pomodoro:persist-failed',
  /**
   * 专注模式（focus mode overlay）状态变更：主进程在 start/stop/完成时根据
   * config.autoEnterFocusMode 推送，渲染端 store 订阅后切 overlay。
   * payload: { focusMode: boolean, reason: 'start' | 'stop' | 'complete' | 'manual' }
   */
  POMODORO_FOCUS_MODE_CHANGED: 'pomodoro:focus-mode-changed',
  /**
   * 主进程要求渲染端启动 / 停止白噪音（Web Audio 在渲染端跑）。
   * payload: { kind: PomodoroWhiteNoise }
   */
  POMODORO_AUDIO_SET: 'pomodoro:audio-set',
  /**
   * 主进程要求渲染端播放「阶段完成」音效（清脆一声）。
   * payload: { mode: 'focus' | 'shortBreak' | 'longBreak' }
   */
  POMODORO_AUDIO_PLAY_SOUND: 'pomodoro:audio-play-sound',

  // 附件（模块 P0-6）
  ATTACHMENT_UPLOAD: 'attachment:upload',
  ATTACHMENT_DELETE: 'attachment:delete',
  ATTACHMENT_EXISTS: 'attachment:exists',

  // 自动更新（electron-updater）
  /**
   * 主进程 → 渲染端：状态变化推送（订阅一次，状态流式更新）
   * payload: UpdaterState
   */
  UPDATER_STATUS: 'updater:status',
  /** 渲染端 → 主进程：主动检查更新（无参） */
  UPDATER_CHECK: 'updater:check',
  /** 渲染端 → 主进程：开始下载已发现的更新（无参） */
  UPDATER_DOWNLOAD: 'updater:download',
  /** 渲染端 → 主进程：退出并安装新版本（无参） */
  UPDATER_INSTALL: 'updater:install',
  /** 渲染端 → 主进程：取当前状态（无参；返回 UpdaterState） */
  UPDATER_GET_STATE: 'updater:get-state',
} as const

export type IpcChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]

/**
 * 通用响应类型
 */
export interface PingResponse {
  pong: number
  version: string
}

export interface AppSettings {
  libraryPath: string | null
  /** 界面语言：值来自 src/shared/i18n/locales.ts 的 LOCALE_OPTIONS，
   *  通过 LocaleValue 联合类型保持单一来源。加新 locale 不用改本字段。 */
  language: LocaleValue
  theme: 'auto' | 'light' | 'dark'
  /** 强调色（CSS 颜色值，对应 --accent 变量） */
  accentColor: string
  density: 'compact' | 'comfortable'
  fontSize: number
  enableNotifications: boolean
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  gitAutoPushEnabled: boolean
  gitPushIntervalMinutes: number
  /** AI 提供商：openai / anthropic / minimax */
  aiProvider: 'openai' | 'anthropic' | 'minimax' | null
  /** 当前选中的 OpenAI 模型 */
  aiOpenaiModel: string
  /** 当前选中的 Anthropic 模型 */
  aiAnthropicModel: string
  /** 当前选中的 MiniMax 模型 */
  aiMinimaxModel: string
  /**
   * 各 Provider 的自定义 baseURL。
   * - 空字符串 / 未设置：使用 SDK 默认（或 MiniMax 默认的 /anthropic 子路径）
   * - 非空：覆盖默认值，常用于自定义代理 / 第三方兼容端点
   */
  aiOpenaiBaseUrl?: string
  aiAnthropicBaseUrl?: string
  aiMinimaxBaseUrl?: string
  /** 总开关 */
  aiEnabled: boolean
  /**
   * 快捷键用户覆盖：key = ShortcutDef.id，value = binding 字符串（如 "mod+k"、"mod+shift+p"）。
   * - 空对象 / 字段未设置 → 全部快捷键用 SHORTCUT_DEFS 默认值
   * - 单项缺失 → 该项用默认值（向后兼容）
   */
  shortcutOverrides?: Record<string, string>
}

export const DEFAULT_SETTINGS: AppSettings = {
  libraryPath: null,
  language: 'zh-CN',
  theme: 'auto',
  accentColor: '#58a6ff',
  density: 'comfortable',
  fontSize: 14,
  enableNotifications: true,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  gitAutoPushEnabled: false,
  gitPushIntervalMinutes: 5,
  aiProvider: null,
  aiOpenaiModel: 'gpt-4o-mini',
  aiAnthropicModel: 'claude-3-5-sonnet-latest',
  aiMinimaxModel: 'MiniMax-M3',
  aiOpenaiBaseUrl: '',
  aiAnthropicBaseUrl: '',
  aiMinimaxBaseUrl: '',
  aiEnabled: false,
}

/**
 * Git 同步相关共享类型
 */

/** 仓库状态（status 调用返回） */
export interface GitStatusInfo {
  /** 远端领先本地多少提交（pull 之前） */
  ahead: number
  /** 本地领先远端多少提交（push 之前） */
  behind: number
  /** 已修改但未提交的文件路径（相对仓库根） */
  modified: string[]
  /** 未跟踪文件（新增未 add） */
  untracked: string[]
  /** R11 修复 (medium #33)：已从 workdir 删除但仍 staged 或 HEAD 仍记录的文件路径 */
  deleted: string[]
  /** R11 修复 (medium #33)：合并冲突路径（statusMatrix 中 workdir=3 或 stage=3） */
  conflicted: string[]
  /** 是否有任何变更（modified.length > 0 || untracked.length > 0 || deleted.length > 0 || conflicted.length > 0） */
  dirty: boolean
  /** 当前 HEAD commit SHA（若有） */
  currentSha: string | null
  /** 是否有 origin remote */
  hasRemote: boolean
}

/** 提交日志条目 */
export interface GitLogEntry {
  sha: string
  message: string
  author: { name: string; email: string }
  date: string
}

/** 远程地址配置 */
export interface GitRemoteInfo {
  remote: string
  url: string
}

/** 自动同步状态（从主进程推送给渲染端） */
export type GitSyncPhase = 'idle' | 'committing' | 'pulling' | 'pushing'

export interface GitSyncState {
  phase: GitSyncPhase
  /** 最近一次成功同步的 ISO 时间 */
  lastSyncAt: string | null
  /** 最近一次错误信息 */
  lastError: string | null
  /** 自动同步是否启用 */
  autoEnabled: boolean
}

/**
 * 番茄钟（模块 P1-Pomodoro）共享类型
 */
/**
 * 白噪音类型
 *
 * 历史值：'none' | 'rain' | 'forest'
 * v2 扩展：'brown'（1/f^2）、'pink'（1/f）、'ocean'（brown + LFO 调制）
 * 'forest' 保留为别名 → 映射到 pink + chirp，与旧实现行为一致。
 */
export type PomodoroWhiteNoise =
  | 'none'
  | 'brown'
  | 'pink'
  | 'rain'
  | 'ocean'
  | 'forest'

export interface PomodoroConfig {
  /** 专注时长（分钟），默认 25 */
  focusMin: number
  /** 短休息时长，默认 5 */
  shortBreakMin: number
  /** 长休息时长，默认 15 */
  longBreakMin: number
  /** 每 N 个 focus 后进入长休息，默认 4 */
  cycleCount: number
  /** 自动开始下一阶段，默认 false */
  autoStartNext: boolean
  /** 阶段完成提示音，默认 true */
  soundEnabled: boolean
  /** 每日目标完成的番茄钟数量，默认 8（范围 1–20） */
  dailyGoal: number
  /** focus 阶段的白噪音，默认 none */
  whiteNoise: PomodoroWhiteNoise
  /** 自动进入专注模式（focus mode overlay） */
  autoEnterFocusMode: boolean
}

export const DEFAULT_POMODORO_CONFIG: PomodoroConfig = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  cycleCount: 4,
  autoStartNext: false,
  soundEnabled: true,
  dailyGoal: 8,
  whiteNoise: 'none',
  autoEnterFocusMode: false,
}

/**
 * focusMin / break 时长（分钟）的合法区间与 UI 步长。
 *
 * R-fix-focus-controls-boundary-drift (HIGH dead-code)：原 FocusControls 在
 * 渲染端硬编码 MIN_MINUTES=5 / MAX_MINUTES=90 / STEP_MINUTES=5，但主进程
 * validatePomodoroConfigPatch（pomodoroService.ts:120-124）认的合法区间是
 * [1, 180] —— 通过 AI 工具 startPomodoro({ minutes: 120 }) 持久化进
 * focusMin=120 后，UI 显示「120 分钟」，但 + 按钮因 displayMinutes >= 90
 * 被永久禁用，用户无法调回 90 以下，造成「主进程合法 / 渲染端禁用」的
 * 隐式漂移（与 fsOpen-flag-mismatch 同根：契约边界 ≠ 实现边界）。
 *
 * 改：把 [min, max] / step 作为单一权威源放在 @shared/ipc/channels，与主
 * 进程 validator 同源（同一文件 import），避免渲染端再各自 hardcode。
 *
 * 注意：step 与 validator 无直接关系（validator 只判整型 + 边界，step 是
 * UI +/- 的步长）；但放进同一个常量组便于维护，且便于后续 main 进程若
 * 想限制 step（如 shortBreakMin 也走同样按钮）时复用。
 */
export const POMODORO_FOCUS_MIN_LIMITS = {
  min: 1,
  max: 180,
  /** UI +/- 按钮步长（分钟） */
  step: 5,
} as const

/**
 * cycleCount（每 N 个 focus 后进入长休）的 UI 边界。
 *
 * Validator（pomodoroService.ts validatePomodoroConfigPatch）允许 [1, 12]；
 * UI 故意只暴露 [2, 6]，避免用户配出 cycleCount=1（永远不休息）或
 * cycleCount=12（极少长休）这种几乎无实际收益的边界值。
 *
 * 设计约定（与 POMODORO_FOCUS_MIN_LIMITS 一致）：UI 边界 ⊆ validator
 * 边界。底层 validator 必须保留宽区间，用于 AI 工具 / 配置迁移 / 历史
 * 数据兼容。两层边界都从本文件单一源读，渲染端不再各自 hardcode。
 */
export const POMODORO_CYCLE_LIMITS = {
  min: 2,
  max: 6,
} as const

/**
 * dailyGoal（每日目标完成的番茄钟数量）的 UI 边界。
 *
 * 当前范围 [1, 20] 与 validator 一致；保留 UI 常量是为了与
 * POMODORO_CYCLE_LIMITS 等保持单一源契约，避免后续若缩小 UI 范围
 * （如「新手最多 4」）时出现与 validator 的隐式漂移。
 */
export const POMODORO_DAILY_GOAL_LIMITS = {
  min: 1,
  max: 20,
} as const

/**
 * shortBreakMin（短休息时长，分钟）的 UI 边界。
 *
 * Validator 允许 [1, 180]；UI 故意只暴露 [3, 10]，避免用户配出
 * shortBreakMin=1（不够喘气）或 shortBreakMin=180（破坏「短」休
 * 语义）这种无意义的边界值。
 */
export const POMODORO_SHORT_BREAK_LIMITS = {
  min: 3,
  max: 10,
} as const

/**
 * longBreakMin（长休息时长，分钟）的 UI 边界。
 *
 * Validator 允许 [1, 180]；UI 故意只暴露 [10, 30]，避免用户配出
 * longBreakMin=1（不是真正的长休）或 longBreakMin=180（破坏番茄
 * 节奏）这种无意义的边界值。
 */
export const POMODORO_LONG_BREAK_LIMITS = {
  min: 10,
  max: 30,
} as const

/** 番茄钟当前模式 */
export type PomodoroMode = 'focus' | 'shortBreak' | 'longBreak'

/** 番茄钟计时器运行时状态 */
export interface PomodoroState {
  mode: PomodoroMode
  remainingSec: number
  totalSec: number
  /** 当前已完成 focus 数（mod cycleCount） */
  cycleIndex: number
  running: boolean
  /** 当前阶段起始时间 ISO */
  startedAt: string | null
  /** 关联便签 id（统一任务实体） */
  stickyNoteId: string | null
  /** 当前阶段累计已运行秒数（用于显示进度） */
  elapsedSec: number
}

/** 一条番茄钟记录 */
export interface PomodoroRecord {
  id: string
  stickyNoteId: string | null
  startedAt: string
  endedAt: string | null
  durationMin: number | null
  completed: number
}

/**
 * 生成默认的 commit message（主进程与渲染进程共用，保持格式一致）
 */
export function defaultCommitMessage(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `chore: sync notes ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}
