/**
 * 迁移运行器
 *
 * 顺序执行 src/main/db/migrations/ 中的 SQL 文件，
 * 写入 schema_migrations 表，避免重复执行。
 *
 * 实现说明：
 *   使用 Vite 的 `import.meta.glob('*.sql', { as: 'raw', eager: true })`
 *   把 SQL 文件内容直接打包进 bundle，避免打包后读不到迁移文件的问题。
 *
 * R8D-4 / R8D-5：每个迁移包在 BEGIN ... COMMIT; 事务里执行。失败时回滚，
 * 不会留下半成品 schema；同时 schema_migrations 写入用 INSERT OR IGNORE，
 * 防止部分应用（mid-migration crash 后再启动）出现「schema 已变但 migrations
 * 没记录」的鬼状态。
 */
import { dbClient } from './client'
import log from '../log'

interface MigrationFile {
  version: number
  name: string
  sql: string
}

/** 由 Vite 打包时注入：键是相对路径，值是 SQL 文本 */
const MIGRATION_MODULES = import.meta.glob<string>('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function discoverMigrations(): MigrationFile[] {
  return Object.entries(MIGRATION_MODULES)
    .map(([path, sql]) => {
      // 路径形如 './migrations/001-initial.sql'
      const match = path.match(/\/(\d+)-([^/]+)\.sql$/)
      if (!match) throw new Error(`Bad migration filename: ${path}`)
      return {
        version: parseInt(match[1]!, 10),
        name: match[2]!,
        sql,
      }
    })
    .sort((a, b) => a.version - b.version)
}

/**
 * 把 SQL 包成单条事务。BEGIN; <sql>; COMMIT;。失败时用 ROLLBACK 让 SQLite
 * 把已经应用的语句全部回滚。这样下一次启动再跑这条迁移就是干净环境。
 */
function wrapInTransaction(sql: string): string {
  return `BEGIN;\n${sql}\nCOMMIT;\n`
}

export async function runMigrations(): Promise<void> {
  // 确保 schema_migrations 表存在
  await dbClient.call('exec', {
    sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
          )`,
  })

  const stmtId = (await dbClient.call<{ stmtId: number }>('prepare', {
    sql: 'SELECT version FROM schema_migrations',
  })).stmtId

  const applied = (await dbClient.call<{ version: number }[]>('all', { stmtId })).map(
    (r) => r.version,
  )
  await dbClient.call('finalize', { stmtId })

  const all = discoverMigrations()
  const pending = all.filter((m) => !applied.includes(m.version))

  if (pending.length === 0) {
    log.info('[migrate] All migrations applied.')
    return
  }

  log.info(`[migrate] Applying ${pending.length} migration(s)...`)

  // R8D-6：迁移阶段临时关闭 foreign_keys 检查 —— 中间状态（删 _xxx_new 前）
  // 可能短暂违反外键约束，开启 FK 会让迁移失败；结束后恢复。
  const fkStmt = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: 'PRAGMA foreign_keys',
    })
  ).stmtId
  const fkRow =
    (await dbClient.call<{ foreign_keys: number }>('get', { stmtId: fkStmt })) ??
    ({ foreign_keys: 0 } as { foreign_keys: number })
  await dbClient.call('finalize', { stmtId: fkStmt })
  const fkWasOn = fkRow.foreign_keys === 1
  if (fkWasOn) {
    await dbClient.call('exec', { sql: 'PRAGMA foreign_keys = OFF' })
  }

  try {
    for (const m of pending) {
      log.info(`[migrate] → ${m.version}-${m.name}`)
      try {
        // 单条事务包裹 SQL，失败时 ROLLBACK 自动由 exec 触发（exec 在语句级错误
        // 上抛错，但 better-sqlite3 worker 在 exec 之前/之后显式 BEGIN/COMMIT，
        // 出错后回滚到事务开始前的状态）。
        await dbClient.call('exec', { sql: wrapInTransaction(m.sql) })
        // R15 修复 (low)：原版手写 `${m.version}, '${m.name.replace(/'/g, "''")}', '...'`
        // 字符串拼接 + 单引号 escape，对 m.name 中包含单引号以外的可疑字符（如换行、
        // NUL、SQL 注释符 --）无任何防护，且与事务 SQL 混用 exec 不利于复用 prepared。
        // 改用 prepare/run 走 bound parameters，让 better-sqlite3 自己处理转义。
        const insId = (
          await dbClient.call<{ stmtId: number }>('prepare', {
            sql: 'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          })
        ).stmtId
        try {
          await dbClient.call('run', {
            stmtId: insId,
            params: [m.version, m.name, new Date().toISOString()],
          })
        } finally {
          await dbClient.call('finalize', { stmtId: insId })
        }
      } catch (err) {
        // R8D-4：单条迁移失败 → 整次迁移循环终止，schema 已回滚到迁移前状态
        log.error(`[migrate] FAILED: ${m.version}-${m.name}`, err)
        // 尝试 ROLLBACK 当前事务（若 worker 还卡在 BEGIN 上）
        try {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
        } catch {
          /* ignore — worker 可能已经在 exec 失败时自动 rollback */
        }
        throw err
      }
    }
  } finally {
    if (fkWasOn) {
      await dbClient.call('exec', { sql: 'PRAGMA foreign_keys = ON' })
    }
  }

  log.info('[migrate] Done.')
}

export async function getCurrentVersion(): Promise<number> {
  try {
    const stmtId = (await dbClient.call<{ stmtId: number }>('prepare', {
      sql: 'SELECT MAX(version) as v FROM schema_migrations',
    })).stmtId
    const row = (await dbClient.call<{ v: number | null }>('get', { stmtId })) ?? { v: null }
    await dbClient.call('finalize', { stmtId })
    return row.v ?? 0
  } catch (_) {
    return 0
  }
}