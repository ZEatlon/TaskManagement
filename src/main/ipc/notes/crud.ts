/**
 * W2-A note-handlers 拆分 —— CRUD 子模块
 *
 * 注册以下通道：
 *   note:list           列出笔记
 *   note:read           读取完整笔记（含正文）
 *   note:write          写入/新建笔记
 *   note:delete         删除笔记
 *   note:search         按标题/文件名模糊搜索
 *   note:tags           获取全部出现过的标签
 *   note:tag-list       按标签列出
 *   note:rename         重命名笔记
 *   note:set-starred    切换星标
 */
import { handle } from '../channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { notesManager } from '../../notes/notesManager'
import { notesRepo } from '../../db/repositories/notes'
import type { Note, NoteMeta } from '@shared/types'
import type { NoteFrontmatter } from '../../notes/frontmatter'
import { assertId, validateNotePayload, validateNoteSearchArgs } from './_shared'

export function registerNoteCrudHandlers(): void {
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
}
