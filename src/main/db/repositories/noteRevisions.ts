/**
 * note_revisions 表 repo
 *
 * W2-A④：每条 note:write 在写入新正文前把当前正文 / frontmatter 快照成
 * 一行 note_revisions（source='auto'）。用户在 history drawer 里能：
 *   - 列表：listByNote(noteId) → NoteRevisionSummary[]
 *   - 读：findById(revisionId) → NoteRevisionDetail
 *   - 还原：restore(revisionId) → Note（含新正文 + 新 frontmatter，调用方
 *     走 note:write 把它写回 note + 再 snapshot 当前到 revisions）
 *
 * 保留上限：每条笔记最多 50 行，超出按 created_at ASC 删最早。
 * prune 在 append() 后跑一次，单 note 单次 append 的 SQL 是 O(K)（K = 超
 * 出数），日常 0-1 行超出可忽略。
 */
import { dbClient } from '../client'
import { withCached } from '../cachedStmt'

const MAX_REVISIONS_PER_NOTE = 50

export interface NoteRevisionSummary {
  id: number
  noteId: string
  createdAt: string
  /** 字数统计（content 字符数）—— 列表里展示用，避免每次读全文 */
  length: number
  /** 'auto' = writeNote 自动 snapshot；'manual' = 用户主动保存的版本 */
  source: 'auto' | 'manual'
}

export interface NoteRevisionDetail extends NoteRevisionSummary {
  content: string
  frontmatter: string
}

export class NoteRevisionsRepository {
  /** 列出某条 note 的历史快照（按 created_at DESC）。 */
  async listByNote(noteId: string): Promise<NoteRevisionSummary[]> {
    return withCached(
      `SELECT id, note_id AS noteId, created_at AS createdAt,
              length(content) AS length, source
       FROM note_revisions
       WHERE note_id = ?
       ORDER BY created_at DESC`,
      (stmtId) => dbClient.call('all', { stmtId, params: [noteId] }) as Promise<NoteRevisionSummary[]>,
    )
  }

  /** 读单条 revision 的全文（content + frontmatter）。 */
  async findById(revisionId: number): Promise<NoteRevisionDetail | null> {
    const row = (await withCached(
      `SELECT id, note_id AS noteId, created_at AS createdAt,
              length(content) AS length, source,
              content, frontmatter
       FROM note_revisions
       WHERE id = ?`,
      (stmtId) => dbClient.call('get', { stmtId, params: [revisionId] }) as Promise<NoteRevisionDetail | undefined>,
    ))
    return row ?? null
  }

  /**
   * 在写入新正文前调用：把当前正文 + frontmatter snapshot 一行。
   * - noteId 不存在的 revisions 会被 ON DELETE CASCADE 自动带走，无需手工清理。
   * - append 后跑 prune：超出 50 行的最早 snapshot 自动删除。
   * - source 默认 'auto'（writeNote 触发）；用户手动保存的版本传 'manual'。
   */
  async append(
    noteId: string,
    content: string,
    frontmatter: string,
    source: 'auto' | 'manual' = 'auto',
  ): Promise<void> {
    await withCached(
      `INSERT INTO note_revisions (note_id, content, frontmatter, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      (stmtId) => dbClient.call('run', {
        stmtId,
        params: [noteId, content, frontmatter, source, new Date().toISOString()],
      }),
    )
    await this.prune(noteId)
  }

  /** 列出某条 note 全部 revision 后，保留最近 MAX_REVISIONS_PER_NOTE 行。 */
  async prune(noteId: string): Promise<void> {
    // 单 SQL 子查询：拿到「保留行」的最小 id，超出的全部 DELETE。
    // 复合索引 (note_id, created_at DESC) 直接覆盖 ORDER BY。
    await withCached(
      `DELETE FROM note_revisions
       WHERE note_id = ?
         AND id NOT IN (
           SELECT id FROM note_revisions
           WHERE note_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )`,
      (stmtId) => dbClient.call('run', {
        stmtId,
        params: [noteId, noteId, MAX_REVISIONS_PER_NOTE],
      }),
    )
  }

  /**
   * 删一条 revision（用户在 history drawer 里手动清理某条 snapshot）。
   * 不在 IPC 暴露给 UI —— UI 只暴露 restore-revision；手动删除走
   * main 进程内部清理。
   */
  async deleteById(revisionId: number): Promise<boolean> {
    const result = (await withCached(
      `DELETE FROM note_revisions WHERE id = ?`,
      (stmtId) => dbClient.call('run', { stmtId, params: [revisionId] }) as Promise<{ changes: number }>,
    ))
    return result.changes > 0
  }

  /** 删某条 note 的全部 revisions（purge 时调用）。 */
  async deleteAllForNote(noteId: string): Promise<number> {
    const result = (await withCached(
      `DELETE FROM note_revisions WHERE note_id = ?`,
      (stmtId) => dbClient.call('run', { stmtId, params: [noteId] }) as Promise<{ changes: number }>,
    ))
    return result.changes
  }
}

export const noteRevisionsRepo = new NoteRevisionsRepository()
