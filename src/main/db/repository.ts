/**
 * 仓储基类
 *
 * 提供预编译 SQL 语句缓存 + 通用 CRUD 辅助方法。
 * 子类只需定义表名与具体 SQL。
 */
import { dbClient } from './client'

export class Repository<T extends { id: string }> {
  protected stmtCache = new Map<string, number>()
  // R25-DI-5 修复 (high cache-stale-after-respawn)：worker 进程被
  // scheduleRespawn 重启后，新 worker 的 prepareCache 从 nextId=1 起步，
  // 但主进程持有的 stmtCache 仍指旧 stmtId —— 必须清空。构造时向
  // dbClient 注册一个 invalidate 回调，worker ready 后会自动触发。
  // 注意：必须在 super() 内同步注册（不能在异步 effect 里），否则
  // 第一次 worker 启动（start() 里 ready 后广播 invalidate）时还没注册。
  constructor(protected tableName: string) {
    dbClient.registerStmtCacheInvalidator(() => {
      this.stmtCache.clear()
    })
  }

  protected async prepare(sql: string): Promise<number> {
    let id = this.stmtCache.get(sql)
    if (id !== undefined) return id
    const res = await dbClient.call<{ stmtId: number }>('prepare', { sql })
    if (!res) throw new Error('Failed to prepare statement')
    id = res.stmtId
    this.stmtCache.set(sql, id)
    return id
  }

  /**
   * 子类必须实现：将原始数据库行映射为领域对象 T。
   * 基类默认仅做强制类型转换，不做任何字段转换。
   * 当表 schema（snake_case）与领域类型（camelCase）不一致时，
   * 子类必须覆写此方法以保证返回值的字段名与 T 一致。
   */
  protected fromRow(row: unknown): T {
    return row as T
  }

  async findById(id: string): Promise<T | null> {
    const stmtId = await this.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`)
    const row = (await dbClient.call('get', { stmtId, params: [id] })) as unknown
    return row === null || row === undefined ? null : this.fromRow(row)
  }

  async findAll(orderBy = 'created_at DESC'): Promise<T[]> {
    const stmtId = await this.prepare(`SELECT * FROM ${this.tableName} ORDER BY ${orderBy}`)
    const rows = (await dbClient.call('all', { stmtId })) as unknown[]
    return rows.map((r) => this.fromRow(r))
  }

  async delete(id: string): Promise<boolean> {
    const stmtId = await this.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`)
    const info = (await dbClient.call('run', { stmtId, params: [id] })) as { changes: number }
    return info.changes > 0
  }

  async count(where = '1=1'): Promise<number> {
    const stmtId = await this.prepare(`SELECT COUNT(*) as c FROM ${this.tableName} WHERE ${where}`)
    const row = (await dbClient.call('get', { stmtId })) as { c: number } | null
    return row?.c ?? 0
  }
}