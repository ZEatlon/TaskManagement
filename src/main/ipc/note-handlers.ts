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
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import log from '../log'

/**
 * R12 修复 (medium)：note:write 入参边界检查。被攻击的渲染端可注入 1GB content
 * 让主进程分配整块内存并长时间阻塞 IPC。这里在 handler 层做轻量上限校验。
 */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024 // 5 MiB
const MAX_FILENAME_BYTES = 200
const MAX_TITLE_BYTES = 500
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
      return notesManager.searchNotes(args?.query ?? '', args?.limit, args?.folderId)
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
    return notesManager.renameNote(args.path, args.newTitle)
  })

  /** 星标切换 */
  handle<{ id: string; starred: boolean }, NoteMeta | null>(
    'note:set-starred',
    async (_e, args) => {
      // BUG-6-fix：缺 id 直接返回 null，避免空字符串被当成有效 id 走 UPDATE
      if (!args?.id) return null
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
      if (!args?.noteId) throw new Error('NOTE_MOVE_TO_FOLDER: 缺少 noteId')
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

      // 词法 + 真实路径双层校验
      const lexical = isPathInsideSafe(notesDir, candidate)
      if (!lexical) return null
      // 仅在目标存在时做 realpath 校验（ENOENT 时词法已足够）
      if (existsSync(candidate)) {
        const { realpath: fsRealpath } = await import('node:fs/promises')
        let realRoot: string
        try {
          realRoot = await fsRealpath(notesDir)
        } catch {
          realRoot = resolve(notesDir)
        }
        let realTarget: string
        try {
          realTarget = await fsRealpath(candidate)
        } catch {
          return null
        }
        const rel = relative(realRoot, realTarget)
        if (rel.startsWith('..') || isAbsolute(rel)) return null
      } else {
        return null
      }

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

/**
 * 词法包含判断 —— 内部用，不导出。resolve 双方后看相对路径是否
 * 以 `..` 开头或为绝对路径。realpath 校验在调用方按需执行。
 */
function isPathInsideSafe(rootDir: string, target: string): boolean {
  const resolvedRoot = resolve(rootDir)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (!rel) return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}
