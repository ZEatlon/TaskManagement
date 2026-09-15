/**
 * 笔记相关 IPC 处理器
 *
 * 暴露给渲染端的通道：
 *   - note:list           列出笔记
 *   - note:read           读取完整笔记（含正文）
 *   - note:write          写入/新建笔记
 *   - note:delete         删除笔记
 *   - note:search         按标题/文件名模糊搜索
 *   - note:watch-start    启动文件监听
 *   - note:watch-stop     停止文件监听
 *   - note:tags           获取全部出现过的标签
 *   - note:tag-list       按标签列出
 *   - note:report-edit    上报内存侧编辑（驱动 conflict 状态机）
 *   - note:resolve        解决冲突
 *   - note:file-state     获取某文件状态
 *   - note:file-states    获取全部文件状态
 *   - note:rename         重命名笔记
 *   - note:set-starred    切换星标
 *
 * 笔记文件夹：
 *   - note-folder:list     列出所有文件夹（按 order_num ASC）
 *   - note-folder:create   新建文件夹
 *   - note-folder:update   重命名 / 改色 / 改 order
 *   - note-folder:delete   删除文件夹（关联笔记 folder_id → NULL）
 *   - note:move-to-folder  把笔记移到指定文件夹（或 NULL = 未分类）
 */
import { handle } from './channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { notesManager } from '../notes/notesManager'
import { notesRepo } from '../db/repositories/notes'
import { noteFoldersRepo } from '../db/repositories/noteFolders'
import type { Note, NoteFolder, NoteFolderColor, NoteMeta } from '@shared/types'
import type { ConflictResolution, FileStateKind } from '../notes/conflictResolver'
import type { NoteFrontmatter } from '../notes/frontmatter'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import log from '../log'
import { isPathInside, isRealPathInside } from '../notes/pathSafety'

/**
 * R12 修复 (medium)：note:write 入参边界检查。被攻击的渲染端可注入 1GB content
 * 让主进程分配整块内存并长时间阻塞 IPC。这里在 handler 层做轻量上限校验。
 */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024 // 5 MiB
const MAX_FILENAME_BYTES = 200
const MAX_TITLE_BYTES = 500
// R36 修复 (medium DoS): NOTE_REPORT_EDIT / NOTE_RESOLVE handler 入参边界。
// sibling NOTE_WRITE 已经走 validateNotePayload，但这两个 channel 直通
// notesManager.reportMemoryEdit / notesManager.resolveConflict →
// conflictResolver.onMemoryEdit / .resolve 把整段 content 喂给
// createHash('sha1').update(content, 'utf8')；没有字节上限的话，被攻渲染端
// 可注入几百 MB content 让主进程 CPU 长时间钉在 SHA1（同步阻塞 IPC 事件循环）。
// 复用与 NOTE_WRITE 一致的 5 MiB 上限；path 上限 1 KiB（绝对路径足够，远低于
// NTFS MAX_PATH 32k）—— conflictResolver.states Map 用 path 作 key，恶意
// 长 path / 几百万 unique path 同样可让 main 进程 RSS 单调增长直到 OOM。
const MAX_NOTE_PATH_BYTES = 1024
// R-fix-NOTE_LIST_BY_FOLDERS-unbounded-folderIds (medium DoS)：
// 与 sticky-note-handlers 的 MAX_TAGS=100 / MAX_STEPS=200 / BATCH_UPDATE_MAX_IDS=100
// 对齐 —— sidebar 多文件夹预览真实需求一般 20 个以下，100 是宽上界。
// 不在 handler 层 cap 的话，被攻渲染端可注 `{ folderIds: Array(N).fill('x') }`
// 让 IPC payload、JS filter、SQL `IN (?, ?, ...)` 占位串、prepared-stmt register
// 都在 SQLite 拒掉之前先在主进程吃掉 O(N) 内存 + CPU。
const MAX_FOLDER_IDS = 100
// 单个 folderId 字节上限 —— 一致 UUID 36 字符 + 余量。assertId 已兜底空 / 非 string，
// 这里再 cap 单条长度防止 1MB 单 id 让 filter/stringIds 占位串本身爆内存。
const MAX_FOLDER_ID_BYTES = 128
// R43 修复 (MEDIUM NOTE_SEARCH-unbounded-query)：NOTE_SEARCH 此前无 byte 上限，
// 被攻渲染端可注入几百 MB query 让 ipcRenderer structured-clone → 主进程
// q.trim() / .replace(/%/g) → LIKE pattern binding → dbClient.call('all') 各阶段
// 扫整串 OOM/stall。note 标题上限 5MiB（写路径），搜索 LIKE 短语本身短得多：
// 1 KiB 与 sticky-note 的 MAX_SEARCH_QUERY_BYTES=1024 对齐。
const MAX_SEARCH_QUERY_BYTES = 1024
const MAX_SEARCH_LIMIT = 200
const MIN_SEARCH_LIMIT = 1
const DEFAULT_SEARCH_LIMIT = 50
const MAX_FOLDER_ID_BYTES_FOR_SEARCH = 128
const NOTE_FRONTMATTER_KEYS: ReadonlySet<keyof NoteFrontmatter> = new Set([
  'tags',
  'starred',
  'archived',
  'description',
])

function validateNotePayload(payload: {
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
  // R14 修复 (high)：原先只对 payload.path 做 .md 后缀校验，绕过方式
  // 是在新建笔记时只传 filename（不传 path）。攻击渲染端就可以
  // 写 `notes/evil.bat`，绕过后续 notesWatcher 的 .md 过滤并被 git
  // 自动同步推送到远端。统一两条入口都强制 .md 后缀。
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
 * R35-Corr-2 修复 (medium defense-in-depth)：note:* handler 入参的非空
 * 字符串运行时校验。R33-Corr-4 / R34-Corr-1a 在 sticky-note-handlers 引入了
 * 同样的 `assertId`，但 note-handlers 里多个 sibling handler
 * （NOTE_READ / NOTE_DELETE / NOTE_RENAME / NOTE_REPORT_EDIT / NOTE_RESOLVE
 *  / NOTE_MOVE_TO_FOLDER / NOTE_SET_STARRED）仍然只用 `!args?.X` 兜底。
 *
 * 漏洞：被攻渲染端 / devtools / 落后 schema 的旧渲染端可注入
 * `{ id: {} }` / `{ path: { evil: 1 } }` —— object 是 truthy 绕过 `!args?.X`
 * 检查，落到 notesManager.* / notesRepo.* 里 better-sqlite3 把对象绑定成
 * "[object Object]" 或者直接抛错污染状态机。
 *
 * 修复：在 IPC 边界加一道 asserts non-empty string，与 sticky-note-handlers
 * 风格一致；非法入参直接抛 Error（沿用 sticky-note 的硬抛策略，方便上层
 * 渲染端看到回执并提示用户）。不动架构 —— 走 inline 函数体复用，不引入新
 * 模块。
 *
 * IDType 是字符串别名（NoteMeta.id: ID），所以这个 helper 既能校验
 * `id` 字段也能校验 `path` 字段（同样是 string），复用一份即可。
 */
function assertId(id: unknown, channel: string): asserts id is string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`${channel}: id must be non-empty string`)
  }
}

/**
 * R43 修复 (MEDIUM NOTE_SEARCH-unbounded-query)：NOTE_SEARCH handler 此前
 * 直通 args → notesManager.searchNotes → repo.search，TS `limit: number` 只是
 * 编译期装饰。被攻渲染端 / devtools / preload 可注入几百 MB query 让主进程
 * string scan / replace / SQLite bind 各阶段 OOM，或注入 `limit: 'foo'` 让
 * SQLite LIMIT 子句静默返 0 行（TEXT → 不 coerce 失败 → ROWID 0）。
 * 与 sticky-note-handlers 的 MAX_SEARCH_QUERY_BYTES / MAX_SEARCH_LIMIT 同源
 * 字面常量，defense-in-depth；返回规范化后的 args（limit 经 coerce 落进合法区间）。
 */
function validateNoteSearchArgs(args: unknown): { query: string; limit: number; folderId: string | null | undefined } {
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

export function registerNoteHandlers(): void {
  // BUG-30-fix：TReq 类型应为可选 opts 而不是 undefined。
  // 之前声明成 undefined 实际上靠 `opts ?? {}` 兜底，破坏了类型契约。
  handle<
    { archived?: boolean; starred?: boolean; limit?: number } | undefined,
    NoteMeta[]
  >(IPC_CHANNELS.NOTE_LIST, async (_e, opts) => {
    return notesManager.listNotes(opts ?? {})
  })

  handle<string, Note | null>(IPC_CHANNELS.NOTE_READ, async (_e, path) => {
    // R35-Corr-2：替换原来的（无校验）— 非 string 路径会让底层 IO 直接抛错
    assertId(path, IPC_CHANNELS.NOTE_READ)
    return notesManager.readNote(path)
  })

  handle<
    {
      path?: string
      filename?: string
      content: string
      frontmatter?: NoteFrontmatter
      /** BUG-5 fix：创建时直接指定文件夹（可选；缺省 = 未分类） */
      folderId?: string | null
    },
    Note
  >(IPC_CHANNELS.NOTE_WRITE, async (_e, payload) => {
    validateNotePayload(payload)
    return notesManager.writeNote(payload)
  })

  handle<string, boolean>(IPC_CHANNELS.NOTE_DELETE, async (_e, path) => {
    // R35-Corr-2：避免被攻渲染端注入 `{ path: { evil: 1 } }` 触发 notesManager.deleteNote
    assertId(path, IPC_CHANNELS.NOTE_DELETE)
    return notesManager.deleteNote(path)
  })

  /**
   * 搜索：query + limit + folderId
   * - folderId = string  → 仅在该文件夹内搜
   * - folderId = null    → 仅在「未分类」里搜
   * - folderId = undefined / 缺省 → 跨文件夹搜
   */
  handle<{ query: string; limit?: number; folderId?: string | null }, NoteMeta[]>(
    IPC_CHANNELS.NOTE_SEARCH,
    async (_e, args) => {
      // R43 修复 (MEDIUM NOTE_SEARCH-unbounded-query)：handler 层先校验
      // query 字节上限、coerce limit 到合法区间、断言 folderId 类型/长度；
      // 与 create/update/listByTag 等 sibling handler 一致的 defense-in-depth。
      const safe = validateNoteSearchArgs(args)
      return notesManager.searchNotes(safe.query, safe.limit, safe.folderId)
    },
  )

  handle<undefined, { ok: boolean; hydrated: number; dir: string | null }>(
    IPC_CHANNELS.NOTE_WATCH_START,
    async () => {
      return notesManager.startWatching()
    },
  )

  handle<undefined, { ok: boolean }>(IPC_CHANNELS.NOTE_WATCH_STOP, async () => {
    await notesManager.stopWatching()
    return { ok: true }
  })

  handle<undefined, string[]>(IPC_CHANNELS.NOTE_TAGS, async () => {
    return notesManager.allTags()
  })

  /**
   * 按 tag 列出；支持按 folderId 收窄
   * - folderId = string  → 仅在该文件夹
   * - folderId = null    → 仅未分类
   * - folderId = undefined → 跨文件夹
   */
  handle<{ tag: string; folderId?: string | null }, NoteMeta[]>(
    IPC_CHANNELS.NOTE_TAG_LIST,
    async (_e, args) => {
      return notesManager.listByTag(args?.tag ?? '', args?.folderId)
    },
  )

  /** 上报内存编辑（textarea onChange） */
  handle<{ path: string; content: string }, { state: FileStateKind }>(
    IPC_CHANNELS.NOTE_REPORT_EDIT,
    async (_e, args) => {
      // R35-Corr-2：path 必须是 non-empty string，否则 conflict 状态机错乱
      assertId(args?.path, IPC_CHANNELS.NOTE_REPORT_EDIT)
      // R36 修复 (medium DoS)：path / content 字节上限。
      // path 用于 conflictResolver.states Map 的 key —— 长 path / 大量
      // unique path 可让 Map 无界增长；content 走 createHash('sha1') 同步
      // 计算，没有字节上限可让主进程 CPU 长时间钉死。
      if (Buffer.byteLength(args.path, 'utf8') > MAX_NOTE_PATH_BYTES) {
        throw new Error(`${IPC_CHANNELS.NOTE_REPORT_EDIT}: path exceeds ${MAX_NOTE_PATH_BYTES} bytes`)
      }
      if (typeof args?.content !== 'string') {
        throw new Error(`${IPC_CHANNELS.NOTE_REPORT_EDIT}: content must be string`)
      }
      if (Buffer.byteLength(args.content, 'utf8') > MAX_CONTENT_BYTES) {
        throw new Error(`${IPC_CHANNELS.NOTE_REPORT_EDIT}: content exceeds ${MAX_CONTENT_BYTES} bytes`)
      }
      notesManager.reportMemoryEdit(args.path, args.content)
      const state = notesManager.getFileState(args.path)
      return { state: state?.state ?? 'clean' }
    },
  )

  /** 解决冲突 */
  handle<
    { path: string; resolution: ConflictResolution; mergedContent?: string },
    { ok: boolean; state: FileStateKind | null }
  >(IPC_CHANNELS.NOTE_RESOLVE, async (_e, args) => {
    // R35-Corr-2：path 校验
    assertId(args?.path, IPC_CHANNELS.NOTE_RESOLVE)
    // R36 修复 (medium DoS)：path 字节上限（与 NOTE_REPORT_EDIT 同款），
    // 防止 conflictResolver.states Map key 被注长字符串拉爆。
    if (Buffer.byteLength(args.path, 'utf8') > MAX_NOTE_PATH_BYTES) {
      throw new Error(`${IPC_CHANNELS.NOTE_RESOLVE}: path exceeds ${MAX_NOTE_PATH_BYTES} bytes`)
    }
    // R36 修复 (medium DoS)：mergedContent 字节上限 —— 与 NOTE_WRITE
    // 同款 5 MiB 上限。conflictResolver.resolve 在 resolution === 'merge'
    // 分支走 ConflictResolver.hash(mergedContent) 同步 SHA1 大段 utf8，
    // 无上限可让主进程 CPU 100% 持续 30s+。
    if (args.mergedContent !== undefined) {
      if (typeof args.mergedContent !== 'string') {
        throw new Error(`${IPC_CHANNELS.NOTE_RESOLVE}: mergedContent must be string`)
      }
      if (Buffer.byteLength(args.mergedContent, 'utf8') > MAX_CONTENT_BYTES) {
        throw new Error(`${IPC_CHANNELS.NOTE_RESOLVE}: mergedContent exceeds ${MAX_CONTENT_BYTES} bytes`)
      }
    }
    const result = notesManager.resolveConflict(args.path, args.resolution, args.mergedContent)
    return { ok: result !== null, state: result?.state ?? null }
  })

  /** 单文件状态 */
  handle<string, { state: FileStateKind } | null>(IPC_CHANNELS.NOTE_FILE_STATE, async (_e, path) => {
    const s = notesManager.getFileState(path)
    return s ? { state: s.state } : null
  })

  /** 全部文件状态 */
  handle<undefined, Array<{ path: string; state: FileStateKind }>>(
    IPC_CHANNELS.NOTE_FILE_STATES,
    async () => {
      return notesManager.allFileStates().map((s) => ({ path: s.path, state: s.state }))
    },
  )

  /** 重命名 */
  handle<{ path: string; newTitle: string }, Note | null>(IPC_CHANNELS.NOTE_RENAME, async (_e, args) => {
    // R35-Corr-2：path 校验；newTitle 走 notesManager.renameNote 内部校验
    assertId(args?.path, IPC_CHANNELS.NOTE_RENAME)
    return notesManager.renameNote(args.path, args.newTitle)
  })

  /** 星标切换 */
  handle<{ id: string; starred: boolean }, NoteMeta | null>(
    'note:set-starred',
    async (_e, args) => {
      // R35-Corr-2 (medium id-no-runtime-validation)：用 assertId 替换
      // `!args?.id` 兜底 —— 之前 object / 0 / 非空字符串能绕过 truthy 检查
      // 落到 notesRepo.updateMeta 把非 string 绑到 better-sqlite3。
      assertId(args?.id, 'note:set-starred')
      return notesRepo.updateMeta(args.id, { starred: !!args.starred })
    },
  )

  /* ===================== 笔记文件夹 ===================== */

  /** 列出所有文件夹 */
  handle<undefined, NoteFolder[]>(IPC_CHANNELS.NOTE_FOLDER_LIST, async () => {
    return noteFoldersRepo.findAllOrdered()
  })

  /** 新建文件夹 */
  handle<{ name: string; color?: NoteFolderColor | null }, NoteFolder>(
    IPC_CHANNELS.NOTE_FOLDER_CREATE,
    async (_e, args) => {
      const name = String(args?.name ?? '').trim()
      // B14-fix：服务端二次校验，避免空名 / 非法色值
      if (!name) throw new Error('NOTE_FOLDER_CREATE: 文件夹名不能为空')
      const palette: NoteFolderColor[] = [
        'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose',
      ]
      const color = args?.color ?? null
      if (color !== null && !palette.includes(color)) {
        throw new Error(`NOTE_FOLDER_CREATE: 非法 color 值 ${color}`)
      }
      return noteFoldersRepo.create({ name, color })
    },
  )

  /** 重命名 / 改色 / 改 order */
  handle<
    { id: string; patch: { name?: string; color?: NoteFolderColor | null; order?: number } },
    NoteFolder | null
  >(IPC_CHANNELS.NOTE_FOLDER_UPDATE, async (_e, args) => {
    if (!args?.id) throw new Error('NOTE_FOLDER_UPDATE: 缺少 id')
    const patch = { ...args.patch }
    if (typeof patch.name === 'string') {
      patch.name = patch.name.trim()
      if (!patch.name) throw new Error('NOTE_FOLDER_UPDATE: 文件夹名不能为空')
    }
    if (patch.color !== undefined && patch.color !== null) {
      const palette: NoteFolderColor[] = [
        'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose',
      ]
      if (!palette.includes(patch.color)) {
        throw new Error(`NOTE_FOLDER_UPDATE: 非法 color 值 ${patch.color}`)
      }
    }
    return noteFoldersRepo.update(args.id, patch)
  })

  /**
   * 删除文件夹
   * - 关联笔记的 folder_id 会被置 NULL（不会级联删除笔记）
   * - 返回 { deleted, detachedNotes } 给 UI 提示
   */
  handle<string, { deleted: boolean; detachedNotes: number }>(
    IPC_CHANNELS.NOTE_FOLDER_DELETE,
    async (_e, id) => {
      return noteFoldersRepo.deleteAndDetach(id)
    },
  )

  /** 把笔记移到指定文件夹（folderId = null = 未分类） */
  handle<{ noteId: string; folderId: string | null }, NoteMeta | null>(
    IPC_CHANNELS.NOTE_MOVE_TO_FOLDER,
    async (_e, args) => {
      // R35-Corr-2：用 assertId 替换 `!args?.noteId` —— 之前 object / 非空字符串
      // 可绕过 truthy 检查落到 notesRepo.moveToFolder
      assertId(args?.noteId, IPC_CHANNELS.NOTE_MOVE_TO_FOLDER)
      // B12-fix：folderId 非 null 时必须对应一个已存在的文件夹
      // 否则笔记会被「挂」到一个不存在的文件夹里，UI 端再也无法定位它
      if (args.folderId !== null && args.folderId !== undefined) {
        const folder = await noteFoldersRepo.findById(args.folderId)
        if (!folder) throw new Error(`NOTE_MOVE_TO_FOLDER: 文件夹不存在 ${args.folderId}`)
      }
      return notesRepo.moveToFolder(args.noteId, args.folderId ?? null)
    },
  )

  /** 按文件夹列出笔记（folderId = null = 未分类；省略 = 不过滤） */
  handle<
    { folderId?: string | null; archived?: boolean; limit?: number },
    NoteMeta[]
  >(IPC_CHANNELS.NOTE_LIST_BY_FOLDER, async (_e, args) => {
    return notesRepo.findByFolder(args?.folderId, {
      archived: args?.archived,
      limit: args?.limit,
    })
  })

  /**
   * 批量按多 folderId 拉笔记：sidebar 多文件夹预览场景。
   * 入参 { folderIds: (string|null)[], archived?, limit? }
   * 出参 Record<string|null, NoteMeta[]>：key = folderId（null 表示未分类）。
   * 单 SQL 走 `folder_id IN (?, ?, ...) AND folder_id IS NULL` 复合谓词，
   * 一次 IPC + 一次 prepared-stmt 复用（共享 stmtCache）。
   *
   * R-findByFolders (low perf)：原 sidebar 用 N 次 listByFolder 触发 N
   * 轮 round-trip，20 个文件夹时 ~21ms+ 串行延迟（详见 notesRepo.findByFolders
   * 注释）。批量接口把 round-trip 压到 1 次。
   */
  handle<
    { folderIds: Array<string | null>; archived?: boolean; limit?: number },
    Record<string, NoteMeta[]>
  >(IPC_CHANNELS.NOTE_LIST_BY_FOLDERS, async (_e, args) => {
    const ids = Array.isArray(args?.folderIds) ? args.folderIds : []
    if (ids.length === 0) return {}
    // R-fix-NOTE_LIST_BY_FOLDERS-unbounded-folderIds (medium DoS)：与
    // sticky-note-handlers 的 MAX_TAGS / MAX_STEPS / BATCH_UPDATE_MAX_IDS
    // 对齐，array 大小硬上限。不在 handler 层 cap 的话，IPC payload +
    // filter 分配 + IN (?, ?, ...) 占位串 + prepared-stmt register 全部
    // 跑在 SQLite 拒掉 SQLITE_MAX_VARIABLE_NUMBER 之前。
    if (ids.length > MAX_FOLDER_IDS) {
      throw new Error(`${IPC_CHANNELS.NOTE_LIST_BY_FOLDERS}: folderIds length exceeds ${MAX_FOLDER_IDS}`)
    }
    // R35-Corr-2 风格：string id 必须是 non-empty string（assertId 拒
    // object / 0 / undefined / null 之外的非法值），null 是允许的（未分类）。
    // 这里 null 不走 assertId；string 才走。
    for (const id of ids) {
      if (id === null) continue
      assertId(id, IPC_CHANNELS.NOTE_LIST_BY_FOLDERS)
      if (Buffer.byteLength(id, 'utf8') > MAX_FOLDER_ID_BYTES) {
        throw new Error(`${IPC_CHANNELS.NOTE_LIST_BY_FOLDERS}: folderId exceeds ${MAX_FOLDER_ID_BYTES} bytes`)
      }
    }
    const grouped = await notesRepo.findByFolders(ids, {
      archived: args?.archived,
      limit: args?.limit,
    })
    // Map → Record（IPC structured-clone 友好：null key 序列化为 "null" 字符串）
    const out: Record<string, NoteMeta[]> = {}
    for (const [k, v] of grouped.entries()) {
      out[k === null ? 'null' : k] = v
    }
    return out
  })

  /**
   * 解析 markdown 里的相对资源路径（图片 / 附件）为 file:// URL。
   *
   * 入参 `{ notePath, relativePath }`：
   *   - notePath 当前笔记的绝对路径
   *   - relativePath markdown 里的相对路径（支持 `./` / `../` / 裸文件名 / 绝对路径）
   *
   * 出参 `{ fileUrl } | null`：
   *   - 解析成功 + 文件存在 + 落在 library 内 → 返回 file:// URL（可放 <img>）
   *   - 解析失败 / 越界 / 文件不存在 → 返回 null
   *
   * 安全：resolved 路径必须 realpath 落在 notesDir 内 —— 防止
   * `../../etc/passwd` 之类的路径穿越。
   */
  handle<{ notePath: string; relativePath: string }, { fileUrl: string } | null>(
    IPC_CHANNELS.NOTE_RESOLVE_ASSET,
    async (_e, args) => {
      if (!args?.notePath || !args?.relativePath) return null
      const notesDir = await notesManager.getNotesDir()
      if (!notesDir) return null

      // notePath 可能不带 .md / 不在 notesDir / 来自 AI 注入 —— 全部按字符串解析
      const noteDir = dirname(resolve(args.notePath))
      const candidate = resolve(noteDir, args.relativePath)

      // 词法 + 真实路径双层校验（统一走 ../notes/pathSafety，与 notesManager 同源）
      const lexical = isPathInside(notesDir, candidate)
      if (!lexical) return null
      // 资源必须存在 —— NOTE_RESOLVE_ASSET 拿到的是要渲染到 <img> 的 file:// URL，
      // 文件不存在时直接拒掉（isRealPathInside 在 ENOENT 时会回退到词法检查并
      // 返回 true，与此处"文件必须存在"的语义不符，所以这里前置 existsSync
      // 拦截不存在的路径，避免把不存在的路径放进 <img> 触发 404）。
      if (!existsSync(candidate)) return null
      if (!(await isRealPathInside(notesDir, candidate))) return null

      return { fileUrl: pathToFileURL(candidate).href }
    },
  )

  /**
   * 导出当前笔记为 PDF。
   *
   * 实现要点：
   *   - 渲染端已经把 markdown → 自包含 HTML（含内联样式 / base64 图片）
   *   - 主进程在隐藏 BrowserWindow 里 loadURL('data:text/html,...') 渲染该 HTML
   *   - 调用 webContents.printToPDF() 拿 Buffer → writeFile
   *   - 隐藏窗口用完即关（不持久化）
   *
   * 入参 `{ html, defaultFilename }`：
   *   - html 待打印 HTML（包含 <style> 让 PDF 自带样式）
   *   - defaultFilename 默认保存文件名（用户可在 dialog 里改）
   *
   * 出参 `{ savedPath } | null`：
   *   - 用户在 save dialog 取消 → null
   *   - 写盘成功 → 返回绝对路径
   */
  handle<{ html: string; defaultFilename?: string }, { savedPath: string } | null>(
    IPC_CHANNELS.NOTE_EXPORT_PDF,
    async (_e, args) => {
      if (!args?.html || typeof args.html !== 'string') return null
      // 入参大小兜底：避免渲染端被劫持后塞 100MB HTML 让主进程分配整块内存
      const MAX_HTML_BYTES = 20 * 1024 * 1024 // 20 MiB（PDF 渲染比 note:write 允许大）
      if (Buffer.byteLength(args.html, 'utf8') > MAX_HTML_BYTES) {
        throw new Error('note:export-pdf: html exceeds 20 MiB')
      }

      // 弹出系统保存对话框
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const defaultPath = args.defaultFilename?.replace(/[\\/:*?"<>|]/g, '_') || 'note.pdf'
      const dialogResult = await dialog.showSaveDialog(win ?? undefined!, {
        title: '导出笔记为 PDF',
        defaultPath: defaultPath.endsWith('.pdf') ? defaultPath : `${defaultPath}.pdf`,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      })
      if (dialogResult.canceled || !dialogResult.filePath) return null
      const targetPath = dialogResult.filePath

      // 隐藏 BrowserWindow 渲染 HTML → printToPDF
      const tempWin = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      try {
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(args.html)}`
        await tempWin.loadURL(dataUrl)
        // 等图片等异步资源加载完成（macOS / Linux 上 printToPDF 偶尔在 loadURL
        // resolve 后立即调用会拿到空白页）
        await new Promise((r) => setTimeout(r, 50))
        const pdfBuffer = await tempWin.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: {
            top: 0.5,
            bottom: 0.5,
            left: 0.5,
            right: 0.5,
          },
        })
        await writeFile(targetPath, pdfBuffer)
        log.info(`[note:export-pdf] saved ${pdfBuffer.length} bytes to ${targetPath}`)
        return { savedPath: targetPath }
      } finally {
        if (!tempWin.isDestroyed()) tempWin.close()
      }
    },
  )
}
