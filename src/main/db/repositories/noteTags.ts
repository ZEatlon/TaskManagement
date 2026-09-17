/**
 * 笔记 ↔ 标签 关系仓储（W1-D tag dual-source merge）
 *
 * 设计背景：
 *   - 旧实现：notes.tags_json 存的是 tag **名字符串列表**（来自 markdown
 *     frontmatter），与 tags 表（id, name, color, parent_id）完全独立。
 *     一旦 tag 在 Sidebar 被重命名 / 删除，notes.tags_json 不会跟随，
 *     搜索 / 列表两边都失配。
 *
 *   - 新实现：note_tags(note_id, tag_id) 是单一真源（按 tag_id 关联，
 *     不会因重命名失配）。notes.tags_json 保留为 frontmatter 同步的副产
 *     物（让 .md 文件还是人可读、可手工编辑的源），读取优先走 note_tags。
 *
 * 双写策略（dual-write window）：
 *   - 写笔记时：repo.writeForNote() 同时写 notes.tags_json + note_tags
 *   - 读 tag 列表：listForNote() 走 note_tags
 *   - tag rename：tagsRepo.update(id, {name}) 不动 note_tags（按 id 关联
 *     自动跟随）；UI 刷新时按 noteTags.listForNote() 拿到新 name
 *   - tag delete：note_tags 通过 ON DELETE CASCADE 自动清理
 *
 * 下个 release 评估：notes.tags_json 是否可以仅写不读（彻底迁到
 * note_tags）。当前为了 frontmatter 兼容保留双写。
 */
import { dbClient } from '../client'
import { prepareCached } from '../cachedStmt'

/**
 * 关系行：note_id + tag_id
 */
export interface NoteTagRow {
  noteId: string
  tagId: string
}

/**
 * 笔记 tag 列表 —— 给前端 store 用，包含 tag 全字段（name/color/parent_id）
 * 以便 Sidebar 直接渲染。
 */
export interface NoteTagWithMeta extends NoteTagRow {
  name: string
  color: string | null
  parentId: string | null
}

interface RawRow {
  noteId: string
  tagId: string
  name: string
  color: string | null
  parentId: string | null
}

function mapRow(r: Record<string, unknown>): RawRow {
  return {
    noteId: r.noteId as string,
    tagId: r.tagId as string,
    name: r.name as string,
    color: (r.color as string | null) ?? null,
    parentId: (r.parentId as string | null) ?? null,
  }
}

const SQL_LIST_FOR_NOTE = `
  SELECT nt.note_id AS noteId,
         nt.tag_id  AS tagId,
         t.name     AS name,
         t.color    AS color,
         t.parent_id AS parentId
  FROM note_tags nt
  JOIN tags t ON t.id = nt.tag_id
  WHERE nt.note_id = ?
  ORDER BY t.name COLLATE NOCASE ASC
`

const SQL_LIST_NOTE_IDS_FOR_TAG = `
  SELECT note_id AS noteId FROM note_tags WHERE tag_id = ?
`

export class NoteTagsRepository {
  /**
   * 列出某笔记全部 tag（join tags 表，按 name 排序稳定）。
   * 空数组表示该笔记尚未关联任何 tag。
   */
  async listForNote(noteId: string): Promise<NoteTagWithMeta[]> {
    if (!noteId) return []
    const stmtId = await prepareCached(SQL_LIST_FOR_NOTE)
    const rows = (await dbClient.call('all', {
      stmtId,
      params: [noteId],
    })) as Array<Record<string, unknown>>
    return rows.map(mapRow)
  }

  /**
   * 替换某笔记全部 tag 关联（事务：先清后插）。
   * - 空数组 = 解绑全部 tag
   * - 重复 tagId 自动去重
   * - 写失败时事务回滚，note_tags 与 notes.tags_json 不会半成品
   *
   * caller 负责保证 tagId 都来自 tags 表（UI 上 tagPicker 只让用户从已有
   * 字典里选；本方法不做 existence 校验以保持轻量）。
   */
  async writeForNote(noteId: string, tagIds: string[]): Promise<void> {
    if (!noteId) throw new Error('noteTags.writeForNote: noteId required')
    const unique = Array.from(new Set(tagIds.filter((t) => typeof t === 'string' && t)))
    await dbClient.call('exec', { sql: 'BEGIN' })
    try {
      await dbClient.call('run', {
        sql: 'DELETE FROM note_tags WHERE note_id = ?',
        params: [noteId],
      })
      for (const tagId of unique) {
        await dbClient.call('run', {
          sql: 'INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)',
          params: [noteId, tagId],
        })
      }
      await dbClient.call('exec', { sql: 'COMMIT' })
    } catch (err) {
      await dbClient.call('exec', { sql: 'ROLLBACK' }).catch(() => undefined)
      throw err
    }
  }

  /**
   * 列出一个 tag 下全部笔记 id（listByTag 主路径）。
   * 不 join notes —— caller 拿到 id 后自己用 notesRepo.findById 拉详情，
   * 避免 repository 之间的循环依赖。
   */
  async listNoteIdsForTag(tagId: string): Promise<string[]> {
    if (!tagId) return []
    const stmtId = await prepareCached(SQL_LIST_NOTE_IDS_FOR_TAG)
    const rows = (await dbClient.call('all', {
      stmtId,
      params: [tagId],
    })) as Array<Record<string, unknown>>
    return rows.map((r) => r.noteId as string)
  }

  /**
   * 按 noteId 列表批量反查全部 tag（多笔记列表页用，单次 SQL 拿全集，
   * 避免 N+1）。
   */
  async listForNotes(noteIds: string[]): Promise<Map<string, NoteTagWithMeta[]>> {
    const out = new Map<string, NoteTagWithMeta[]>()
    if (noteIds.length === 0) return out
    const placeholders = noteIds.map(() => '?').join(',')
    const sql = `
      SELECT nt.note_id AS noteId,
             nt.tag_id  AS tagId,
             t.name     AS name,
             t.color    AS color,
             t.parent_id AS parentId
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE ASC
    `
    const stmtId = await prepareCached(sql)
    const rows = (await dbClient.call('all', {
      stmtId,
      params: noteIds,
    })) as Array<Record<string, unknown>>
    for (const r of rows) {
      const mapped = mapRow(r)
      const arr = out.get(mapped.noteId) ?? []
      arr.push(mapped)
      out.set(mapped.noteId, arr)
    }
    return out
  }
}

export const noteTagsRepo = new NoteTagsRepository()
