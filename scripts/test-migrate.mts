/**
 * src/main/db/migrate.ts 的 R-test-suite-migrate (test-coverage) 防线单测
 * —— 覆盖：
 *   1. discoverMigrations: 路径正则 / version 排序 / 错文件名抛错
 *   2. runMigrations happy path: schema_migrations 写入 + pending 跳过
 *   3. runMigrations 单条失败: BEGIN/COMMIT/ROLLBACK 路径、整次循环终止、
 *      PRAGMA foreign_keys 在 finally 段恢复、坏 SQL 没写入 schema_migrations
 *   4. runMigrations foreign_keys=ON 路径: 进入前 OFF、完成后 ON
 *   5. schema_migrations INSERT OR IGNORE 幂等: 第二次跑同 migrations 是 no-op
 *
 * 设计：
 *   - scripts/test-loader.mjs 已扩展 isFromMigrate context，把
 *     migrate.ts 的 './client' 替成 testmock://db-client stub（=本测试
 *     注入的 globalThis.__test_dbClient）。
 *   - 测试用真实 better-sqlite3 文件 DB（mkdtempSync 创建临时目录），
 *     把 dbClient.call('exec'|'prepare'|'all'|'get'|'run'|'finalize') 转发
 *     到该 DB；prepare 分配自增 stmtId 维护在 Map 里，finalize 从 Map 摘除。
 *   - runMigrations 通过 `opts.modules` 注入自构造的 SQL map，绕过
 *     Vite 的 import.meta.glob（Node 环境跑不起来）。
 *
 * 运行：npm run test:migrate
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ===== dbClient mock：转发到真实 better-sqlite3 =====
//
// better-sqlite3 同步执行 SQL（不 await 也不让出事件循环），与 migrate.ts
// 用 BEGIN/COMMIT/ROLLBACK 同步控制事务的语义天然契合。我们直接同步执行
// 并把结果包装成与 db-worker 协议相同的形状：
//   exec(sql)        → { ok: true }  （抛错让 catch 兜底）
//   prepare(sql)     → { stmtId: <int> }
//   all(stmtId)      → <rows[]>
//   get(stmtId)      → <row | null>  （better-sqlite3 返回 undefined 时规范化成 null）
//   run(stmtId, params) → { changes: <int> }
//   finalize(stmtId) → { ok: true }
function makeDbClientFromDb(db: Database.Database) {
  const stmts = new Map<number, Database.Statement>()
  let nextStmtId = 1
  return {
    callLog: [] as Array<{ method: string; params: Record<string, unknown> }>,
    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      this.callLog.push({ method, params })
      switch (method) {
        case 'exec': {
          const sql = String(params['sql'] ?? '')
          // better-sqlite3 的 db.exec() 对 BEGIN/COMMIT 事务控制语句不友好
          // —— 它把每条语句当作隐式 auto-commit 跑，COMMIT 时已经没有活跃
          // 事务 → 报 "near COMMIT: syntax error"。这里把 BEGIN/COMMIT 包裹
          // 的 SQL 拆成单条语句逐个 db.exec() 跑，再用 db.transaction() 包
          // 一层确保失败时整段回滚（真实 db-worker 在 better-sqlite3 端也是
          // 同款语义：单事务由 prepared BEGIN/COMMIT 控制）。
          if (/^\s*BEGIN\b/i.test(sql)) {
            const inner = sql
              .replace(/^\s*BEGIN\s*;?\s*/i, '')
              .replace(/\s*COMMIT\s*;?\s*$/i, '')
              .trim()
            // 拆成单条语句（去掉末尾分号 + 空语句）
            const stmts = inner
              .split(/;\s*(?:\n|$)/)
              .map((s) => s.trim())
              .filter(Boolean)
            const tx = db.transaction(() => {
              for (const s of stmts) {
                db.exec(s + ';')
              }
            })
            tx()
          } else if (/^\s*ROLLBACK\b/i.test(sql)) {
            // ROLLBACK 在 better-sqlite3 中没有"挂起事务"概念；migrate.ts
            // 的兜底 ROLLBACK 期望 worker 还卡在 BEGIN 上时才有效，但这里
            // 的事务是同步执行的，跑到 ROLLBACK 时事务要么已提交要么已
            // 因 SQL 错误回滚 → 透传给 db.exec 走 no-op 路径（仍记录到
            // callLog 让测试断言"migrate 调用了 ROLLBACK"）。
            db.exec(sql)
          } else {
            db.exec(sql)
          }
          return { ok: true } as T
        }
        case 'prepare': {
          const stmt = db.prepare(String(params['sql'] ?? ''))
          const stmtId = nextStmtId++
          stmts.set(stmtId, stmt)
          return { stmtId } as T
        }
        case 'finalize': {
          const sid = Number(params['stmtId'])
          stmts.delete(sid)
          return { ok: true } as T
        }
        case 'all': {
          const sid = Number(params['stmtId'])
          const stmt = stmts.get(sid)
          if (!stmt) throw new Error(`mock: stmt ${sid} not found`)
          const rows = stmt.all(...((params['params'] as unknown[]) ?? []))
          return rows as T
        }
        case 'get': {
          const sid = Number(params['stmtId'])
          const stmt = stmts.get(sid)
          if (!stmt) throw new Error(`mock: stmt ${sid} not found`)
          const row = stmt.get(...((params['params'] as unknown[]) ?? []))
          // better-sqlite3 在无结果时返回 undefined；db-worker JSON 序列
          // 化时变 null，migrate.ts 的 fkRow 也按 ?? fallback 处理。
          return (row ?? null) as T
        }
        case 'run': {
          const sid = Number(params['stmtId'])
          const stmt = stmts.get(sid)
          if (!stmt) throw new Error(`mock: stmt ${sid} not found`)
          const r = stmt.run(...((params['params'] as unknown[]) ?? []))
          return { changes: r.changes } as T
        }
        default:
          throw new Error(`mock: unsupported method ${method}`)
      }
    },
    registerStmtCacheInvalidator(_fn: () => void): () => void {
      return () => {}
    },
    runInTransaction<T>(work: () => Promise<T>): Promise<T> {
      // migrate.ts 内部事务由 BEGIN/COMMIT SQL 字符串控制；这里不开外层
      // transaction，让 SQL 字符串透传（与真实 db-worker 行为对齐）。
      return work()
    },
    __close(): void {
      stmts.clear()
      db.close()
    },
  }
}

// ===== 每个测试用临时文件 DB =====

interface TestEnv {
  tmpDir: string
  db: Database.Database
  client: ReturnType<typeof makeDbClientFromDb>
  cleanup: () => void
}

function makeTestEnv(fkOn = true): TestEnv {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'taskpilot-migrate-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  // better-sqlite3 默认 FK off；按 fkOn 参数开关
  db.pragma(`foreign_keys = ${fkOn ? 'ON' : 'OFF'}`)
  const client = makeDbClientFromDb(db)
  return {
    tmpDir,
    db,
    client,
    cleanup: () => {
      client.__close()
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    },
  }
}

;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = undefined as never

// 加载被测模块 —— 顶层 import.meta.glob 在 Node 环境跑不起来（Vite-only），
// 但模块加载只声明常量，惰性调用都在 discoverMigrations(opts.modules) 入参
// 控制下。运行时不依赖 glob 副作用。
const migrate = await import('../src/main/db/migrate.ts')

// ===== 辅助 =====

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name)
  return row !== undefined && row !== null
}

function appliedVersions(db: Database.Database): number[] {
  if (!tableExists(db, 'schema_migrations')) return []
  return (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
    .map((r) => r.version)
    .sort((a, b) => a - b)
}

// =====================================================================
// Test 1: discoverMigrations 路径正则 + 排序
// =====================================================================

await test('discoverMigrations: 错路径/非数字前缀 → throw', () => {
  const mods = {
    './migrations/bad-name.sql': 'SELECT 1', // 非数字前缀
  }
  assert.throws(() => migrate.discoverMigrations(mods), /Bad migration filename/)
})

await test('discoverMigrations: 错扩展名 → throw', () => {
  const mods = {
    './migrations/001-initial.txt': 'SELECT 1',
  }
  assert.throws(() => migrate.discoverMigrations(mods), /Bad migration filename/)
})

await test('discoverMigrations: 多条按 version 升序', () => {
  const mods = {
    './migrations/003-c.sql': 'CREATE TABLE c (id INTEGER)',
    './migrations/001-a.sql': 'CREATE TABLE a (id INTEGER)',
    './migrations/002-b.sql': 'CREATE TABLE b (id INTEGER)',
  }
  const out = migrate.discoverMigrations(mods)
  assert.deepEqual(
    out.map((m) => m.version),
    [1, 2, 3],
  )
  assert.deepEqual(
    out.map((m) => m.name),
    ['a', 'b', 'c'],
  )
})

// =====================================================================
// Test 2: happy path —— 两条 migration 都应用，schema_migrations 写入
// =====================================================================

await test('runMigrations: happy path → 两条 migration 都跑，schema_migrations 写入', async () => {
  const env = makeTestEnv()
  try {
    ;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = env.client
    await migrate.runMigrations({
      modules: {
        './migrations/001-good.sql': 'CREATE TABLE alpha (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
        './migrations/002-good.sql': 'CREATE TABLE beta (id INTEGER PRIMARY KEY)',
      },
    })
    // 两条 schema 都建好
    assert.equal(tableExists(env.db, 'alpha'), true)
    assert.equal(tableExists(env.db, 'beta'), true)
    // schema_migrations 两条都写入了
    assert.deepEqual(appliedVersions(env.db), [1, 2])
  } finally {
    env.cleanup()
  }
})

// =====================================================================
// Test 3: 第二次跑同样 migrations → 全部跳过（INSERT OR IGNORE 幂等）
// =====================================================================

await test('runMigrations: 第二次跑同样 migrations → no-op，schema 不变', async () => {
  const env = makeTestEnv()
  try {
    ;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = env.client
    const modules = {
      './migrations/001-good.sql': 'CREATE TABLE alpha (id INTEGER PRIMARY KEY)',
    }
    await migrate.runMigrations({ modules })
    // 第二次：应当不重跑（pending=[]），最后表还在
    await migrate.runMigrations({ modules })
    assert.equal(tableExists(env.db, 'alpha'), true)
    assert.deepEqual(appliedVersions(env.db), [1])
  } finally {
    env.cleanup()
  }
})

// =====================================================================
// Test 4: 单条 migration 失败 → ROLLBACK + 整次循环终止 + 后续不跑
// =====================================================================

await test('runMigrations: 第二条 SQL 错 → 第一条 schema 保留 + 坏 migration 未写入 schema_migrations + 第三条不跑 + ROLLBACK 兜底', async () => {
  const env = makeTestEnv()
  try {
    ;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = env.client
    let rollbackCalled = false
    const origExec = env.db.exec.bind(env.db)
    env.db.exec = ((sql: string) => {
      if (/^\s*ROLLBACK\b/i.test(sql.trim())) rollbackCalled = true
      return origExec(sql)
    }) as typeof env.db.exec

    const modules = {
      './migrations/001-good.sql': 'CREATE TABLE alpha (id INTEGER PRIMARY KEY)',
      './migrations/002-bad.sql': 'THIS IS NOT VALID SQL',
      './migrations/003-should-not-run.sql':
        'CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY)',
    }

    await assert.rejects(
      migrate.runMigrations({ modules }),
      // better-sqlite3 抛错信息以 "SqliteError" 开头，含 "syntax error"
      /syntax error|SqliteError/i,
    )

    // 关键防线 1: 第一条 schema 保留（migrate.ts 给每条 migration 包独立
    // BEGIN/COMMIT；第一条已 COMMIT 才走第二条；第二条失败回滚的是它自己
    // 的空事务，不会回滚第一条的成果）
    assert.equal(tableExists(env.db, 'alpha'), true, '第一条 migration 的 schema 必须保留')
    // 关键防线 2: 坏 migration 未写入 schema_migrations（INSERT OR IGNORE
    // 在失败事务内也不该落盘）
    assert.deepEqual(appliedVersions(env.db), [1], '只有第一条写入 schema_migrations，坏 migration 不能写入')
    // 关键防线 3: 第三条 migration 没执行（整次循环终止）
    assert.equal(
      tableExists(env.db, 'should_not_exist'),
      false,
      '坏 migration 之后的 migration 不应被执行',
    )
    // 关键防线 4: 触发 ROLLBACK 兜底 exec（worker 可能仍卡在 BEGIN 上）
    assert.equal(rollbackCalled, true, 'migrate 必须在失败后尝试 ROLLBACK')
  } finally {
    env.cleanup()
  }
})

// =====================================================================
// Test 5: foreign_keys 恢复路径 —— 失败后 PRAGMA foreign_keys 仍 ON
// =====================================================================

await test('runMigrations: fk=ON 启动 + 失败路径 → finally 段把 foreign_keys 恢复到 ON', async () => {
  const env = makeTestEnv(true) // fkOn=true
  try {
    ;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = env.client

    const modules = {
      './migrations/001-bad.sql': 'INVALID SQL HERE',
    }

    await assert.rejects(migrate.runMigrations({ modules }), /syntax error|SqliteError/i)
    // 关键防线：finally 段恢复 PRAGMA foreign_keys = ON
    const fk = env.db.pragma('foreign_keys', { simple: true })
    assert.equal(fk, 1, 'foreign_keys must be restored to ON after migration failure')
  } finally {
    env.cleanup()
  }
})

// =====================================================================
// Test 6: foreign_keys 关闭场景 —— 进入时不 OFF，结束时也不 ON
// =====================================================================

await test('runMigrations: fk=OFF 启动 → 不触发 OFF/ON 路径（fkWasOn=false）', async () => {
  const env = makeTestEnv(false) // fkOn=false
  try {
    ;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = env.client

    let fkSetOffSeen = false
    let fkSetOnSeen = false
    const origExec = env.db.exec.bind(env.db)
    env.db.exec = ((sql: string) => {
      const trimmed = sql.trim()
      if (/^PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(trimmed)) fkSetOffSeen = true
      if (/^PRAGMA\s+foreign_keys\s*=\s*ON/i.test(trimmed)) fkSetOnSeen = true
      return origExec(sql)
    }) as typeof env.db.exec

    await migrate.runMigrations({
      modules: {
        './migrations/001-good.sql': 'CREATE TABLE alpha (id INTEGER PRIMARY KEY)',
      },
    })

    // 关键防线：fkWasOn=false 时不调 OFF 也不调 ON
    assert.equal(fkSetOffSeen, false, 'fk=OFF 启动 → 不应触发 PRAGMA foreign_keys=OFF')
    assert.equal(fkSetOnSeen, false, 'fk=OFF 启动 → 不应触发 PRAGMA foreign_keys=ON')
  } finally {
    env.cleanup()
  }
})

// =====================================================================
// Test 7: getCurrentVersion —— happy path 返回最大 version
// =====================================================================

await test('getCurrentVersion: 三条 migration 跑完 → 返回 3', async () => {
  const env = makeTestEnv()
  try {
    ;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = env.client
    await migrate.runMigrations({
      modules: {
        './migrations/001-good.sql': 'CREATE TABLE a (id INTEGER)',
        './migrations/002-good.sql': 'CREATE TABLE b (id INTEGER)',
        './migrations/003-good.sql': 'CREATE TABLE c (id INTEGER)',
      },
    })
    assert.equal(await migrate.getCurrentVersion(), 3)
  } finally {
    env.cleanup()
  }
})

await test('getCurrentVersion: 还没跑 migration → 返回 0', async () => {
  const env = makeTestEnv()
  try {
    ;(globalThis as { __test_dbClient?: ReturnType<typeof makeDbClientFromDb> }).__test_dbClient = env.client
    // getCurrentVersion 自己用 try/catch 兜底，schema_migrations 表不存在
    // 时返回 0。这里依赖 dbClient.call('prepare', ...) 在 better-sqlite3
    // 上对不存在的表报错 → 被 catch 吞掉 → return 0
    assert.equal(await migrate.getCurrentVersion(), 0)
  } finally {
    env.cleanup()
  }
})
