/**
 * W2-A④ note-handlers 子模块 —— 回收站 + 版本历史
 *
 * 注册以下通道：
 *   note:trash               软删除（移到回收站，仅置 deleted_at）
 *   note:restore             从回收站还原
 *   note:purge               永久删除（清磁盘 + 删 DB row + 删 revisions）
 *   note:list-trash          列出回收站里的笔记（默认 archived=false）
 *   note:list-revisions      列某条 note 的历史快照（按 created_at DESC）
 *   note:read-revision       读单条 revision 全文（content + frontmatter）
 *   note:restore-revision    把某条 revision 还原为当前正文
 *                           （snapshot 当前 → 写入 revision content → snapshot 旧版变新 history）
 */
import { handle } from '../channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { notesManager } from '../../notes/notesManager'
import { notesRepo } from '../../db/repositories/notes'
import { noteRevisionsRepo } from '../../db/repositories/noteRevisions'
import { assertId } from './_shared'
import type { Note, NoteMeta } from '@shared/types'
import type { NoteFrontmatter } from '../../notes/frontmatter'

export function registerNoteLifecycleHandlers(): void {
  /** 移到回收站（软删除）。 */
  handle<string, NoteMeta | null>(IPC_CHANNELS.NOTE_TRASH, async (_e, path) => {
    assertId(path, IPC_CHANNELS.NOTE_TRASH)
    return notesManager.trashNote(path)
  })

  /** 从回收站还原。 */
  handle<string, NoteMeta | null>(IPC_CHANNELS.NOTE_RESTORE, async (_e, path) => {
    assertId(path, IPC_CHANNELS.NOTE_RESTORE)
    return notesManager.restoreNote(path)
  })

  /** 永久删除（清磁盘 + 删 DB row + 删 revisions）。 */
  handle<string, boolean>(IPC_CHANNELS.NOTE_PURGE, async (_e, path) => {
    assertId(path, IPC_CHANNELS.NOTE_PURGE)
    return notesManager.purgeNote(path)
  })

  /** 列回收站里的笔记。 */
  handle<undefined, NoteMeta[]>(IPC_CHANNELS.NOTE_LIST_TRASH, async () => {
    return notesManager.listTrash(200)
  })

  /**
   * 列某条 note 的历史快照。
   * 入参 { noteId } —— noteId 是 DB 主键（不是 path），通过 note:read 返回值拿到。
   */
  handle<{ noteId: string }, Array<{
    id: number
    noteId: string
    createdAt: string
    length: number
    source: 'auto' | 'manual'
  }>>(IPC_CHANNELS.NOTE_LIST_REVISIONS, async (_e, args) => {
    assertId(args?.noteId, IPC_CHANNELS.NOTE_LIST_REVISIONS)
    return notesManager.listRevisions(args.noteId)
  })

  /** 读单条 revision 全文。 */
  handle<{ revisionId: number }, {
    id: number
    noteId: string
    createdAt: string
    length: number
    source: 'auto' | 'manual'
    content: string
    frontmatter: string
  } | null>(IPC_CHANNELS.NOTE_READ_REVISION, async (_e, args) => {
    if (typeof args?.revisionId !== 'number' || !Number.isInteger(args.revisionId)) {
      throw new Error(`${IPC_CHANNELS.NOTE_READ_REVISION}: revisionId must be integer`)
    }
    return notesManager.readRevision(args.revisionId)
  })

  /**
   * 把某条 revision 还原为当前正文（同时 snapshot 当前正文作为新一条 history）。
   * 入参 { revisionId } —— 走 note:read 先拿 revision 全文，再走 note:write 把
   * content + frontmatter 写回。writeNote 自身会先 snapshot 当前正文到 revisions，
   * 所以「还原」 = 「旧版留底，新版 = revision 内容」，可安全回退到「还原前」状态。
   */
  handle<{ revisionId: number }, Note | null>(
    IPC_CHANNELS.NOTE_RESTORE_REVISION,
    async (_e, args) => {
      if (typeof args?.revisionId !== 'number' || !Number.isInteger(args.revisionId)) {
        throw new Error(`${IPC_CHANNELS.NOTE_RESTORE_REVISION}: revisionId must be integer`)
      }
      const rev = await noteRevisionsRepo.findById(args.revisionId)
      if (!rev) throw new Error(`${IPC_CHANNELS.NOTE_RESTORE_REVISION}: revision ${args.revisionId} not found`)
      const meta = await notesRepo.findById(rev.noteId)
      if (!meta) throw new Error(`${IPC_CHANNELS.NOTE_RESTORE_REVISION}: note ${rev.noteId} no longer exists`)
      // 把 frontmatter JSON 反序列化回对象喂回 writeNote（让它走 normalizeFrontmatter）
      let fm: Record<string, unknown> = {}
      try {
        fm = JSON.parse(rev.frontmatter)
      } catch {
        fm = {}
      }
      return notesManager.writeNote({
        path: meta.path,
        content: rev.content,
        frontmatter: fm as NoteFrontmatter,
      })
    },
  )
}
