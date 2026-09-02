/**
 * 笔记文件夹仓储
 *
 * 设计要点：
 * - 扁平结构（一层），无嵌套 —— 与便签的扁平一致
 * - 用户可创建 / 重命名 / 删除文件夹
 * - 删除文件夹：把内部 notes 的 folder_id 置 NULL（不级联删笔记）
 * - 每个文件夹可绑定可选 color（与便签 palette 共用 8 色）
 *
 * 表 schema 见 migrations/005-note-folders.sql
 */
import { Repository } from '../repository'
import { dbClient } from '../client'
import log from '../../log'
import type { NoteFolder, NoteFolderColor } from '@shared/types'

interface FolderRow {
  id: string
  name: string
  color: string | null
  order_num: number
  created_at: string
  updated_at: string
}

function rowToFolder(r: FolderRow): NoteFolder {
  return {
    id: r.id,
    name: r.name,
    color: (r.color as NoteFolderColor | null) ?? null,
    order: r.order_num ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class NoteFoldersRepository extends Repository<NoteFolder> {
  constructor() {
    super('note_folders')
  }

  protected fromRow(row: unknown): NoteFolder {
    return rowToFolder(row as FolderRow)
  }

  /** 创建文件夹（自动追加到末尾 order） */
  async create(input: {
    name: string
    color?: NoteFolderColor | null
    order?: number
  }): Promise<NoteFolder> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    // R25-DI-3 修复 (high lost-update)：原版先 await nextOrder()（一次
    // dbClient.call IPC）再 INSERT（又一次 IPC），中间让出事件循环。两个
    // 并发 create 各自读到相同 MAX+1 → INSERT 同 order_num → 排序结果不
    // 确定。修复：把「拿 MAX+1」嵌入 INSERT 的 SELECT 子查询，单语句原子；
    // caller 显式传 order 时走 VALUES 直插。
    //
    // 同时兜底：UNIQUE(order_num) 约束（005 migration）保证即便极端 race
    // 撞键（subquery 在并发时各自读到同 MAX+1），UNIQUE 报错由 catch 捕获
    // 后退避 10ms 重试，最多 5 次 —— 重试间另一事务应该已 commit，可见
    // 新 MAX+1。
    if (typeof input.order === 'number') {
      const stmtId = await this.prepare(
        `INSERT INTO note_folders (id, name, color, order_num, created_at, updated_at)
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
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const stmtId = await this.prepare(
        `INSERT INTO note_folders (id, name, color, order_num, created_at, updated_at)
         VALUES (?, ?, ?,
                 COALESCE((SELECT MAX(order_num) FROM note_folders), -1) + 1,
                 ?, ?)`,
      )
      // R33-DI-1 修复 (HIGH note-folders-create-retry-dead)：原版循环里
      // 缺 try/catch —— 两个并发 INSERT 各自读到同 MAX+1，第二个撞
      // UNIQUE(order_num) 抛 SQLITE_CONSTRAINT_UNIQUE 后**没人接住**，for
      // 循环直接挂掉，用户看到 raw 错误。修复：try/catch 包住 INSERT，捕
      // 到 UNIQUE 时退避 10ms 重试。5 次仍冲突 → 抛带 lastErr 的 contextual
      // 错误（与 R25-DI-3 注释对齐）。
      let result
      try {
        result = (await dbClient.call('run', {
          stmtId,
          params: [id, input.name, input.color ?? null, now, now],
        })) as { changes?: number }
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('SQLITE_CONSTRAINT_UNIQUE') || msg.includes('UNIQUE')) {
          await new Promise((r) => setTimeout(r, 10))
          continue
        }
        throw err
      }
      if (result?.changes === 1) {
        // 读回真正的 order_num 用于返回对象（subquery 在 INSERT 时求值，
        // 不在 prepared stmt 的 params 里，需要 SELECT 拿一下）
        const readStmtId = await this.prepare(
          `SELECT order_num FROM note_folders WHERE id = ?`,
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
      // 极端 race：退避 10ms 后重试
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(
      `[noteFolders.create] failed after 5 attempts (UNIQUE race on order_num): ${String(lastErr)}`,
    )
  }

  /**
   * 更新文件夹（重命名 / 改色 / 排序）
   * - patch 中只覆盖显式给出的字段
   */
  async update(
    id: string,
    patch: { name?: string; color?: NoteFolderColor | null; order?: number },
  ): Promise<NoteFolder | null> {
    const existing = await this.findById(id)
    if (!existing) return null
    const merged = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    // R20 修复 (medium lost-update)：原 UPDATE 无 CAS，并发 update() 在
    // IPC handler 频繁触发（如用户在两个 tab 同时打开编辑 modal）时最后写入
    // 的「颜色」会覆盖「重命名」或反之。改用 updated_at CAS WHERE 谓词，
    // 失败时回读到最新 row 重新合并，最多 3 次重试。
    //
    // R24-DI-1 修复 (high lost-update silent success)：3 次重试用尽后原版
    // 直接 return merged —— 此时 DB 行由最后一个并发 writer 写入，**本调用
    // 的 patch 根本没落到 DB**，但 merged 对象看起来像成功合并了。调用方
    // （IPC handler）误以为重命名成功，用户下次 reload 发现名字没变。
    // 修复：3 次都用尽时返回 null + 打日志，让 IPC handler 把错误回传给渲染端，
    // 渲染端应 fetch 最新并提示「文件夹并发修改，请重试」。
    for (let attempt = 0; attempt < 3; attempt++) {
      const stmtId = await this.prepare(
        `UPDATE note_folders
         SET name = ?, color = ?, order_num = ?, updated_at = ?
         WHERE id = ? AND updated_at = ?`,
      )
      const result = (await dbClient.call('run', {
        stmtId,
        params: [merged.name, merged.color, merged.order, merged.updatedAt, id, existing.updatedAt],
      })) as { changes?: number }
      if (result?.changes === 1) return merged
      // CAS 失败 → 重新读 latest + 重 merge（重 merge 仍以这次 patch 为准，
      // 但与最新未冲突字段合并，避开被覆盖的更新）
      const fresh = await this.findById(id)
      if (!fresh) return null
      Object.assign(merged, {
        ...fresh,
        ...patch,
        updatedAt: new Date().toISOString(),
      })
      Object.assign(existing, fresh)
    }
    // R24-DI-1：3 次 CAS 全失败说明同一行被其他 writer 反复抢占。返回 null
    // 而不是 merged，避免调用方误以为写成功。
    log.warn(
      `[noteFolders.update] CAS exhausted after 3 attempts for folder id=${id}; surfacing as failure`,
    )
    return null
  }

  /** 按 order_num ASC, name ASC 列出所有文件夹 */
  async findAllOrdered(): Promise<NoteFolder[]> {
    const stmtId = await this.prepare(
      `SELECT * FROM note_folders ORDER BY order_num ASC, name ASC`,
    )
    const rows = (await dbClient.call('all', { stmtId })) as FolderRow[]
    return rows.map(rowToFolder)
  }

  /**
   * 删除文件夹（软删除策略：把内部 notes 的 folder_id 置 NULL）
   * 返回被牵连的笔记数（用于 UI 提示「该文件夹下 N 篇笔记已移至未分类」）
   * BUG-11-fix：用 BEGIN/COMMIT 包起来，保证 detach + delete 原子性。
   * 否则中途崩溃会导致「文件夹还在但笔记已脱钩」的不一致状态。
   */
  async deleteAndDetach(id: string): Promise<{ deleted: boolean; detachedNotes: number }> {
    // R24-DI-9 修复 (medium atomicity)：原版 BEGIN/COMMIT 跨多次 dbClient.call
    // IPC 让出事件循环。两个并发 folder delete（用户在多窗口同时按删除按钮 /
    // AI 工具 + 用户）会交错 BEGIN，第二个事务错杀第一个。改为
    // dbClient.runInTransaction 串行化。
    let result: { deleted: boolean; detachedNotes: number } = {
      deleted: false,
      detachedNotes: 0,
    }
    await dbClient.runInTransaction(async () => {
      await dbClient.call('exec', { sql: 'BEGIN' })
      try {
        // 先把关联笔记的 folder_id 置 NULL
        const detachStmtId = await this.prepare(
          `UPDATE notes SET folder_id = NULL, updated_at = ? WHERE folder_id = ?`,
        )
        const now = new Date().toISOString()
        const detachInfo = (await dbClient.call('run', {
          stmtId: detachStmtId,
          params: [now, id],
        })) as { changes: number }

        // 再删文件夹本身
        const deleted = await this.delete(id)
        await dbClient.call('exec', { sql: 'COMMIT' })
        result = { deleted, detachedNotes: detachInfo.changes }
      } catch (err) {
        try {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
        } catch {
          /* rollback 自身失败也吞掉 —— 原始错误更重要 */
        }
        throw err
      }
    })
    return result
  }

  // R25-DI-3：nextOrder() 不再需要 —— create() 现在用 INSERT 内嵌
  // SELECT COALESCE(MAX(order_num), -1) + 1 子查询原子拿下一个 order。
  // 原 nextOrder 留作 deleted 兼容注释。
}

export const noteFoldersRepo = new NoteFoldersRepository()