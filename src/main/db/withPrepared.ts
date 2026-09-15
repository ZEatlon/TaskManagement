/**
 * 预编译语句生命周期 helper
 *
 * 背景：dbClient.call('prepare', ...) 会让 sidecar worker 在 better-sqlite3
 * 端 prepare 一条 SQL 并缓存 stmtId。每条 stmt 必须显式 finalize 才会释放
 * —— 否则高频调用场景（番茄完成 / 列表刷新 / AI 统计）会持续在 db-worker
 * 的 prepared-statement 表里堆积，达到 better-sqlite3 上限后 INSERT/SELECT
 * 直接抛 "too many prepared statements" 错。
 *
 * 历史教训：
 *   - R12 修复（pomodoroService）：recordPomodoro / listToday / listRecent
 *     三处都补了 try/finally + finalize，但每个调用点都得自己记得写
 *   - statsBridge.queryRows：同样模式，独立写一份
 *   - 内联 UPDATE（handlePhaseComplete 事务内）：第五处样板
 *
 * 本 helper 把 prepare / run|all|get / finalize 三步封装成单一入口，调用方
 * 只需传 SQL + 执行体（闭包里自己拿 params），leak-risk 收敛到本文件一处审计。
 *
 * 设计要点：
 *   - 不缓存 stmtId：缓存语义属于 Repository 层（按 SQL 文本复用），本 helper
 *     只服务"用一次就丢"的场景（INSERT 单条、SELECT 局部窗口等）。
 *   - finalize 失败吞掉：worker 已经在重启 / stmtId 已失效时 finalize 会 reject，
 *     但调用方本次操作的返回值（成功或失败）才是更重要的信号 —— 不能让
 *     finalize 的次要错误覆盖主结果。
 *   - 抛错时仍然 finalize：原 try/finally 模式的核心保证。
 */
import { dbClient } from './client'

export type PreparedExecutor<R> = (stmtId: number) => Promise<R>

/**
 * 准备一条 SQL → 把 stmtId 交给 executor 执行 → 不论成败都 finalize。
 *
 * 典型用法（executor 闭包内自带 params）：
 *   const rows = await withPrepared(
 *     'SELECT * FROM t WHERE id = ?',
 *     (stmtId) =>
 *       dbClient.call('all', { stmtId, params: [id] }) as Promise<MyRow[]>,
 *   )
 */
export async function withPrepared<R>(
  sql: string,
  executor: PreparedExecutor<R>,
): Promise<R> {
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', { sql })
  ).stmtId
  try {
    return await executor(stmtId)
  } finally {
    await dbClient.call('finalize', { stmtId }).catch(() => undefined)
  }
}
