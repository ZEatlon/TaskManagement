/**
 * AI 对话文件夹仓储
 *
 * 设计要点（与 noteFolders.ts 保持一致）：
 * - 扁平结构（一层），无嵌套
 * - 用户可创建 / 重命名 / 删除文件夹
 * - 删除文件夹：把内部 conversations 的 folder_id 置 NULL（不级联删对话）
 * - 共享 noteFolders 的 NoteFolderColor palette
 *
 * 表 schema 见 migrations/011-ai-conv-folders.sql
 *
 * 与 noteFolders.ts 的关键差异：
 * - 命名空间是 ai_conversation_folders，与 note_folders 完全隔离；
 *   AI folder 删除不会牵连 note folder，反之亦然
 * - findAllOrdered 返回所有文件夹，供 ConversationList 渲染侧边栏
 */
import { Repository } from '../repository'
import { dbClient } from '../client'
import log from '../../log'
import type { AiConversationFolder, NoteFolderColor } from '@shared/types/ai'

interface FolderRow {
  id: string
  name: string
  color: string | null
  order_num: number
  created_at: string
  updated_at: string
}

function rowToFolder(r: FolderRow): AiConversationFolder {
  return {
    id: r.id,
    name: r.name,
    color: (r.color as NoteFolderColor | null) ?? null,
    order: r.order_num ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class AiConversationFoldersRepository extends Repository<AiConversationFolder> {
  constructor() {
    super('ai_conversation_folders')
  }

  protected fromRow(row: unknown): AiConversationFolder {
    return rowToFolder(row as FolderRow)
  }

  /** 创建文件夹（自动追加到末尾 order） */
  async create(input: {
    name: string
    color?: NoteFolderColor | null
    order?: number
  }): Promise<AiConversationFolder> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    if (typeof input.order === 'number') {
      const stmtId = await this.prepare(
        `INSERT INTO ai_conversation_folders (id, name, color, order_num, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      await dbClient.call('run', {
        stmtId,
        params: [id, input.name, input.color ?? null, input.order, now, now],
      })
      return {
        id,
        name: input.name,
        color: input.color ?? null,
        order: input.order,
        createdAt: now,
        updatedAt: now,
      }
    }

    // 与 noteFolders.create 一致：INSERT 内嵌 SELECT COALESCE(MAX(...)) + 1
    // 原子拿下一个 order，避免并发 create 时各自读到同 MAX+1。
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const stmtId = await this.prepare(
        `INSERT INTO ai_conversation_folders (id, name, color, order_num, created_at, updated_at)
         VALUES (?, ?, ?,
                 COALESCE((SELECT MAX(order_num) FROM ai_conversation_folders), -1) + 1,
                 ?, ?)`,
      )
      let result
      try {
        result = (await dbClient.call('run', {
          stmtId,
          params: [id, input.name, input.color ?? null, now, now],
        })) as { changes?: number }
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('UNIQUE') || msg.includes('SQLITE_CONSTRAINT')) {
          await new Promise((r) => setTimeout(r, 10))
          continue
        }
        throw err
      }
      if (result?.changes === 1) {
        const readStmtId = await this.prepare(
          `SELECT order_num FROM ai_conversation_folders WHERE id = ?`,
        )
        const orderRow = (await dbClient.call('get', {
          stmtId: readStmtId,
          params: [id],
        })) as { order_num: number } | null
        const order = orderRow?.order_num ?? 0
        return {
          id,
          name: input.name,
          color: input.color ?? null,
          order,
          createdAt: now,
          updatedAt: now,
        }
      }
      lastErr = new Error('insert returned changes=0 unexpectedly')
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(
      `[aiConversationFolders.create] failed after 5 attempts (UNIQUE race on order_num): ${String(lastErr)}`,
    )
  }

  /** 更新文件夹（重命名 / 改色 / 排序） */
  async update(
    id: string,
    patch: { name?: string; color?: NoteFolderColor | null; order?: number },
  ): Promise<AiConversationFolder | null> {
    const existing = await this.findById(id)
    if (!existing) return null
    const merged = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    // updated_at CAS WHERE 谓词避免 lost-update（与 noteFolders.update 对齐）
    for (let attempt = 0; attempt < 3; attempt++) {
      const stmtId = await this.prepare(
        `UPDATE ai_conversation_folders
         SET name = ?, color = ?, order_num = ?, updated_at = ?
         WHERE id = ? AND updated_at = ?`,
      )
      const result = (await dbClient.call('run', {
        stmtId,
        params: [merged.name, merged.color, merged.order, merged.updatedAt, id, existing.updatedAt],
      })) as { changes?: number }
      if (result?.changes === 1) return merged
      const fresh = await this.findById(id)
      if (!fresh) return null
      Object.assign(merged, {
        ...fresh,
        ...patch,
        updatedAt: new Date().toISOString(),
      })
      Object.assign(existing, fresh)
    }
    log.warn(
      `[aiConversationFolders.update] CAS exhausted after 3 attempts for folder id=${id}; surfacing as failure`,
    )
    return null
  }

  /** 按 order_num ASC, name ASC 列出所有文件夹 */
  async findAllOrdered(): Promise<AiConversationFolder[]> {
    const stmtId = await this.prepare(
      `SELECT * FROM ai_conversation_folders ORDER BY order_num ASC, name ASC`,
    )
    const rows = (await dbClient.call('all', { stmtId })) as FolderRow[]
    return rows.map(rowToFolder)
  }

  /**
   * 删除文件夹（软删除策略：把内部 conversations 的 folder_id 置 NULL）
   * 返回被牵连的对话数（用于 UI 提示「该文件夹下 N 条对话已移至未分类」）
   * 用 dbClient.runInTransaction 串行化，detach + delete 原子。
   */
  async deleteAndDetach(id: string): Promise<{ deleted: boolean; detachedConversations: number }> {
    let result: { deleted: boolean; detachedConversations: number } = {
      deleted: false,
      detachedConversations: 0,
    }
    await dbClient.runInTransaction(async () => {
      await dbClient.call('exec', { sql: 'BEGIN' })
      try {
        const detachStmtId = await this.prepare(
          `UPDATE ai_conversations SET folder_id = NULL WHERE folder_id = ?`,
        )
        const detachInfo = (await dbClient.call('run', {
          stmtId: detachStmtId,
          params: [id],
        })) as { changes: number }
        const deleted = await this.delete(id)
        await dbClient.call('exec', { sql: 'COMMIT' })
        result = { deleted, detachedConversations: detachInfo.changes }
      } catch (err) {
        try {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
        } catch {
          /* swallow */
        }
        throw err
      }
    })
    return result
  }
}

export const aiConversationFoldersRepo = new AiConversationFoldersRepository()