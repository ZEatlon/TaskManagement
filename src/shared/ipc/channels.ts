/**
 * 共享 IPC 通道常量与类型
 * 主进程、preload、渲染进程三方共用
 * 新增通道时在此处集中声明
 */

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
  /**
   * 一次性清理历史版本自动写入的 mock 数据（笔记 + sticky + pomodoros）。
   * 出参 { deletedNotes, deletedStickies, deletedPomodoros }。
   */
  MOCK_CLEANUP: 'mock:cleanup',
  // 主进程主动推送到渲染进程的笔记事件
  NOTE_FS_EVENT: 'note:fs-event',

  // 笔记文件夹（v1：扁平列表，无嵌套；详见 migrations/005-note-folders.sql）
  NOTE_FOLDER_LIST: 'note-folder:list',
  NOTE_FOLDER_CREATE: 'note-folder:create',
  NOTE_FOLDER_UPDATE: 'note-folder:update',
  NOTE_FOLDER_DELETE: 'note-folder:delete',
  NOTE_LIST_BY_FOLDER: 'note:list-by-folder',
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
  // 主进程主动推送到渲染进程的事件
  POMODORO_TICK: 'pomodoro:tick',
  POMODORO_PHASE_COMPLETE: 'pomodoro:phase-complete',
  POMODORO_STATE_CHANGED: 'pomodoro:state-changed',

  // 附件（模块 P0-6）
  ATTACHMENT_UPLOAD: 'attachment:upload',
  ATTACHMENT_DELETE: 'attachment:delete',
  ATTACHMENT_EXISTS: 'attachment:exists',
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
  language: 'zh-CN'
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
/** 白噪音类型 */
export type PomodoroWhiteNoise = 'none' | 'rain' | 'forest'

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
}

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
