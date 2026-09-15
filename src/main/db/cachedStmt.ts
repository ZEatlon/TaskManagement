/**
 * 预编译语句缓存（模块级共享）
 *
 * 历史：6+ 个仓库各自手抄一份「per-module Map<sql, stmtId> + `let
 * invalidatorRegistered` 守卫 + `dbClient.registerStmtCacheInvalidator(clear)`
 * 注册 + 命中 lookup」样板（statsBridge / Repository 基类 / pomodoros /
 * completions / settings / conversations / notes）。每次新增仓库或调整
 * dbClient.invalidate payload 都要同步改 N 处；新人写新 repo 很容易漏注册
 * invalidator，让 stale stmtId 在 worker respawn 后继续生效（详见
 * db-client.R25-DI-5）。
 *
 * 本模块把样板收敛到一处：
 *   - module-scope cache：所有 import `prepareCached` / `withCached` 的
 *     调用方共享同一个 Map<sql, stmtId>。同一 SQL 文本在不同仓库调用也
 *     共享同一 stmtId（worker 端 better-sqlite3 也会复用同一 prepared
 *     statement，与 R28 评审期望一致）。
 *   - 一次性 invalidator：模块顶层 lazy 注册一次（首次调用 prepareCached
 *     时触发），不再每个仓库各自 `if (!registered)` 守卫。
 *   - API 兼容：prepareCached(sql) → stmtId 直接拿；withCached(sql, run)
 *     是 withPrepared 风格的 executor 包装（自动 run(stmtId)）。
 *
 * 设计动机：保留「per-SQL 缓存 + 失效广播」语义不变，只是把样板移到
 * 一个文件审计。新仓库只需 `import { prepareCached }` 即可，省 12 行
 * 重复代码 + 1 处「漏注册」风险。
 */
import { dbClient } from './client'

export type CachedExecutor<R> = (stmtId: number) => Promise<R>

/** 模块级共享 cache：SQL 文本 → stmtId。worker respawn 时被清空。 */
const stmtCache = new Map<string, number>()

/** 一次性 invalidator 注册守卫。模块顶层 lazy init。 */
let invalidatorRegistered = false

function ensureInvalidatorRegistered(): void {
  if (invalidatorRegistered) return
  // 必须在第一次 prepare 之前同步注册（与 Repository 基类构造时同步
  // 注册的契约一致：否则 worker 首次 start() 广播 invalidate 时还没
  // 注册，缓存里残留的 stale stmtId 漏网）。
  dbClient.registerStmtCacheInvalidator(() => {
    stmtCache.clear()
  })
  invalidatorRegistered = true
}

/**
 * 准备一条 SQL 并缓存其 stmtId。
 *
 * 缓存命中直接返回（零 IPC）；未命中发一次 `prepare` IPC，存进缓存后
 * 返回 stmtId。worker respawn 后 dbClient 自动广播 invalidate 清缓存，
 * 下一次 cache miss 重新走 IPC 拿新 stmtId。
 *
 * 调用方拿到 stmtId 后用 `dbClient.call('run' | 'all' | 'get', { stmtId, params })`
 * 执行，**不要**显式 finalize（stmtId 是共享的，提前 finalize 会破坏其它
 * 调用方的命中）。
 */
export async function prepareCached(sql: string): Promise<number> {
  ensureInvalidatorRegistered()
  const cached = stmtCache.get(sql)
  if (cached !== undefined) return cached
  const res = await dbClient.call<{ stmtId: number }>('prepare', { sql })
  if (!res) throw new Error('Failed to prepare statement')
  stmtCache.set(sql, res.stmtId)
  return res.stmtId
}

/**
 * withPrepared 风格的 executor 包装：自动 prepareCached + 交给 executor
 * 执行 + 返回结果。executor 内部负责 params / row mapping。
 *
 * 命名沿用现有仓库的 `withPrepared`，但语义与 db/withPrepared.ts 那个
 * 「用一次就丢」+ finalize 的 helper 不同 —— 本 helper **复用** cache，
 * 不 finalize。需要「用一次就丢」语义请继续 import db/withPrepared。
 */
export async function withCached<R>(
  sql: string,
  run: CachedExecutor<R>,
): Promise<R> {
  const stmtId = await prepareCached(sql)
  return run(stmtId)
}
