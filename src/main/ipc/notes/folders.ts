/**
 * W2-A note-handlers 拆分 —— 文件夹子模块
 *
 * 注册以下通道：
 *   note-folder:list     列出所有文件夹（按 order_num ASC）
 *   note-folder:create   新建文件夹
 *   note-folder:update   重命名 / 改色 / 改 order
 *   note-folder:delete   删除文件夹（关联笔记 folder_id → NULL）
 *   note:move-to-folder  把笔记移到指定文件夹（或 NULL = 未分类）
 *   note:list-by-folder  按单文件夹列出
 *   note:list-by-folders 批量按多 folderId 拉笔记（sidebar 多文件夹预览）
 */
import { handle } from '../channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { notesRepo } from '../../db/repositories/notes'
import { noteFoldersRepo } from '../../db/repositories/noteFolders'
import type { NoteFolder, NoteFolderColor, NoteMeta } from '@shared/types'
import { assertId, MAX_FOLDER_IDS, MAX_FOLDER_ID_BYTES } from './_shared'

const FOLDER_COLOR_PALETTE: NoteFolderColor[] = [
  'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose',
]

export function registerNoteFolderHandlers(): void {
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
      const color = args?.color ?? null
      if (color !== null && !FOLDER_COLOR_PALETTE.includes(color)) {
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
      if (!FOLDER_COLOR_PALETTE.includes(patch.color)) {
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
}
