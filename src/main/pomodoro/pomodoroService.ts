/**
 * 番茄钟服务层（主进程）
 *
 * 串联：
 *   - TimerEngine（计时 + 状态机）
 *   - pomodoros 表 / sticky_notes 表（DB 持久化；统一任务实体）
 *   - 通知模块（系统通知 + IPC 事件推送）
 *   - settings 表（保存/读取 PomodoroConfig）
 *
 * 暴露给 IPC handler 的 API：
 *   - getState()
 *   - getConfig()
 *   - updateConfig(patch)
 *   - start(stickyNoteId?)
 *   - pause()
 *   - resume()
 *   - stop()
 *   - skip()
 *   - reset()
 *   - listToday()
 *   - listRecent(limit)
 */
import { dbClient } from '../db/client'
import { stickyNotesRepo } from '../db/repositories/stickyNotes'
import { settingsRepo } from '../db/repositories/settings'
import { timerEngine } from './timerEngine'
import {
  notifyFocusComplete,
  notifyBreakComplete,
  notifyAutoStart,
  emitTick,
  emitStateChanged,
  emitStopped,
} from './notifications'
import log from '../log'
import {
  DEFAULT_POMODORO_CONFIG,
  type PomodoroConfig,
  type PomodoroMode,
  type PomodoroRecord,
  type PomodoroState,
} from '@shared/ipc/channels'

const CONFIG_KEY = 'pomodoro.config'

/** 在内存中缓存 stickyNoteId -> stickyTitle（避免每次都查 DB）
 *
 * R11 修复 (high #11)：原版 cacheStickyTitleAsync 只在 findById 之后写入缓存，
 * 但没有任何路径让缓存失效 —— 用户重命名便签后，pomodoro 完成通知仍把
 * 缓存里的旧 title 写到系统通知 / IPC payload，看起来通知说的是"已修改的便签"，
 * 但关联的 task 名字是旧的。现在 export 一个 invalidateStickyTitle(noteId)，
 * 让便签 update handler 调一下，强制下次 cache miss 重新查 DB。
 */
const stickyTitleCache = new Map<string, string>()

/** 让缓存的 sticky 标题失效（外部在 update/delete 时调用） */
export function invalidateStickyTitle(stickyNoteId: string): void {
  stickyTitleCache.delete(stickyNoteId)
}

/** 启动 service：把 engine 回调绑到 service/通知 上 */
export function startPomodoroService(): void {
  timerEngine.onTick = (state) => emitTick(state)
  timerEngine.onStateChanged = (state) => emitStateChanged(state)
  timerEngine.onStopped = (state) => emitStopped(state)
  timerEngine.onPhaseComplete = (finished, next, prevMode) => {
    void handlePhaseComplete(finished, next, prevMode)
  }
  // 异步加载配置（不阻塞启动）
  void loadConfigIntoEngine()
  log.info('[pomodoro] service started')
}

/** 关闭时清理（保留 engine 实例，但停止计时器） */
export function stopPomodoroService(): void {
  timerEngine.stop()
  stickyTitleCache.clear()
  log.info('[pomodoro] service stopped')
}

// ===== 配置 =====

async function loadConfigIntoEngine(): Promise<void> {
  try {
    const cfg = await loadConfig()
    timerEngine.setConfig(cfg)
  } catch (err) {
    log.warn('[pomodoro] load config failed', err)
  }
}

export async function loadConfig(): Promise<PomodoroConfig> {
  const stored = await settingsRepo.get<PomodoroConfig>(CONFIG_KEY)
  return { ...DEFAULT_POMODORO_CONFIG, ...(stored ?? {}) }
}

export async function saveConfig(patch: Partial<PomodoroConfig>): Promise<PomodoroConfig> {
  const cur = await loadConfig()
  const next: PomodoroConfig = { ...cur, ...patch }
  await settingsRepo.set(CONFIG_KEY, next)
  timerEngine.setConfig(next)
  log.info('[pomodoro] config updated', next)
  return next
}

// ===== 控制 =====

export function getState(): PomodoroState {
  return { ...timerEngine.state }
}

export function start(stickyNoteId: string | null = null): PomodoroState {
  if (stickyNoteId) cacheStickyTitleAsync(stickyNoteId)
  timerEngine.start(stickyNoteId)
  return getState()
}

export function pause(): PomodoroState {
  timerEngine.pause()
  return getState()
}

export function resume(): PomodoroState {
  timerEngine.resume()
  return getState()
}

export function stop(): PomodoroState {
  timerEngine.stop()
  return getState()
}

export function skip(): PomodoroState {
  timerEngine.skip()
  return getState()
}

export function reset(): PomodoroState {
  timerEngine.reset()
  return getState()
}

// ===== DB 记录 =====

interface PomodoroRow {
  id: string
  sticky_note_id: string | null
  started_at: string
  ended_at: string | null
  duration_min: number | null
  completed: number
  created_at: string | null
}

/** 写入一条 pomodoros 记录 */
export async function recordPomodoro(args: {
  stickyNoteId: string | null
  startedAt: string
  endedAt: string
  durationMin: number
  completed: boolean
}): Promise<PomodoroRecord> {
  const id = crypto.randomUUID()
  // R26-DI-2 修复 (high migration)：migration 006 把 pomodoros.created_at 改为
  // NOT NULL（无 DEFAULT），但 recordPomodoro() 历史上不写 created_at → 一旦
  // DB 升级到 006 之后每次 recordPomodoro 抛 NOT NULL constraint failed。
  // 同步 INSERT 子句 + params（用 endedAt 作 created_at，单调时间戳近似）。
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `INSERT INTO pomodoros (id, sticky_note_id, started_at, ended_at, duration_min, completed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
    })
  ).stmtId
  // R12 修复 (high)：原版只 await run，没有 try/finally 调 finalize。
  // 每完成一个番茄钟泄漏一条预编译语句到 db-worker，长期高频运行后
  // SQLite prepared statement 缓存满 → INSERT 失败。补 try/finally。
  try {
    await dbClient.call('run', {
      stmtId,
      params: [
        id,
        args.stickyNoteId,
        args.startedAt,
        args.endedAt,
        args.durationMin,
        args.completed ? 1 : 0,
        args.endedAt, // created_at ≈ 写入时刻（endedAt 在调用方已是 ISO 字符串）
      ],
    })
  } finally {
    await dbClient.call('finalize', { stmtId }).catch(() => undefined)
  }
  return {
    id,
    stickyNoteId: args.stickyNoteId,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    durationMin: args.durationMin,
    completed: args.completed ? 1 : 0,
  }
}

/** 查询今日完成的 focus 记录 */
export async function listToday(): Promise<PomodoroRecord[]> {
  // R11 修复 (medium #29)：原版 listToday 仅按 UTC 字符串 >= / < 比较，但「今日」
  // 是用户的本地日历日。UTC+8 用户在本地 23:55 开始的番茄在 SQL 看来是次日，
  // → listToday 漏掉跨午夜的番茄。已用「本地 00:00 起的 24 小时」窗口化，
  // start/end 都基于本地午夜的 Date 转 ISO（Date 对象本身无时区，toISOString
  // 自动转 UTC），所以 SQL 仍能正确比 UTC 列；同时修正 prepared statement 泄露。
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `SELECT id, sticky_note_id, started_at, ended_at, duration_min, completed
            FROM pomodoros
            WHERE started_at >= ? AND started_at < ?
            AND completed = 1
            ORDER BY started_at DESC`,
    })
  ).stmtId
  try {
    const rows = (await dbClient.call('all', {
      stmtId,
      params: [start.toISOString(), end.toISOString()],
    })) as PomodoroRow[]
    return rows.map(rowToRecord)
  } finally {
    await dbClient.call('finalize', { stmtId }).catch(() => undefined)
  }
}

/** 查询最近 N 条 focus 记录 */
export async function listRecent(limit = 50): Promise<PomodoroRecord[]> {
  // R11 修复 (medium #26)：补 try/finally + finalize，避免每分钟刷新列表泄漏
  // 一个 prepared statement。
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `SELECT id, sticky_note_id, started_at, ended_at, duration_min, completed
            FROM pomodoros
            WHERE completed = 1
            ORDER BY started_at DESC
            LIMIT ?`,
    })
  ).stmtId
  try {
    const rows = (await dbClient.call('all', {
      stmtId,
      params: [limit],
    })) as PomodoroRow[]
    return rows.map(rowToRecord)
  } finally {
    await dbClient.call('finalize', { stmtId }).catch(() => undefined)
  }
}

// ===== 内部 =====

function rowToRecord(r: PomodoroRow): PomodoroRecord {
  return {
    id: r.id,
    stickyNoteId: r.sticky_note_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMin: r.duration_min,
    completed: r.completed,
  }
}

/** 异步缓存 sticky 标题 */
function cacheStickyTitleAsync(stickyNoteId: string): void {
  if (stickyTitleCache.has(stickyNoteId)) return
  void stickyNotesRepo
    .findById(stickyNoteId)
    .then((s) => {
      if (s) stickyTitleCache.set(stickyNoteId, s.title)
    })
    .catch(() => {})
}

function getCachedStickyTitle(stickyNoteId: string | null): string | null {
  if (!stickyNoteId) return null
  return stickyTitleCache.get(stickyNoteId) ?? null
}

/** 阶段完成后的副作用 */
async function handlePhaseComplete(
  finished: {
    mode: PomodoroMode
    startedAt: string | null
    stickyNoteId: string | null
    totalSec: number
    elapsedSec: number
  },
  nextState: PomodoroState,
  prevMode: PomodoroMode,
): Promise<void> {
  const now = new Date().toISOString()
  const startedAt = finished.startedAt ?? now
  // 真实专注时长：按 elapsedSeconds 折算（避免 skip 时把整阶段算作完成）
  const durationMin = Math.max(1, Math.round(finished.elapsedSec / 60))
  // 完成判定：自然到期 = elapsedSec 接近 totalSec（≥90%）；skip 时通常远小于此
  const completed =
    finished.totalSec > 0 && finished.elapsedSec / finished.totalSec >= 0.9
  const stickyNoteIdForRecord = finished.stickyNoteId

  try {
    if (prevMode === 'focus') {
      // R21 修复 (high data integrity)：原版先 INSERT pomodoros 再 UPDATE
      // sticky_notes.pomodoro_count，两个语句独立提交 —— 若 INSERT 成功后
      // UPDATE 失败（FK orphan / DB lock / IPC 断连），pomodoros 表里就多了一
      // 条没有对应 +1 计数的历史记录，sticky 卡片显示「历史完成 5 次」但
      // sticky_notes.pomodoro_count 还是旧值。修复：把两条写包进 BEGIN/COMMIT
      // 同一事务，任一失败整体 ROLLBACK，pomodoros 与 pomodoro_count 始终一致。
      //
      // R23-DI-2 修复 (high data integrity)：BEGIN/COMMIT 跨多次 IPC 让出
      // 事件循环后，并发番茄完成（用户在专注 → 自动进休息 → 同时启动新一轮
      // 专注）会交错发 BEGIN，触发 "cannot start a transaction within a
      // transaction"。用 dbClient.runInTransaction 串行化，事务不重叠。
      await dbClient.runInTransaction(async () => {
        await dbClient.call('exec', { sql: 'BEGIN' })
        try {
          // 1. 写 pomodoros 表
          await recordPomodoro({
            stickyNoteId: stickyNoteIdForRecord,
            startedAt,
            endedAt: now,
            durationMin,
            completed,
          })
          // 2. R7P-6 修复：完整完成时用单条原子 SQL 让 sticky.pomodoro_count +1，
          //    避免原实现的"read → +1 → write"竞态（中间 sticky 被并发删 / 改）。
          //    若 sticky 已被删除，changes=0 自然跳过，不抛错。
          if (completed && stickyNoteIdForRecord) {
            const stmtId = (
              await dbClient.call<{ stmtId: number }>('prepare', {
                sql: `UPDATE sticky_notes
                      SET pomodoro_count = pomodoro_count + 1, updated_at = ?
                      WHERE id = ?`,
              })
            ).stmtId
            // R12 修复 (high)：UPDATE 预编译语句同样未 finalize，每次番茄完成泄漏。
            // 补 try/finally 与 recordPomodoro 模式一致。
            try {
              await dbClient.call('run', {
                stmtId,
                params: [now, stickyNoteIdForRecord],
              })
            } finally {
              await dbClient.call('finalize', { stmtId }).catch(() => undefined)
            }
          }
          await dbClient.call('exec', { sql: 'COMMIT' })
        } catch (txErr) {
          try {
            await dbClient.call('exec', { sql: 'ROLLBACK' })
          } catch {
            /* rollback 自身失败吞掉 —— 原始错误更重要 */
          }
          throw txErr
        }
      })
      // 3. 通知（系统 + IPC 推送）
      // R11 修复 (high #10)：原来用 finished.totalSec（配置的整段时间）算出
      // durationMin → 用户 30 秒就 skip，系统通知仍报"25 分钟"。现在按真实
      // 专注时长 elapsedSec 计算，skip 时只算实际经过的分钟数（最少 1 分钟以
      // 保证通知里有非零值）。
      const focusCompletedMin = completed
        ? Math.round(finished.totalSec / 60)
        : Math.max(1, Math.round(finished.elapsedSec / 60))
      await notifyFocusComplete(
        nextState,
        getCachedStickyTitle(stickyNoteIdForRecord),
        focusCompletedMin,
        // R5-1：把当前配置传给通知函数，让休息时长跟用户设置一致
        {
          shortBreakMin: timerEngine.config.shortBreakMin,
          longBreakMin: timerEngine.config.longBreakMin,
          cycleCount: timerEngine.config.cycleCount,
        },
        // R11 修复 (medium #38)：nextState.stickyNoteId 已被 advancePhase 清空，
        // 显式把刚完成 focus 的便签 id 传过去，让 IPC payload 能告诉渲染端
        // "刚专注的便签是哪一个"。
        stickyNoteIdForRecord,
      )
    } else {
      // R7P-5 修复：传入 prevMode（shortBreak/longBreak），避免通知 payload 把
      // 已完成的 break 误标为 focus；stickyNoteId 也清空，因为 timerEngine
      // 的 advancePhase 已经把 stickyNoteId 置 null。
      await notifyBreakComplete(
        nextState,
        Math.round(finished.totalSec / 60),
        prevMode as 'shortBreak' | 'longBreak',
      )
    }
    // 4. 如果自动开始下一阶段（且是 break 开始时，给个静默提醒）
    if (nextState.running && nextState.mode !== 'focus') {
      await notifyAutoStart(nextState)
    }
  } catch (err) {
    log.error('[pomodoro] handlePhaseComplete error', err)
  }
}