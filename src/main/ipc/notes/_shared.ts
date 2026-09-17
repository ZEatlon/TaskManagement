/**
 * W2-A note-handlers 拆分 —— 子模块共享的校验器 + 常量
 *
 * 原 note-handlers.ts 612 行按子域拆为：
 *   crud.ts / folders.ts / files.ts / export.ts / index.ts
 * 这一文件放跨子域共享的小工具 + 字节上限常量。
 */
import { IPC_CHANNELS } from '@shared/ipc/channels'
import type { NoteFrontmatter } from '../../notes/frontmatter'

/** note:write 通用上限（与 sticky-note-handlers 同源常量对齐） */
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024 // 5 MiB
export const MAX_FILENAME_BYTES = 200
export const MAX_TITLE_BYTES = 500

/**
 * R36 修复 (medium DoS): NOTE_REPORT_EDIT / NOTE_RESOLVE handler 入参边界。
 * conflictResolver.states Map 用 path 作 key，恶意长 path / 几百万 unique
 * path 同样可让 main 进程 RSS 单调增长直到 OOM。
 */
export const MAX_NOTE_PATH_BYTES = 1024

/**
 * R-fix-NOTE_LIST_BY_FOLDERS-unbounded-folderIds (medium DoS)：
 * 与 sticky-note-handlers 的 MAX_TAGS=100 / MAX_STEPS=200 / BATCH_UPDATE_MAX_IDS=100
 * 对齐 —— sidebar 多文件夹预览真实需求一般 20 个以下，100 是宽上界。
 */
export const MAX_FOLDER_IDS = 100
export const MAX_FOLDER_ID_BYTES = 128

/**
 * R43 修复 (MEDIUM NOTE_SEARCH-unbounded-query)：
 * 1 KiB 与 sticky-note 的 MAX_SEARCH_QUERY_BYTES=1024 对齐。
 */
export const MAX_SEARCH_QUERY_BYTES = 1024
export const MAX_SEARCH_LIMIT = 200
export const MIN_SEARCH_LIMIT = 1
export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_FOLDER_ID_BYTES_FOR_SEARCH = 128

export const NOTE_FRONTMATTER_KEYS: ReadonlySet<keyof NoteFrontmatter> = new Set([
  'tags',
  'starred',
  'archived',
  'description',
])

/**
 * R35-Corr-2 修复 (medium defense-in-depth)：note:* handler 入参的非空
 * 字符串运行时校验。被攻渲染端 / devtools / 落后 schema 的旧渲染端可注入
 * `{ id: {} }` / `{ path: { evil: 1 } }` —— object 是 truthy 绕过 `!args?.X`
 * 检查，落到 notesManager.* / notesRepo.* 里 better-sqlite3 把对象绑定成
 * "[object Object]" 或者直接抛错污染状态机。
 *
 * IDType 是字符串别名（NoteMeta.id: ID），所以这个 helper 既能校验
 * `id` 字段也能校验 `path` 字段（同样是 string），复用一份即可。
 */
export function assertId(id: unknown, channel: string): asserts id is string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`${channel}: id must be non-empty string`)
  }
}

/**
 * note:write 入参边界检查。被攻击的渲染端可注入 1GB content
 * 让主进程分配整块内存并长时间阻塞 IPC。这里在 handler 层做轻量上限校验。
 *
 * R14 修复 (high)：原先只对 payload.path 做 .md 后缀校验，绕过方式
 * 是在新建笔记时只传 filename（不传 path）。攻击渲染端就可以
 * 写 `notes/evil.bat`，绕过后续 notesWatcher 的 .md 过滤并被 git
 * 自动同步推送到远端。统一两条入口都强制 .md 后缀。
 */
export function validateNotePayload(payload: {
  path?: string
  filename?: string
  content: string
  frontmatter?: NoteFrontmatter
  folderId?: string | null
}): void {
  if (typeof payload.content !== 'string') {
    throw new Error('note:write: content must be string')
  }
  if (Buffer.byteLength(payload.content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error(`note:write: content exceeds ${MAX_CONTENT_BYTES} bytes`)
  }
  if (payload.filename !== undefined && Buffer.byteLength(payload.filename, 'utf8') > MAX_FILENAME_BYTES) {
    throw new Error(`note:write: filename exceeds ${MAX_FILENAME_BYTES} bytes`)
  }
  if (payload.filename !== undefined) {
    const base = payload.filename.split(/[\\/]/).pop() ?? ''
    if (base && !base.toLowerCase().endsWith('.md')) {
      throw new Error('note:write: filename must end in .md')
    }
  }
  if (payload.path !== undefined) {
    const base = payload.path.split(/[\\/]/).pop() ?? ''
    if (base && !base.toLowerCase().endsWith('.md')) {
      throw new Error('note:write: path basename must end in .md')
    }
  }
  if (payload.frontmatter) {
    for (const k of Object.keys(payload.frontmatter)) {
      if (!NOTE_FRONTMATTER_KEYS.has(k as keyof NoteFrontmatter)) {
        throw new Error(`note:write: frontmatter key '${k}' is not allowed`)
      }
      if (k === 'description' && typeof payload.frontmatter.description === 'string'
          && Buffer.byteLength(payload.frontmatter.description, 'utf8') > MAX_TITLE_BYTES) {
        throw new Error(`note:write: description exceeds ${MAX_TITLE_BYTES} bytes`)
      }
    }
  }
}

/**
 * R43 修复 (MEDIUM NOTE_SEARCH-unbounded-query)：
 * NOTE_SEARCH handler 此前直通 args → notesManager.searchNotes → repo.search，
 * TS `limit: number` 只是编译期装饰。被攻渲染端 / devtools / preload 可注入
 * 几百 MB query 让主进程 string scan / replace / SQLite bind 各阶段 OOM，或
 * 注入 `limit: 'foo'` 让 SQLite LIMIT 子句静默返 0 行（TEXT → 不 coerce
 * 失败 → ROWID 0）。
 *
 * 与 sticky-note-handlers 的 MAX_SEARCH_QUERY_BYTES / MAX_SEARCH_LIMIT 同源
 * 字面常量，defense-in-depth；返回规范化后的 args（limit 经 coerce 落进合法区间）。
 */
export function validateNoteSearchArgs(args: unknown): {
  query: string
  limit: number
  folderId: string | null | undefined
} {
  const ch = IPC_CHANNELS.NOTE_SEARCH
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.query !== 'string'
      || Buffer.byteLength(a.query, 'utf8') > MAX_SEARCH_QUERY_BYTES) {
    throw new Error(`${ch}: query must be string <= ${MAX_SEARCH_QUERY_BYTES} bytes`)
  }
  let limit: number = DEFAULT_SEARCH_LIMIT
  if (a.limit !== undefined && a.limit !== null) {
    const n = typeof a.limit === 'number' ? a.limit : Number(a.limit)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_SEARCH_LIMIT || n > MAX_SEARCH_LIMIT) {
      throw new Error(`${ch}: limit must be integer in [${MIN_SEARCH_LIMIT}, ${MAX_SEARCH_LIMIT}]`)
    }
    limit = n
  }
  let folderId: string | null | undefined
  if (a.folderId !== undefined && a.folderId !== null) {
    if (typeof a.folderId !== 'string') {
      throw new Error(`${ch}: folderId must be string or null`)
    }
    if (Buffer.byteLength(a.folderId, 'utf8') > MAX_FOLDER_ID_BYTES_FOR_SEARCH) {
      throw new Error(`${ch}: folderId exceeds ${MAX_FOLDER_ID_BYTES_FOR_SEARCH} bytes`)
    }
    folderId = a.folderId
  } else if (a.folderId === null) {
    folderId = null
  }
  return { query: a.query, limit, folderId }
}
