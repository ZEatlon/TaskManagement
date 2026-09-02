/**
 * 标签仓储（支持嵌套）
 */
import { Repository } from '../repository'
import { dbClient } from '../client'
import type { Tag } from '@shared/types'

export class TagsRepository extends Repository<Tag> {
  constructor() {
    super('tags')
  }

  /**
   * R18 修复 (critical)：Repository<Tag>.findById 默认走基类 fromRow = `row as T`，
   * 但 DB 行是 snake_case（parent_id / order_num / created_at / updated_at），
   * Tag 接口是 camelCase（parentId / order / createdAt / updatedAt）。原本
   * tags.update() 直接读 existing.parentId / existing.updatedAt / existing.order
   * 全部 undefined —— UPDATE 把 undefined 当 NULL 绑进 CAS 谓词，changes=0，
   * 每次 update 都抛 "tag was modified concurrently"。本仓库之前只在 findByName /
   * findByNameInScope / findAllTree 三个 helper 里手写 snake→camel 转换，漏了
   * 基类 findById 这条最常用的路径。
   *
   * 修复：覆写 fromRow 让所有走基类的查询（findById / findAll）都拿到正确
   * camelCase Tag；之前的 helper 路径保持不变（重复代码无害）。
   */
  protected fromRow(row: unknown): Tag {
    const r = row as Record<string, unknown>
    return {
      id: r.id as string,
      name: r.name as string,
      parentId: (r.parent_id as string | null) ?? null,
      color: (r.color as string | null) ?? null,
      order: (r.order_num as number) ?? 0,
      createdAt: r.created_at as string,
      updatedAt: (r.updated_at as string | null) ?? (r.created_at as string),
    }
  }

  async create(input: Omit<Tag, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Tag> {
    // R13 修复 (medium)：UNIQUE(name, parent_id) 约束存在 → 重复 tag 名会
    // 抛 SqliteError。改为先 findByNameInScope，命中则直接返回现有；真要
    // 新建才 INSERT。避免 IPC 失败把"成功重复请求"展示为"错误"。
    const existing = await this.findByNameInScope(input.name, input.parentId)
    if (existing) return existing
    const id = input.id ?? crypto.randomUUID()
    const now = new Date().toISOString()
    const stmtId = await this.prepare(
      `INSERT INTO tags (id, name, parent_id, color, order_num, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    try {
      await dbClient.call('run', {
        stmtId,
        params: [id, input.name, input.parentId, input.color, input.order, now, now],
      })
    } catch (err) {
      // 极端并发场景：两个 create 同时穿过 findByNameInScope 检查，第二个撞
      // UNIQUE；重新 SELECT 一次并返回现有行。
      const dup = await this.findByNameInScope(input.name, input.parentId)
      if (dup) return dup
      throw err
    }
    return {
      id,
      name: input.name,
      parentId: input.parentId,
      color: input.color,
      order: input.order,
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * R16 修复 (high)：从 private 改 public。原版 findByName 仅按 name 查，
   * 迁移 008 把 UNIQUE(name) 换成 UNIQUE(name, parent_id) 后，不同 parent
   * 下同名 tag 可以共存。AI tools.ts 的 addTag / createSticky 工具需要按
   * (name, parentId) 复合作用域查重 —— 它们调用方没有 findByName 的「全局
   * 平铺」语义假设，所以必须公开这个方法。内部仍由 create/update 复用。
   */
  async findByNameInScope(name: string, parentId: string | null): Promise<Tag | null> {
    const stmtId = await this.prepare(
      `SELECT * FROM tags WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL)) LIMIT 1`,
    )
    const row = (await dbClient.call('get', {
      stmtId,
      params: [name, parentId, parentId],
    })) as Record<string, unknown> | null
    if (!row) return null
    return {
      id: row.id as string,
      name: row.name as string,
      parentId: (row.parent_id as string | null) ?? null,
      color: (row.color as string | null) ?? null,
      order: (row.order_num as number) ?? 0,
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at as string | null) ?? (row.created_at as string),
    }
  }

  async update(id: string, patch: Partial<Tag>): Promise<Tag | null> {
    // R15 修复 (medium + high)：
    // 1. UNIQUE 冲突处理：原版 update 无 try/catch，rename 到同名 tag 直接抛
    //    SqliteError 到 IPC。改为先按 (name, parent_id) 探测重复，命中且不是
    //    当前 id → 返回现有行（与 create() 行为对齐）。
    // 2. CAS 防 race：SELECT 与 UPDATE 之间跨两次 dbClient.call，并发 update
    //    会读到同一 existing 然后 last-writer-wins。改成事务内 CAS（UPDATE
    //    ... WHERE id=? AND updated_at=?），changes=0 时抛 Conflict。
    //
    // R17 修复 (high correctness)：R15 的 CAS 用 created_at 作谓词，但 UPDATE
    // SET 子句不修改 created_at → 所有并发写者都满足谓词、changes=1、Conflict
    // 分支死代码。修复：CAS 谓词改用 updated_at（每写者都会 SET updated_at=
    // NOW()），让真正的并发冲突能被检测出来。
    //
    // R25-DI-6 修复 (high data integrity)：原版手动 await dbClient.call('exec',
    // { sql: 'BEGIN' }) / 'COMMIT' / 'ROLLBACK'，跨多次 IPC 让出事件循环。
    // 这是 R23-DI-2 runInTransaction 引入后**唯一**仍走裸 BEGIN/COMMIT 的仓库；
    // 两个并发 tag.update（用户在两个 tab 同时打开编辑 modal / AI 工具 + 用户）
    // 会撞 'cannot start a transaction within a transaction'，catch 块对错误
    // 事务发 ROLLBACK 错杀第一个事务。改为 runInTransaction(work) 串行化。
    //
    // R26-DI-3 修复 (high FK / cycle-prevention)：原版 update() 接受任意
    // parentId —— 包括 tag 自身的 id（自环）或某个后代 tag 的 id（形成环
    // A→B→C→A）。一旦成环：
    //   1) 删除任一节点会触发 SQLite ON DELETE CASCADE 触发器递归超 25 层
    //      抛 'too many levels of trigger recursion'，整个 delete 事务失败；
    //   2) findAllTree 的 JS 嵌套渲染会无限递归 → UI 卡死 / 栈溢出。
    // 修复：合并 patch 后若 parentId 变化，验证 parentId !== id 且 parentId
    // 不在以 id 为根的祖先链里（向上走 parent_id 直到 NULL/根）。为原子化，
    // 整个 cycle 探测 + UPDATE 包在同一事务里（迁移 008 留下的循环已在
    // R26-DI-3 之前清掉，这里只防新建）。
    return await dbClient.runInTransaction(async () => {
      await dbClient.call('exec', { sql: 'BEGIN' })
      try {
        const existing = await this.findById(id)
        if (!existing) {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
          return null
        }
        // R26-DI-3：parentId 变化时做 cycle 探测（同一事务内）。
        if (patch.parentId !== undefined && patch.parentId !== existing.parentId) {
          const newParentId = patch.parentId ?? null
          if (newParentId === id) {
            await dbClient.call('exec', { sql: 'ROLLBACK' })
            throw new Error(
              `tags.update: refusing to set parentId to self (id=${id}); would create a self-cycle`,
            )
          }
          if (newParentId !== null && (await this.wouldCreateCycle(id, newParentId))) {
            await dbClient.call('exec', { sql: 'ROLLBACK' })
            throw new Error(
              `tags.update: refusing parentId=${newParentId} for tag id=${id}; would create a cycle (target is a descendant)`,
            )
          }
        }
        const now = new Date().toISOString()
        const merged: Tag = {
          ...existing,
          ...patch,
          id,
          // 把 updated_at 重置为 now，让其他并发的 update / findById 看到的新值不同
          updatedAt: now,
        }
        if (patch.name !== undefined || patch.parentId !== undefined) {
          const dup = await this.findByNameInScope(merged.name, merged.parentId)
          if (dup && dup.id !== id) {
            // R29-DI-2 修复 (CRITICAL silent-success)：原版 rename 到同名
            // tag 时静默 COMMIT + return dup。IPC handler 收到 dup 行，UI
            // 把它当作「重命名成功」显示，但 DB 里原 tag 的 name 仍是旧值。
            // 下次刷新 UI 时 rename 状态消失，用户以为操作丢了。修复：
            // 显式抛错让 IPC 透传给渲染端，UI 显示冲突提示（与 sticky update
            // 的 CAS 冲突路径一致）。dup 信息附带在错误消息里便于渲染端
            // 显示「已存在同名 tag」提示。
            await dbClient.call('exec', { sql: 'ROLLBACK' })
            throw new Error(
              `tags.update: refusing rename — another tag (id=${dup.id}, name=${dup.name}) ` +
              `already exists in the same parent scope`,
            )
          }
        }
        const stmtId = await this.prepare(
          `UPDATE tags
           SET name = ?, parent_id = ?, color = ?, order_num = ?, updated_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        const result = (await dbClient.call('run', {
          stmtId,
          params: [
            merged.name,
            merged.parentId,
            merged.color,
            merged.order,
            now,
            id,
            existing.updatedAt,
          ],
        })) as { changes?: number }
        if (!result || result.changes === 0) {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
          throw new Error('tags.update: tag was modified concurrently — please refresh and retry')
        }
        await dbClient.call('exec', { sql: 'COMMIT' })
        return merged
      } catch (err) {
        try {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
        } catch {
          /* ignore */
        }
        throw err
      }
    })
  }

  /**
   * R26-DI-3 辅助：检测「把 tag id 的 parentId 设为 candidateParentId」是否会
   * 形成环。从 candidateParentId 出发向上走 parent_id 链；若途中遇到 id，
   * 说明 id 是 candidateParentId 的祖先（candidateParentId 是 id 的后代）→
   * 把 id 设为 candidateParentId 的子会让环闭合，返回 true 拒绝。
   *
   * 必须在调用方的事务里跑（读到的 parent_id 链可能与最终 commit 不一致，
   * 但 SQLite 写事务串行化下任何 race 都会让外层 CAS 失败回滚 —— 探测阶段
   * 读到的是「事务开始时的快照」，对单写者足够）。
   */
  private async wouldCreateCycle(id: string, candidateParentId: string): Promise<boolean> {
    const stmtId = await this.prepare(`SELECT id, parent_id FROM tags`)
    try {
      const rows = (await dbClient.call('all', { stmtId })) as Array<{
        id: string
        parent_id: string | null
      }>
      const parentOf = new Map<string, string | null>()
      for (const r of rows) parentOf.set(r.id, r.parent_id)
      // 从 candidateParentId 向上走，遇 id 即命中环
      let cur: string | null = candidateParentId
      const seen = new Set<string>()
      while (cur != null) {
        if (cur === id) return true
        if (seen.has(cur)) {
          // 历史数据遗留的环（迁移 008 之外的情况）→ 安全兜底为「是」，
          // 阻止任何让环扩展的 parentId 改动，避免雪上加霜
          return true
        }
        seen.add(cur)
        cur = parentOf.get(cur) ?? null
      }
      return false
    } finally {
      // 不显式 finalize —— 走 this.prepare() 走 stmtCache，让 LRU 处理
    }
  }

  /** 列出所有标签，并按 parentId 排序便于 UI 嵌套渲染 */
  async findAllTree(): Promise<Tag[]> {
    const stmtId = await this.prepare(
      `SELECT * FROM tags ORDER BY COALESCE(parent_id, ''), order_num ASC, name ASC`,
    )
    const rows = (await dbClient.call('all', { stmtId })) as Array<{
      id: string
      name: string
      parent_id: string | null
      color: string | null
      order_num: number
      created_at: string
      updated_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      color: r.color,
      order: r.order_num,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? r.created_at,
    }))
  }

  async findByName(name: string): Promise<Tag | null> {
    const stmtId = await this.prepare(`SELECT * FROM tags WHERE name = ?`)
    const row = (await dbClient.call('get', { stmtId, params: [name] })) as Record<string, unknown> | null
    if (!row) return null
    return {
      id: row.id as string,
      name: row.name as string,
      parentId: (row.parent_id as string | null) ?? null,
      color: (row.color as string | null) ?? null,
      order: (row.order_num as number) ?? 0,
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at as string | null) ?? (row.created_at as string),
    }
  }
}

export const tagsRepo = new TagsRepository()