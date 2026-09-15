/**
 * 仓储基类
 *
 * 提供预编译 SQL 语句缓存 + 通用 CRUD 辅助方法。
 * 子类只需定义表名与具体 SQL。
 *
 * R-FIX-2 (structure dedup)：原基类自己手抄了一份「Map<sql, stmtId> +
 * constructor 同步注册 invalidate + lookup」样板（与 statsBridge /
 * pomodoros / completions / settings / conversations / notes 同模式）。
 * 改为复用 db/cachedStmt 共享 cache + 共享 invalidate 钩子，所有仓库
 * 按 SQL 文本共享同一 stmtId，worker respawn 时一并清空。
 *
 * 行为保持完全兼容：
 *   - `protected prepare(sql)` 仍然是 Promise<number>、仍然是
 *     "sql 命中即返回，否则 IPC prepare 后存 cache"。
 *   - Repository 子类（TagsRepository 等）继承 `prepare` 不需要任何
 *     改动；它们原本用的就是这个方法。
 *   - worker respawn 后的 stale stmtId 防护仍然有效 —— invalidate
 *     现在统一走 prepareCached 的 module-scope invalidator，而不是
 *     每个 Repository 实例自己的 invalidator。
 */
import { dbClient } from './client'
import { prepareCached } from './cachedStmt'

export class Repository<T extends { id: string }> {
  // 注意：原版在 constructor 里同步注册 invalidator。改为 prepareCached
  // 后 invalidate 在 prepare() 首次被调用时 lazy 注册（与 statsBridge /
  // pomodoros / completions / settings / conversations / notes 一致）。
  // 这是同质的"首次使用时同步注册"语义，对 worker ready 时 broadcast 的
  // invalidate 同样有效。
  constructor(protected tableName: string) {}

  protected prepare(sql: string): Promise<number> {
    return prepareCached(sql)
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