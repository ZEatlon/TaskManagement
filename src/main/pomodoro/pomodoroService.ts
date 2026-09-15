/**
 * 番茄钟服务层（主进程）
 *
 * 串联：
 *   - TimerEngine（计时 + 状态机）
 *   - pomodoros 表 / sticky_notes 表（DB 持久化；统一任务实体）
 *   - 通知模块（系统通知 + IPC 事件推送）
 *   - settings 表（保存/读取 PomodoroConfig）
 *
 * 暴露给 IPC handler 的 API（多数由 ipc/pomodoro-handlers 转发）：
 *   - getState()                            读取当前计时器状态
 *   - loadConfig()                          从 settings 表读 PomodoroConfig
 *                                            （注意：早期文档误写为 getConfig，
 *                                            实际函数名是 loadConfig）
 *   - saveConfig(patch)                     合并并持久化 PomodoroConfig
 *                                            （注意：早期文档误写为
 *                                            updateConfig，实际是 saveConfig；
 *                                            patch 由 validatePomodoroConfigPatch
 *                                            兜底校验，未通过的字段会抛错）
 *   - start(stickyNoteId?)                  启动一个番茄阶段
 *   - pause() / resume()                    暂停 / 继续
 *   - stop() / skip()                       终止当前阶段 / 跳到下一阶段
 *                                            （注：原本暴露的 reset() 与 stop()
 *                                            同义，已删除以消除与 timerEngine
 *                                            reset/stop 别名重复；IPC handler
 *                                            仍保留 pomodoro:reset 通道作
 *                                            向后兼容，内部直接调 stop()）
 *   - listToday()                           查询今日完成的 focus 记录
 *                                            （按本地日历日窗口）
 *   - listRecent(limit)                     查询最近 N 条完成记录
 *
 * 其他 module-level export（不在 IPC handler 直接转发，但被其它模块调用）：
 *   - validatePomodoroConfigPatch(patch)    patch 净化 + 强校验入口 —— IPC
 *                                            pomodoro-handlers 在调用
 *                                            saveConfig 前先跑一次，保证
 *                                            focusMin/cycleCount/whiteNoise
 *                                            等字段边界合法（不合法抛 Error）
 *   - invalidateStickyTitle(stickyNoteId)   清掉 stickyTitleCache 里某个
 *                                            便签的 title 缓存 —— 由
 *                                            sticky-note-handlers 在 UPDATE
 *                                            / DELETE / archive 路径调用，
 *                                            避免重命名后 pomodoro 完成通知
 *                                            仍引用旧 title
 *
 * module-private（不 export，不在任何 IPC handler / 外部模块直接可达）：
 *   - recordPomodoro(args)                  写一条 pomodoros 表的 focus
 *                                            完成记录（INSERT，含 created_at
 *                                            同步）。**仅供本文件
 *                                            handlePhaseComplete 在事务边界
 *                                            内调用；IPC handler 不应直接
 *                                            走这个**。删 export 是有意为之：
 *                                            外部路径会绕过 BEGIN/COMMIT
 *                                            边界 / generation 守卫 /
 *                                            sticky.complete 联动。
 */
import { dbClient } from '../db/client'
import { withPrepared } from '../db/withPrepared'
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
  emitFocusMode,
  emitPomodoroPersistFailed,
} from './notifications'
import log from '../log'
import { startOfDayLocal } from '@shared/lib/dayKey'
import {
  DEFAULT_POMODORO_CONFIG,
  type PomodoroConfig,
  type PomodoroMode,
  type PomodoroRecord,
  type PomodoroState,
  type PomodoroWhiteNoise,
} from '@shared/ipc/channels'

const CONFIG_KEY = 'pomodoro.config'

/** R-fix-pomodoro-config-validate (HIGH input-validation)：IPC handler 与
 *  pomodoroBridge 都直接 saveConfig({ ...patch })，未对 9 个字段做边界
 *  / 类型校验 —— 渲染端 XSS 或恶意插件可以写 focusMin=-1 让
 *  totalSecOf 返回负数 → tick/advancePhase 跑在 NaN 上，或写
 *  cycleCount=MAX_SAFE_INTEGER 让 (completed % cycleCount) === 0 永远
 *  为 false → 用户再也到不了 long break。
 *
 *  集中校验 helper 走 strict number / boolean / enum，避免每个调用点
 *  各自 clamp 漂移。返回净化后的 partial（只含合法字段），让 saveConfig
 *  后续 merge 行为与原版一致（未出现的字段保持旧值）。
 */
const VALID_WHITE_NOISE: ReadonlySet<PomodoroWhiteNoise> = new Set([
  'none',
  'brown',
  'pink',
  'rain',
  'ocean',
  'forest',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function isInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Math.trunc(n) === n
}

export function validatePomodoroConfigPatch(
  patch: unknown,
): Partial<PomodoroConfig> {
  if (!isPlainObject(patch)) {
    throw new Error('pomodoro config patch must be a plain object')
  }
  const out: Partial<PomodoroConfig> = {}

  // focusMin / shortBreakMin / longBreakMin: integer in [1, 180]
  for (const [key, min, max] of [
    ['focusMin', 1, 180],
    ['shortBreakMin', 1, 180],
    ['longBreakMin', 1, 180],
  ] as const) {
    const raw = patch[key]
    if (raw === undefined) continue
    if (!isInteger(raw) || raw < min || raw > max) {
      throw new Error(
        `pomodoro config.${key} must be integer in [${min}, ${max}], got ${JSON.stringify(raw)}`,
      )
    }
    (out as Record<string, unknown>)[key] = raw
  }

  // dailyGoal: integer in [1, 20]（与 channels.ts:459 文档范围一致）
  if (patch['dailyGoal'] !== undefined) {
    const raw = patch['dailyGoal']
    if (!isInteger(raw) || raw < 1 || raw > 20) {
      throw new Error(
        `pomodoro config.dailyGoal must be integer in [1, 20], got ${JSON.stringify(raw)}`,
      )
    }
    out.dailyGoal = raw
  }

  // cycleCount: integer in [1, 12] —— 防止超大数让 completed % cycleCount 永远 != 0
  if (patch['cycleCount'] !== undefined) {
    const raw = patch['cycleCount']
    if (!isInteger(raw) || raw < 1 || raw > 12) {
      throw new Error(
        `pomodoro config.cycleCount must be integer in [1, 12], got ${JSON.stringify(raw)}`,
      )
    }
    out.cycleCount = raw
  }

  // autoStartNext / soundEnabled / autoEnterFocusMode: 严格 boolean
  for (const key of ['autoStartNext', 'soundEnabled', 'autoEnterFocusMode'] as const) {
    const raw = patch[key]
    if (raw === undefined) continue
    if (typeof raw !== 'boolean') {
      throw new Error(
        `pomodoro config.${key} must be boolean, got ${typeof raw} (${JSON.stringify(raw)})`,
      )
    }
    out[key] = raw
  }

  // whiteNoise: 白名单 enum
  if (patch['whiteNoise'] !== undefined) {
    const raw = patch['whiteNoise']
    if (typeof raw !== 'string' || !VALID_WHITE_NOISE.has(raw as PomodoroWhiteNoise)) {
      throw new Error(
        `pomodoro config.whiteNoise must be one of ${[...VALID_WHITE_NOISE].join('|')}, got ${JSON.stringify(raw)}`,
      )
    }
    out.whiteNoise = raw as PomodoroWhiteNoise
  }

  return out
}

/**
 * H9 修复 (high correctness)：原版 handlePhaseComplete 是 fire-and-forget
 * —— startPomodoroService 内 `void handlePhaseComplete(...)` 启动异步链
 * 但没有 generation token。如果用户在 phase 完成 → DB 写完 → IPC 推送前
 * 调 stopPomodoroService() / 重启服务，新一轮 phase 也会调
 * handlePhaseComplete，老一轮的 await 仍然继续把「已停止服务」的 phase
 * 落 DB + 给用户发通知 → 用户看到的记录 / 通知对应一个他们认为已经
 * 取消的服务。
 *
 * 维护 generation 计数器；startPomodoroService 时自增；handlePhaseComplete
 * 入口捕获快照，每个 await 之后校验是否仍为当前 generation —— 不一致
 * 直接 return，所有副作用都被截断。
 */
let pomodoroGeneration = 0

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
  // H9 修复：每次 start 自增 generation，让任何在 stop/start 间隙起跑的
  // handlePhaseComplete 在下一个 await 校验处直接 return。
  pomodoroGeneration += 1
  timerEngine.onTick = (state) => emitTick(state)
  timerEngine.onStateChanged = (state) => emitStateChanged(state)
  timerEngine.onStopped = (state) => emitStopped(state)
  timerEngine.onPhaseComplete = (finished, next, prevMode) => {
    const gen = pomodoroGeneration
    void handlePhaseComplete(finished, next, prevMode, gen)
  }
  // 异步加载配置（不阻塞启动 —— 入口在 start()/handlePhaseComplete 等处
  // 显式 await ensureConfigLoaded() 兜底，保证首启第一次 start 拿到持久值）
  void ensureConfigLoaded()
  log.info('[pomodoro] service started')
}

/** 关闭时清理（保留 engine 实例，但停止计时器） */
export function stopPomodoroService(): void {
  // H9 修复：让任何在 stop 时仍在飞行的 handlePhaseComplete 在下一个
  // await 校验处停止写 DB / 推 IPC。
  pomodoroGeneration += 1
  timerEngine.stop()
  stickyTitleCache.clear()
  // 通知渲染端关白噪音（lazy import，避免启动链依赖音频模块）
  void import('./audio').then((m) => {
    m.setWhiteNoise('none')
    m.disposeAudio()
  }).catch(() => undefined)
  // 退出专注模式
  emitFocusMode(false, 'stop')
  log.info('[pomodoro] service stopped')
}

// ===== 配置 =====

/** R-fix-pomodoro-config-start-race (medium correctness)：startPomodoroService()
 *  内部 fire-and-forget 调 ensureConfigLoaded()，但 pomodoroService.start()
 *  立刻读 timerEngine.config 来决定白噪音 / 专注模式。冷启动后用户在 < 50ms
 *  内点 Start（很可能 —— PomodoroPanel 在 Dashboard 渲染早于 load 完成），
 *  timerEngine.config 还是 DEFAULT —— 用户听到静音、通知文案是 5 分钟短休。
 *
 *  修法：把首次 loadConfig 的 promise 缓存到 configLoadPromise，所有需要
 *  config 的入口（start / handlePhaseComplete）await 它，附 200ms 兜底超时
 *  避免 DB 卡死时整个 start 卡住；超时则用当前 engine config（已经是 DEFAULT）
 *  并 log warn。后续 saveConfig() 已经同步更新 timerEngine.config 与持久值，
 *  无需重跑 load。
 */
let configLoadPromise: Promise<PomodoroConfig> | null = null

/** 等待首次 boot 配置加载；超时返回当前 engine config（兜底） */
async function ensureConfigLoaded(timeoutMs = 200): Promise<PomodoroConfig> {
  if (!configLoadPromise) {
    configLoadPromise = loadConfig()
      .then((cfg) => {
        timerEngine.setConfig(cfg)
        return cfg
      })
      .catch((err) => {
        log.warn('[pomodoro] load config failed', err)
        // 重置 promise 让下次重试 —— 不抛出去卡死调用方
        configLoadPromise = null
        return timerEngine.config
      })
  }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      configLoadPromise,
      new Promise<PomodoroConfig>((resolve) => {
        timer = setTimeout(() => {
          log.warn(
            `[pomodoro] config load timeout (${timeoutMs}ms), using current engine config`,
          )
          resolve(timerEngine.config)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function loadConfig(): Promise<PomodoroConfig> {
  const stored = await settingsRepo.get<PomodoroConfig>(CONFIG_KEY)
  return { ...DEFAULT_POMODORO_CONFIG, ...(stored ?? {}) }
}

export async function saveConfig(patch: Partial<PomodoroConfig>): Promise<PomodoroConfig> {
  const cur = await loadConfig()
  // R-fix-pomodoro-config-validate：在 merge 前先校验 patch —— 即使 IPC
  // handler 漏校验，service 层兜底，避免 focusMin=-1 / cycleCount=MAX_SAFE_INTEGER
  // 等垃圾值污染持久化配置。
  const safePatch = validatePomodoroConfigPatch(patch)
  const next: PomodoroConfig = { ...cur, ...safePatch }
  await settingsRepo.set(CONFIG_KEY, next)
  timerEngine.setConfig(next)
  log.info('[pomodoro] config updated', next)
  return next
}

// ===== 控制 =====

export function getState(): PomodoroState {
  return { ...timerEngine.state }
}

export async function start(stickyNoteId: string | null = null): Promise<PomodoroState> {
  if (stickyNoteId) cacheStickyTitleAsync(stickyNoteId)
  // R-fix-pomodoro-config-start-race：先 await ensureConfigLoaded()，保证
  // 后续读到的 timerEngine.config 是持久化值（不是冷启动期的 DEFAULT）。
  // ensureConfigLoaded 内部有 200ms 兜底超时，DB 卡死时也不会让整个 start 卡住。
  await ensureConfigLoaded()
  timerEngine.start(stickyNoteId)
  // start 后：按配置启动白噪音 + 进入专注模式（懒加载音频模块）
  const cfg = timerEngine.config
  void import('./audio').then((m) => {
    m.setWhiteNoise(cfg.whiteNoise)
  }).catch(() => undefined)
  if (cfg.autoEnterFocusMode) {
    emitFocusMode(true, 'start')
  }
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
  // 用户主动 stop：停白噪音 + 退专注模式
  void import('./audio').then((m) => m.setWhiteNoise('none')).catch(() => undefined)
  emitFocusMode(false, 'stop')
  return getState()
}

export function skip(): PomodoroState {
  timerEngine.skip()
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

/**
 * 写入一条 pomodoros 记录
 *
 * @internal
 * 严禁 IPC handler 直接调用，本文件 `handlePhaseComplete` 事务边界专用。
 *
 * R-fix-pomodoro-persist-boundary (HIGH consistency)：原版 `export async
 * function recordPomodoro` 让任何外部模块（包括未来新增的 IPC handler）
 * 都能绕开本文件的 BEGIN/COMMIT / generation 守卫 / sticky.complete 联动
 * 直接 INSERT，破坏：
 *   1. transaction 边界（外部调用不会进 handlePhaseComplete 的 runInTransaction）
 *   2. generation 守卫（stopPomodoroService 之后的写入不会拦截）
 *   3. sticky.pomodoro_count++ / status='done' / completions 一致性
 *
 * 删 `export` 改为 module-private —— ipc/pomodoro-handlers.ts 当前没有调用方
 * （grep 已确认），整个仓库 recordPomodoro 调用点仅 handlePhaseComplete 一处。
 * JSDoc `@internal` 同步声明以便编辑器 / 文档工具提示「勿外暴露」。
 */
async function recordPomodoro(args: {
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
  // R12/R13 修复 (high)：用 withPrepared 包裹 prepare/run/finalize，避免每完成
  // 一个番茄钟泄漏一条预编译语句到 db-worker（长期高频运行后 SQLite prepared
  // statement 缓存满 → INSERT 失败）。
  await withPrepared(
    `INSERT INTO pomodoros (id, sticky_note_id, started_at, ended_at, duration_min, completed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    (stmtId) =>
      dbClient.call('run', {
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
      }),
  )
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
  // R13：走 withPrepared，pre-allocated stmt 生命周期不再由调用方手动管理。
  const start = startOfDayLocal(new Date())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const rows = await withPrepared<PomodoroRow[]>(
    `SELECT id, sticky_note_id, started_at, ended_at, duration_min, completed
     FROM pomodoros
     WHERE started_at >= ? AND started_at < ?
     AND completed = 1
     ORDER BY started_at DESC`,
    (stmtId) =>
      dbClient.call('all', {
        stmtId,
        params: [start.toISOString(), end.toISOString()],
      }) as Promise<PomodoroRow[]>,
  )
  return rows.map(rowToRecord)
}

/** 查询最近 N 条 focus 记录 */
export async function listRecent(limit = 50): Promise<PomodoroRecord[]> {
  // R13：改用 withPrepared，leak-risk 收敛到 withPrepared.ts 一处审计。
  const rows = await withPrepared<PomodoroRow[]>(
    `SELECT id, sticky_note_id, started_at, ended_at, duration_min, completed
     FROM pomodoros
     WHERE completed = 1
     ORDER BY started_at DESC
     LIMIT ?`,
    (stmtId) =>
      dbClient.call('all', {
        stmtId,
        params: [limit],
      }) as Promise<PomodoroRow[]>,
  )
  return rows.map(rowToRecord)
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
  // R-fix-cache-prefetch-silent (low)：best-effort 缓存预热失败仅意味着该
  // stickyId 在 pomodoro 完成时拿不到 title（fallback 到「便签 #id」），
  // 不影响核心功能。但完全无日志意味着若 sticky 标题永远显示成 ID 形式，
  // 开发者无法定位是预热失败还是 cache key 漂移 —— 至少留一条 warn。
  void stickyNotesRepo
    .findById(stickyNoteId)
    .then((s) => {
      if (s) stickyTitleCache.set(stickyNoteId, s.title)
    })
    .catch((err) => {
      console.warn('[pomodoro] sticky title prefetch failed', { stickyNoteId, err })
    })
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
    // R-fix-skip-sticky-complete (MEDIUM correctness)：true 表示用户
    // 主动跳过（timerEngine.skip 路径），与「自然到期」区分。skip 时
    // 不调 stickyNotesRepo.complete() —— 用户的「跳过」语义不应被
    // 解读为「这个便签已经完成了」。
    userSkipped: boolean
  },
  nextState: PomodoroState,
  prevMode: PomodoroMode,
  // H9 修复：传入 generation 快照，每个 await 后校验；不一致直接 return，
  // 避免 stopPomodoroService() 之后仍在飞行的副作用写 DB / 推 IPC。
  gen: number,
): Promise<void> {
  // generation 守卫 helper —— 闭包内多 await 都用同一个 gen。
  const guard = (): boolean => gen === pomodoroGeneration
  if (!guard()) return
  const now = new Date().toISOString()
  // R26 修复 (low correctness)：原 fallback `finished.startedAt ?? now` 在
  // startedAt 为 null 时让 startedAt === endedAt，破坏「endedAt - startedAt ≈
  // durationMin × 60」不变量且 statsBridge 的窗口过滤画出 0 时长柱。按真实经过
  // 秒数反推 startedAt = endedAt - elapsedSec。
  const startedAt =
    finished.startedAt ??
    new Date(Date.now() - finished.elapsedSec * 1000).toISOString()
  // 真实专注时长：按 elapsedSeconds 折算（避免 skip 时把整阶段算作完成）
  const durationMin = Math.max(1, Math.round(finished.elapsedSec / 60))
  // R-fix-skip-counts-as-completed (HIGH correctness)：完成判定必须排除 userSkipped。
  // 文档化不变量：userSkipped=true 永远不算完成 —— 不管 elapsedSec/totalSec 比例。
  // 即便用户 95% 处主动 skip（罕见「已经快完成了但还是想放弃」），也不算完成，
  // 不进 pomodoros.completed=1、不 ++ pomodoro_count、不自动勾掉关联便签。
  // 反之，userSkipped=false 且 elapsed/total ≥ 90% 才是自然到期完成。
  const completed =
    !finished.userSkipped &&
    finished.totalSec > 0 &&
    finished.elapsedSec / finished.totalSec >= 0.9
  const stickyNoteIdForRecord = finished.stickyNoteId

  // R-fix-pomodoro-persist-silent-fail (medium error-handling)：单次
  // 重试 + IPC 通知的失败收口点。persistFailedReason 非 null 表示
  // 写 pomodoros 表首调失败 + 重试仍失败 → 外层 catch emit
  // pomodoro:persist-failed 让用户知情（弹 toast），不再静默丢失
  // 25 分钟专注。其他错误（notifications / audio）不会进入这个分支，
  // 不影响「数据已落 DB，仅展示层失败」的判定。
  let persistFailedReason: string | null = null

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
      //
      // R34 修复 (high data integrity)：原方案把 pomodoros INSERT + sticky
      // pomodoro_count++ 包在 Tx1 内 COMMIT，再调用 stickyNotesRepo.complete()
      // 走 Tx2 写 status='done' + completions。两个事务非原子 —— Tx1 提交
      // 后 Tx2 失败（FK orphan / db-worker respawn / IPC drop / ROLLBACK）→
      // pomodoro_count 已 ++ 但 sticky.status 仍 'todo' / completions 表缺
      // 行，热力图少算一次完成。修复：把 pomodoro_count++ 让给
      // stickyNotesRepo.complete({ bumpPomodoroCount: true })，让 count++ 与
      // status='done' / completions INSERT 落在 Tx2 同一 BEGIN/COMMIT 边界。
      // Tx1 现在只写 pomodoros 表（focus 历史是事实记录，与 sticky 完成
      // 状态解耦 —— 番茄确实发生了，sticky 标记 done 是另一回事）。
      //
      // R-fix-pomodoro-persist-silent-fail：在 Tx1 外再裹一层 try/catch +
      // 单次重试（DB 短暂锁场景：notes auto-save / git 写入竞争争用
      // db-worker 时偶尔抛 SQLITE_BUSY）。仍失败时把 err.message 抛到
      // 外层 catch，由 persistFailedReason + emitPomodoroPersistFailed
      // 走 IPC 通知路径 —— 之前的「静默丢失」是本修复的根本动机。
      const writeOnce = async (): Promise<void> => {
        await dbClient.runInTransaction(async () => {
          await dbClient.call('exec', { sql: 'BEGIN' })
          try {
            // 1. 写 pomodoros 表（focus 历史 —— 番茄确实发生过的不可变事实）
            await recordPomodoro({
              stickyNoteId: stickyNoteIdForRecord,
              startedAt,
              endedAt: now,
              durationMin,
              completed,
            })
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
      }
      try {
        await writeOnce()
      } catch (firstErr) {
        log.warn('[pomodoro] recordPomodoro first attempt failed, retrying once', firstErr)
        try {
          await writeOnce()
        } catch (retryErr) {
          persistFailedReason =
            retryErr instanceof Error ? retryErr.message : String(retryErr)
          log.error('[pomodoro] recordPomodoro failed after retry', retryErr)
        }
      }
      if (persistFailedReason !== null) {
        // 抛到外层 catch —— emit pomodoro:persist-failed + return，
        // 跳过 sticky.complete / notifications / audio（focus 这次
        // 根本没记下来，让用户重做一次；不再让通知/音频给出「我刚才
        // 好像完成了」误导性提示）。
        throw new Error(`pomodoro record persist failed: ${persistFailedReason}`)
      }
      // H9 修复：事务完成后再次校验 generation；已被 stop 替换则不再发通知。
      if (!guard()) return
      // 2.5 完成时自动勾掉关联便签（status='done'）
      //   - 用 try/catch 包裹：便签可能已被删除 / archived / cancelled，
      //     不应让整个 handlePhaseComplete 失败
      //   - 仅在自然完成（completed=true && !userSkipped）时触发；
      //     skip 不到 90% 不算完成；skip ≥ 90% 也**不算**完成 —— 用户
      //     主动 skip 的语义是「不想要这次番茄」，不应把便签标记为
      //     done 或 ++ pomodoro_count（见 R-fix-skip-sticky-complete）
      //   - 同步写 completions 表（stickyNotesRepo.complete 内部已包含）
      //   - bumpPomodoroCount:true 让 sticky.pomodoro_count++ 与 status='done'
      //     / completions INSERT 落在同一 Tx2 BEGIN/COMMIT 边界，原子化
      //     pomodoro_count ↔ status='done' ↔ completions 三者一致性
      // R-fix-pomodoro-stickyTitle-cache-race：必须在调 notifyFocusComplete
      // **之前** 抓住 stickyTitle —— 下面 await 通知会读 getCachedStickyTitle
      // （用于系统 toast body + IPC payload.stickyTitle）。如果先在这里
      // delete 缓存，紧跟着 notifyFocusComplete 读到的就是 null，通知里
      // 永远退化成「进入休息」无便签标题的版本。完成后再清缓存以避免
      // archived/cancelled 之后悬空条目。
      //
      // R-fix-pomodoro-stickyTitle-rename-race (HIGH correctness)：focus 中途
      // 用户调 updateSticky 改标题会触发 invalidateStickyTitle(id) 把缓存里
      // 那条删掉 —— 此刻缓存快照已过期，但便签本身仍存在且 title 已变。
      // 仅靠缓存会拿到 null，让通知退化成「已完成 N 分钟」无便签名。
      // 这里在缓存为空时回退到 stickyNotesRepo.findById(id) 直接读最新
      // title（带 try/catch —— DB 失败时保持 null，避免通知路径被拖垮）；
      // 取不到（便签已删除 / archived / cancelled）才返回 null。
      let stickyTitleForNotify: string | null = stickyNoteIdForRecord
        ? getCachedStickyTitle(stickyNoteIdForRecord)
        : null
      if (stickyTitleForNotify === null && stickyNoteIdForRecord) {
        try {
          const fresh = await stickyNotesRepo.findById(stickyNoteIdForRecord)
          if (fresh) stickyTitleForNotify = fresh.title
        } catch (titleLookupErr) {
          log.warn(
            `[pomodoro] fallback sticky-title lookup failed for ${stickyNoteIdForRecord}`,
            titleLookupErr,
          )
        }
      }
      // H9 修复补充：sticky.complete 与 notifyFocusComplete 之间各自还有 await，
      // 每一个 await 边界都可能让 stopPomodoroService() 介入并自增 generation；
      // 这里必须再校验一次，否则 sticky 状态会被已停止的 service 偷偷勾掉。
      if (!guard()) return
      if (completed && !finished.userSkipped && stickyNoteIdForRecord) {
        try {
          await stickyNotesRepo.complete(stickyNoteIdForRecord, {
            bumpPomodoroCount: true,
          })
        } catch (stickyErr) {
          // 仅 warn —— handlePhaseComplete 主流程（notifications / 后续 break）
          // 不应被 sticky complete 失败拖垮
          // 注意：sticky complete 失败时 pomodoro_count 也不会被 ++（与 Tx1
          // 已 commit 的 pomodoros 记录解耦），sticky 状态保持原样 —— 数据
          // 一致性保留，比之前「count++ 但 status='todo'」的双事务泄漏更安全。
          log.warn(
            `[pomodoro] auto-complete sticky ${stickyNoteIdForRecord} failed`,
            stickyErr,
          )
        }
      }
      // 3. 通知（系统 + IPC 推送）
      // R11 修复 (high #10)：原来用 finished.totalSec（配置的整段时间）算出
      // durationMin → 用户 30 秒就 skip，系统通知仍报"25 分钟"。现在按真实
      // 专注时长 elapsedSec 计算，skip 时只算实际经过的分钟数（最少 1 分钟以
      // 保证通知里有非零值）。
      // R-fix-skip-sticky-complete：把 userSkipped 也视为「按 elapsedSec 折算」
      // —— skip 路径不管 elapsed/total 比例都按实际经过时长通知，避免用户
      // 主动放弃时仍收到「完成 25 分钟」的误导性提示。
      const focusCompletedMin =
        completed && !finished.userSkipped
          ? Math.round(finished.totalSec / 60)
          : Math.max(1, Math.round(finished.elapsedSec / 60))
      // H9 修复补充：await notifyFocusComplete 之前再次校验 generation，
      // 否则 sticky.complete 的 await 窗口里若 stop 已发生，notify 仍会把
      // phase-complete IPC + 系统 toast 推到所有渲染端。
      if (!guard()) return
      await notifyFocusComplete(
        nextState,
        // R-fix-pomodoro-stickyTitle-cache-race：传入本块开头抓到的 title
        // 副本（而不是再调 getCachedStickyTitle），避免被本块 catch 之外的
        // 任何竞态清空。
        stickyTitleForNotify,
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
      // R-fix-pomodoro-stickyTitle-cache-race：通知已发出 → 现在清掉缓存。
      // 必须在 await 之后做（之前在 stickyNotesRepo.complete 后立刻 delete，
      // 会被紧跟着的 notifyFocusComplete → getCachedStickyTitle 读为 null）。
      // 只清原本被弹出来时确实在缓存里的那条 —— 避免误清后续重新挂载的同 id
      // 便签（webContentsId 单调递增 / sticky 重新被 create 复用）。
      if (stickyNoteIdForRecord && stickyTitleForNotify !== null) {
        const stillCached = stickyTitleCache.get(stickyNoteIdForRecord)
        if (stillCached === stickyTitleForNotify) {
          stickyTitleCache.delete(stickyNoteIdForRecord)
        }
      }
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
    if (!guard()) return
    if (nextState.running && nextState.mode !== 'focus') {
      await notifyAutoStart(nextState)
    }
    // 5. 音频 + 专注模式副作用（lazy import 音频模块）
    //    - focus 完成：停白噪音 + 播完成音 + 退专注模式
    //    - break 完成（自动进 focus）：若配置启用，重启白噪音 + 进专注模式
    if (!guard()) return
    try {
      const audioMod = await import('./audio')
      // R-fix-pomodoro-audio-after-stop：await import('./audio') 让出事件循环，
      // 期间用户可能 stopPomodoroService() 让 generation 递增、emitFocusMode(false,'stop')
      // 已发出。这里必须再检一次 guard()，否则下一行 setWhiteNoise / playCompletionSound /
      // emitFocusMode(true,'start') 会作用在一个已被停止的会话上 —— 渲染端 focusMode
      // 会从 false (stop) 立刻翻回 true (auto-start)，白噪音 IPC 也会在 stop 的清理
      // setWhiteNoise('none') 之后再开一次。其它 await 边界（532/635/725/732）都已
      // 加 guard，这是最后一道缺口。
      if (!guard()) return
      if (prevMode === 'focus') {
        audioMod.setWhiteNoise('none')
        audioMod.playCompletionSound('focus')
        emitFocusMode(false, 'complete')
      } else if (nextState.running && nextState.mode === 'focus') {
        // break 自动进 focus：若配置了白噪音，重启
        if (timerEngine.config.whiteNoise !== 'none') {
          audioMod.setWhiteNoise(timerEngine.config.whiteNoise)
        }
        if (timerEngine.config.autoEnterFocusMode) {
          emitFocusMode(true, 'start')
        }
        audioMod.playCompletionSound(prevMode as 'shortBreak' | 'longBreak')
      }
    } catch (audioErr) {
      log.warn('[pomodoro] audio side-effect failed', audioErr)
    }
  } catch (err) {
    // R-fix-pomodoro-persist-silent-fail：当 recordPomodoro 首调 + 重试
    // 都失败时，persistFailedReason 已被设置；这里 emit IPC 让渲染端
    // 弹 toast 告知用户「本次专注未记录」。其他 catch 分支
    // （notifications / audio 失败）persistFailedReason 仍是 null，
    // 不会触发额外通知 —— 数据已经落 DB，提示 DB 失败反而误导用户。
    log.error('[pomodoro] handlePhaseComplete error', err)
    if (persistFailedReason !== null) {
      emitPomodoroPersistFailed(
        prevMode,
        // 用焦点完成时刻的真实经过分钟数（与 notify 路径同口径，
        // 让 toast 显示的时长跟用户主观感受一致；skip 场景
        // elapsedSec 已含最少 1 分钟 floor）。
        Math.max(1, Math.round(finished.elapsedSec / 60)),
        persistFailedReason,
      )
    }
  }
}