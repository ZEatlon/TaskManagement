/**
 * 便签提醒派发服务（main process）
 *
 * 职责：
 *   - 每 30 秒扫描一次 sticky_notes 表，找出「due_at <= now 且 archived = 0
 *     且 notified_at IS NULL」的活跃便签
 *   - 命中后弹一条 Electron 系统通知（标题/正文），并通过 IPC 推送给渲染端
 *     store 标记 notified（让 UI 知道「这条已发过提醒」）
 *   - 把 notified_at 写为派发时间，下一轮扫描就不会重复弹同一条
 *   - 用户点击系统通知 → 聚焦主窗口 + 路由到 /today（IPC 推送 sticky-note:due-clicked）
 *
 * 与 src/main/scheduler/taskScheduler.ts 的区别：
 *   - taskScheduler 走 cron 每分钟 + notifications 表 UNIQUE 约束做幂等
 *   - notifier 走 setInterval 30s + sticky_notes.notified_at 列做幂等
 *   - notifier 主要是「用户编辑 due_at 后想立刻派发」的近实时路径；扫描
 *     频率更高（30s vs 60s），命中后立刻 ack，下次扫描就不再匹配。
 *
 * 设计取舍：
 *   - setInterval（不是 setTimeout 链）—— 任务里说明要求的；与 cron 的
 *     区别是不需要 croner 库，且 stop 时只需 clearInterval
 *   - 不与 taskScheduler 互斥（保留两份扫描）—— 旧 cron 处理「跨天重完成」
 *     「RRULE 推进」等更复杂的语义，notifier 只负责「近实时到期派发」
 *   - 失败路径用 log.warn 而不抛错——一次扫描失败不能让整个 interval 挂掉
 */
import { BrowserWindow, Notification } from 'electron'
import { dbClient } from '../db/client'
import { settingsRepo } from '../db/repositories/settings'
import log from '../log'
import { emitToRenderers } from '../ipc/emit'
import { DEFAULT_SETTINGS, IPC_CHANNELS, type AppSettings } from '@shared/ipc/channels'
import { getNotificationMessages } from '@shared/i18n/locales'

/** 扫描间隔：30 秒 */
const SCAN_INTERVAL_MS = 30_000

/** 一次性扫描的 batch 上限，防止一条 sticky 出错阻塞其它行的处理 */
const SCAN_BATCH_LIMIT = 50

interface DueRow {
  id: string
  title: string
  date: string
  due_at: string
  priority: string
}

/** 推送事件到所有渲染窗口（统一走 src/main/ipc/emit.ts，本地不再定义） */

/**
 * 拉取「需要派发提醒」的便签：due_at <= nowIso、archived = 0、notified_at IS NULL。
 * 用 partial index idx_sticky_notes_due_pending —— 索引只覆盖 notified_at IS NULL
 * 的行，已派发的 sticky 不进索引，扫描代价随时间稳定。
 *
 * stmtId 缓存在模块作用域，避免每 30 秒一次 prepare+finalize 走 db-worker
 * IPC（issue：长跑 app 每天 ~1600 次空 prepare/finalize round-trip）。
 * worker respawn 后（见 db-client.R25-DI-5）通过 invalidate 回调清空缓存，
 * 下一次调用重新 prepare。
 */
let fetchStmtId: number | null = null
async function ensureFetchStmt(): Promise<number> {
  if (fetchStmtId !== null) return fetchStmtId
  fetchStmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `SELECT id, title, date, due_at, priority
            FROM sticky_notes
            WHERE due_at IS NOT NULL
              AND due_at <= ?
              AND archived = 0
              AND notified_at IS NULL
            ORDER BY due_at ASC
            LIMIT ?`,
    })
  ).stmtId
  return fetchStmtId
}

async function fetchDueRows(nowIso: string): Promise<DueRow[]> {
  const stmtId = await ensureFetchStmt()
  return (await dbClient.call('all', {
    stmtId,
    params: [nowIso, SCAN_BATCH_LIMIT],
  })) as DueRow[]
}

/**
 * markNotified 的预编译语句 IN(?) 占位符固定为 SCAN_BATCH_LIMIT 个。
 * 实际 ids 不足 SCAN_BATCH_LIMIT 时，剩余占位用 SENTINEL_ID 填充 —— 该
 * id 不存在，永远不会匹配任何行；不污染正常命中行（IN 列表是 OR 语义，
 * 多余值无副作用）。
 *
 * 这样保证 SQL 文本跨调用不变，stmtId 才能模块级缓存复用。
 */
const MARK_SENTINEL_ID = '\x00sentinel-pad\x00' // 不会匹配任何真实 sticky id
let markStmtId: number | null = null
async function ensureMarkStmt(): Promise<number> {
  if (markStmtId !== null) return markStmtId
  const placeholders = new Array(SCAN_BATCH_LIMIT).fill('?').join(',')
  markStmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `UPDATE sticky_notes
            SET notified_at = ?, updated_at = ?
            WHERE id IN (${placeholders})
              AND notified_at IS NULL`,
    })
  ).stmtId
  return markStmtId
}

/**
 * 批量把命中的 sticky 标记为已通知。
 *
 * 用单条 UPDATE + IN(?, ?, ...) 而不是 N 条 update —— 30 秒一次循环里即便只有
 * 一两条也是收益点，10+ 条时收益明显。
 */
async function markNotified(ids: string[], nowIso: string): Promise<void> {
  if (ids.length === 0) return
  if (ids.length > SCAN_BATCH_LIMIT) {
    // 安全兜底：调用方已限制 SCAN_BATCH_LIMIT，这里只是防御性 log。
    log.warn(
      `[sticky-notifier] markNotified got ${ids.length} ids > SCAN_BATCH_LIMIT(${SCAN_BATCH_LIMIT}); truncating`,
    )
    ids = ids.slice(0, SCAN_BATCH_LIMIT)
  }
  const stmtId = await ensureMarkStmt()
  const pad = new Array(SCAN_BATCH_LIMIT - ids.length).fill(MARK_SENTINEL_ID)
  await dbClient.call('run', {
    stmtId,
    params: [nowIso, nowIso, ...ids, ...pad],
  })
}

/**
 * R33 修复 (medium #4)：markNotified 单条版本 + 重试 + per-row 隔离。
 *
 * 原 scanOnce 先派发系统通知、再 markNotified 整批；若 markNotified 整批抛错
 * （db-worker IPC error / write conflict / finalize race），异常被 line 252
 * 的 .catch 静默吞掉，但所有行已经走过 showDueNotification + emitToRenderers，
 * notified_at 全部未写 → 下轮扫描（30s 后）同一批命中 → 用户重复收到同一条
 * 系统通知，直到 DB 恢复或用户打开便签（opened 不重置 notified_at）。
 *
 * 修复方向：保持 UX（先弹通知），但 markNotified 拆成 per-row 并加重试。
 * 任意一行 markNotified 抛错时：log.warn 该行被记为"未通知成功"，不影响
 * 其它行的标记；后续轮次会再扫到未标记的行再试，单条失败不会让整批都漏写。
 *
 * 同时把 markNotified 的整批 SQL 失败也兜底（重试一次），最大化在一次扫描
 * 里把 notified_at 写下去的成功率。
 */
async function markNotifiedWithRetry(ids: string[], nowIso: string, attempt = 1): Promise<void> {
  if (ids.length === 0) return
  try {
    await markNotified(ids, nowIso)
  } catch (err) {
    const msg = (err as Error).message
    if (attempt < 3) {
      log.warn(
        `[sticky-notifier] markNotified batch failed (attempt ${attempt}/${3}): ${msg}; retrying in ${attempt * 250}ms`,
      )
      await new Promise((r) => setTimeout(r, attempt * 250))
      return markNotifiedWithRetry(ids, nowIso, attempt + 1)
    }
    // 已重试 3 次仍失败 —— 整批 SQL 暂时不可用，逐条退化以最大化单行标记成功。
    log.warn(
      `[sticky-notifier] markNotified batch failed after retries: ${msg}; falling back to per-row mark`,
    )
    for (const id of ids) {
      try {
        // 单条版本直接调 prepare/run/finalize（不复用模块级缓存的 IN 占位语句，
        // 因为它需要 SCAN_BATCH_LIMIT 占位 + sentinel pad，单条反而是更简单的
        // 「UPDATE … WHERE id = ? AND notified_at IS NULL」）
        const stmt = await dbClient.call<{ stmtId: number }>('prepare', {
          sql: 'UPDATE sticky_notes SET notified_at = ?, updated_at = ? WHERE id = ? AND notified_at IS NULL',
        })
        try {
          await dbClient.call('run', {
            stmtId: stmt.stmtId,
            params: [nowIso, nowIso, id],
          })
        } finally {
          await dbClient.call('finalize', { stmtId: stmt.stmtId }).catch(() => undefined)
        }
      } catch (perRowErr) {
        // 单行失败也吞掉：该行下次扫描会再派发（重复通知一次），但不影响其它行。
        log.warn(
          `[sticky-notifier] per-row mark failed for ${id}: ${(perRowErr as Error).message}`,
        )
      }
    }
  }
}

/**
 * 释放模块级缓存的 stmt。stopNotifier() 时调用；调用后下一次扫描会自动
 * 重新 prepare。失败吞掉（与 withPrepared 风格一致：主信号是扫描结果，
 * finalize 是次要信号）。
 */
async function finalizeCachedStmts(): Promise<void> {
  if (fetchStmtId !== null) {
    const id = fetchStmtId
    fetchStmtId = null
    await dbClient.call('finalize', { stmtId: id }).catch(() => undefined)
  }
  if (markStmtId !== null) {
    const id = markStmtId
    markStmtId = null
    await dbClient.call('finalize', { stmtId: id }).catch(() => undefined)
  }
}

/**
 * worker respawn 后（db-client.R25-DI-5）旧的 stmtId 全部失效。
 * 注册 invalidate 回调清空模块缓存，下一次调用重新 prepare。
 * 模块顶层一次性注册，无需在 startNotifier() 里重复注册。
 */
dbClient.registerStmtCacheInvalidator(() => {
  fetchStmtId = null
  markStmtId = null
})

/**
 * 弹系统通知 + 监听点击事件。
 * 点击事件：聚焦主窗口 + 推送 sticky-note:due-clicked 事件（渲染端订阅后
 * 决定是否路由到 /today 并展开对应 sticky）。
 *
 * R-fix-i18n-notifier-bypass（high）：title / body 改走 getNotificationMessages()，
 * 与 notify.ts:showStickyDue 共享同一份字典。修复前直接硬编码
 * '便签到期' / '(无标题便签)' —— 即使 settings.language 切到 en-US 也仍是中文，
 * 与 taskScheduler 走 showStickyDue 的英文 toast 并存造成同会话两种 locale
 * 通知的 first-bug 回归。
 *
 * 不走 notify() 是有意的设计取舍：
 *   - notifier 走 setInterval 30s + sticky_notes.notified_at 做幂等，与
 *     notify.ts 的 notifications 表 UNIQUE 是两条独立派发路径；强行合并
 *     会让 showStickyDue 的 bumpPendingDue() / settings 开关语义漏进
 *     notifier 的"硬派发"语义，与本模块的 R33 修复（per-row 隔离 +
 *     重试）有冲突。
 *   - 只替换硬编码字符串，最小侵入。
 */
async function showDueNotification(row: DueRow): Promise<void> {
  if (!Notification.isSupported()) {
    log.warn('[sticky-notifier] Notification API not supported; skip toast')
    return
  }
  // settings 读取失败 / 损坏字段 → getNotificationMessages 内部 toLocaleValue
  // 回退默认 locale，与 notify.ts:resolveNotificationMessages 一致。
  let title = '便签到期'
  let emptyBody = '(无标题便签)'
  try {
    const settings = (await settingsRepo.get<AppSettings>('app.settings')) ?? DEFAULT_SETTINGS
    const messages = getNotificationMessages(settings.language)
    title = messages.stickyDueTitle
    emptyBody = messages.stickyDueBodyEmpty
  } catch {
    /* 字典读取失败兜底使用硬编码字符串（与下方 try/catch 一致） */
  }
  try {
    const n = new Notification({
      title,
      body: row.title || emptyBody,
      urgency: 'critical',
    })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
      emitToRenderers(IPC_CHANNELS.STICKY_NOTE_DUE, {
        id: row.id,
        title: row.title,
        dueAt: row.due_at,
        clicked: true,
      })
      log.info(`[sticky-notifier] notification clicked for ${row.id}`)
    })
    n.show()
  } catch (err) {
    log.warn(`[sticky-notifier] Notification.show failed for ${row.id}:`, (err as Error).message)
  }
}

/** 单轮扫描：拉取 → 派发 → 标记 notified_at。失败时不抛错（interval 仍跑）。 */
async function scanOnce(): Promise<{ hit: number }> {
  const nowIso = new Date().toISOString()
  const rows = await fetchDueRows(nowIso)
  if (rows.length === 0) return { hit: 0 }

  log.info(`[sticky-notifier] hit ${rows.length} due sticky(ies)`)

  // 派发：每条独立的 try/catch，单条失败不让整批 notified_at 漏写
  const succeeded: string[] = []
  for (const row of rows) {
    try {
      // R-fix-i18n-notifier-bypass (high)：showDueNotification 现在 async
      // （内部 await settingsRepo.get<AppSettings> + getNotificationMessages），
      // 必须 await 否则 dispatch failed 捕获不到 settings 读取的 promise reject。
      await showDueNotification(row)
      // 同步推送 IPC，让渲染端 store 立即标记（不必等 notified_at 落库）
      emitToRenderers(IPC_CHANNELS.STICKY_NOTE_DUE, {
        id: row.id,
        title: row.title,
        dueAt: row.due_at,
        clicked: false,
      })
      succeeded.push(row.id)
    } catch (err) {
      log.warn(`[sticky-notifier] dispatch failed for ${row.id}:`, (err as Error).message)
    }
  }

  // 仅对派发成功的行写 notified_at；失败的下轮扫描会再试。
  // R33 修复 (medium #4)：markNotified 走 markNotifiedWithRetry —— 整批失败
  // 时先重试 3 次，仍失败则退化到逐条 UPDATE，避免整批漏写导致 30s 后同
  // 一批 sticky 重复弹通知。
  await markNotifiedWithRetry(succeeded, nowIso)
  return { hit: succeeded.length }
}

let intervalHandle: NodeJS.Timeout | null = null
let scanInFlight: Promise<unknown> | null = null

/**
 * setInterval 回调内容抽出来：上一轮未完则跳过本轮；否则把 scanOnce 包进
 * scanInFlight 让 stopNotifier() 能 await。该函数被 startNotifier 的
 * setInterval 调用，同时也通过 _runIntervalTickForTest 暴露给单测（用于
 * 构造 scanInFlight 非空状态以验证 R28 race fix）。
 */
function runIntervalTick(): void {
  // 上一轮扫描未完则跳过本轮（不报错，避免 setInterval 退订）
  if (scanInFlight) {
    log.debug('[sticky-notifier] previous scan in-flight, skip tick')
    return
  }
  scanInFlight = scanOnce()
    .then((res) => {
      if (res.hit > 0) log.info(`[sticky-notifier] dispatched ${res.hit} notification(s)`)
    })
    .catch((err) => {
      log.warn('[sticky-notifier] scan error:', err)
    })
    .finally(() => {
      scanInFlight = null
    })
}

/**
 * 启动 setInterval 30s 循环。startTaskpilotServices / index.ts 在 app ready
 * 之后、数据库初始化完成后调用。失败时 throw —— 由 caller 决定是否降级。
 */
export function startNotifier(): void {
  if (intervalHandle) {
    log.warn('[sticky-notifier] already running')
    return
  }
  log.info(`[sticky-notifier] starting (interval=${SCAN_INTERVAL_MS}ms)`)
  // 启动后立刻跑一次，避免启动延迟。走 runIntervalTick() 而非直接
  // void scanOnce() —— 这样首轮扫描也会被写到模块级 scanInFlight，
  // 与 R28 race fix 的串行等待契约一致（stopNotifier 必须 await
  // scanInFlight 后再 finalizeCachedStmts，否则 in-flight scan 的
  // markNotified 会撞上已 finalize 的 stmtId，触发
  // "no such prepared statement" → 系统通知已弹 / notified_at 未落库
  // / 下次启动重复收到同一条提醒）。
  runIntervalTick()
  intervalHandle = setInterval(() => runIntervalTick(), SCAN_INTERVAL_MS)
}

/** 停止循环 + 等待 in-flight scanOnce 落地 + 释放模块缓存的 stmt。
 *  app before-quit 时调用。
 *
 *  R28 修复 (medium)：原版仅 clearInterval 后 `void finalizeCachedStmts()`，
 *  不等待正在执行的 scanOnce。scanOnce 在 `await fetchDueRows()` 拿到 fetchStmtId
 *  后进入 `markNotified()`，而 finalize 立即把 fetchStmtId/markStmtId 置 null
 *  并 await worker `finalize` —— 两条路径在 worker 端赛跑，若 finalize 先到
 *  worker，下一句 `dbClient.call('run', {stmtId, ...})` 命中已销毁 stmt，报
 *  "no such prepared statement"。setInterval 的 .catch 静默吞错，导致：
 *  1) 系统通知已弹出（showDueNotification 早于 markNotified）；
 *  2) notified_at 没落库；
 *  3) 下次启动这些 sticky 又被扫到 → 用户重复收到同一条提醒。
 *
 *  修复：await scanInFlight 后再 finalizeCachedStmts（串行）。caller
 *  （src/main/index.ts before-quit）需要 await stopNotifier()。 */
export async function stopNotifier(): Promise<void> {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    log.info('[sticky-notifier] stopped')
  }
  // 等正在跑的 scanOnce 落地再 finalize，否则 markNotified 的 dbClient.call
  // 命中已 finalize 的 stmtId 会失败。
  if (scanInFlight) {
    await scanInFlight.catch(() => undefined)
    scanInFlight = null
  }
  await finalizeCachedStmts()
}

/** 测试用：手动触发一次扫描（notifier 内部的测试入口） */
export async function runOnce(): Promise<{ hit: number }> {
  return scanOnce()
}

/** 测试用：手动触发一次 setInterval 回调（绕过 30_000ms 真实等候）。
 *  生产代码不应调用 —— 仅给 scripts/test-notifier.mts 用以构造
 *  scanInFlight 非空状态，验证 R28 race fix（stopNotifier 必须先 await
 *  scanInFlight 再 finalizeCachedStmts，否则 in-flight scan 的 markNotified
 *  会撞上已销毁的 stmtId）。 */
export function _runIntervalTickForTest(): void {
  runIntervalTick()
}