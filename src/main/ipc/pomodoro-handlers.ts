/**
 * 番茄钟 IPC 处理器
 *
 * 注册通道（来自 IPC_CHANNELS，定义见 @shared/ipc/channels.ts）：
 *   - pomodoro:get-state         -> PomodoroState
 *   - pomodoro:get-config        -> PomodoroConfig
 *   - pomodoro:update-config     -> PomodoroConfig
 *   - pomodoro:start             -> PomodoroState
 *   - pomodoro:pause             -> PomodoroState
 *   - pomodoro:resume            -> PomodoroState
 *   - pomodoro:stop              -> PomodoroState
 *   - pomodoro:skip              -> PomodoroState
 *   - pomodoro:reset             -> PomodoroState（保留通道作向后兼容，内部
 *                                          直接转发到 stop()，与 stop 行为一致）
 *   - pomodoro:today             -> PomodoroRecord[]
 *   - pomodoro:recent            -> PomodoroRecord[]
 *   - pomodoro:daily             -> Record<string, number>（YYYY-MM-DD -> 分钟数，热力图）
 *
 * 推送事件（主 -> 渲染）：
 *   - pomodoro:tick
 *   - pomodoro:phase-complete
 *   - pomodoro:state-changed
 *   - pomodoro:focus-mode-changed（专注模式开关状态）
 *   - pomodoro:audio-set（白噪音设置变更）
 *   - pomodoro:audio-play-sound（请求播放完成音效）
 *   - pomodoro:persist-failed（DB 写失败提示渲染端弹 toast）
 */
import { handle } from './channels'
import { IPC_CHANNELS, type PomodoroConfig } from '@shared/ipc/channels'
import {
  getState,
  start,
  pause,
  resume,
  stop,
  skip,
  loadConfig,
  saveConfig,
  listToday,
  listRecent,
  validatePomodoroConfigPatch,
} from '../pomodoro/pomodoroService'
import { pomodorosRepo } from '../db/repositories/pomodoros'
import { parseSafeDayKey } from '../ai/tools/validators'
import { isUuid } from '@shared/lib/uuid'

/**
 * R45-fix-pomodoro-start-id-asymmetry (medium input-validation-asymmetry)：
 * sibling handler 已统一加 assert：sticky-note-handlers R34-Corr-1a、
 * completion-handlers R40（assertUuidId）、conversation-handlers
 * R35-Corr-2（assertNonEmptyStringId）、ai-handlers R32-04。
 * 本 handler 与它们形成不对称。复用 @shared/lib/uuid.isUuid 单一权威源
 * 与 completion-handlers:45 同款实现；非法入参直接抛 Error（channels.ts
 * 的 try/catch 会把它转成 IPC reject 给渲染端），不要让 timer state
 * 被非 string stickyNoteId 污染（emitTick/emitStateChanged 后续每秒推
 * 整个 state 给所有渲染端，IPC payload 携带非 string stickyNoteId 会
 * 让下游 `state.stickyNoteId.toLowerCase()` 等无 type-guard 调用炸单
 * 渲染进程）。
 */
function assertUuidId(id: unknown, channel: string): asserts id is string {
  if (typeof id !== 'string' || id.trim() === '' || !isUuid(id)) {
    throw new Error(`${channel}: id must be a non-empty UUID string`)
  }
}

export function registerPomodoroHandlers(): void {
  /** 查询当前计时状态 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_GET_STATE,
    async () => getState(),
  )

  /** 查询番茄钟配置 */
  handle<undefined, PomodoroConfig>(
    IPC_CHANNELS.POMODORO_GET_CONFIG,
    async () => loadConfig(),
  )

  /** 更新番茄钟配置 */
  // R-fix-pomodoro-config-validate：IPC 边界先把 patch 走
  // validatePomodoroConfigPatch 校验 —— saveConfig 内部也会再校验一次
  // （纵深防御），但 IPC 层提前 throw 能在 trace 上更早看到 stack，
  // 也避免依赖 service 层校验顺序。
  handle<Partial<PomodoroConfig>, PomodoroConfig>(
    IPC_CHANNELS.POMODORO_UPDATE_CONFIG,
    async (_e, patch) => {
      const safePatch = validatePomodoroConfigPatch(patch)
      return saveConfig(safePatch)
    },
  )

  /** 开始计时（不再需要关联便签参数 —— 调用方已下线 stickyNoteId 选择器） */
  // 渲染端 stores/pomodoro.ts:start() 现在以无参形式调用，handler 仍保留
  // null/undefined 容错（兼容旧调用）。
  // R45-fix-pomodoro-start-id-asymmetry：非 null 时走 UUID 校验；null/undefined
  // 路径保留（兼容无 sticky 启动 + 旧调用）。校验失败抛错让 channels.ts 转
  // IPC reject 给渲染端，timer state 不会被非 string stickyNoteId 污染。
  handle<string | null | undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_START,
    async (_e, stickyNoteId) => {
      if (stickyNoteId !== null && stickyNoteId !== undefined) {
        assertUuidId(stickyNoteId, IPC_CHANNELS.POMODORO_START)
      }
      return start(stickyNoteId ?? null)
    },
  )

  /** 暂停 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_PAUSE,
    async () => pause(),
  )

  /** 恢复 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_RESUME,
    async () => resume(),
  )

  /** 停止（清零回到初始 focus 阶段） */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_STOP,
    async () => stop(),
  )

  /** 跳过当前阶段 */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_SKIP,
    async () => skip(),
  )

  /** 重置（=stop —— R-fix-timer-engine-reset-stop-drift：原本 reset() 是 stop()
   *  的纯别名但还少跑 white-noise / focus-mode 清理副作用；现在直接转发 stop，
   *  让 UI 「重置」与「停止」按钮走同一条清理路径，行为一致。通道保留以
   *  保证外部已有调用方的向后兼容。） */
  handle<undefined, ReturnType<typeof getState>>(
    IPC_CHANNELS.POMODORO_RESET,
    async () => stop(),
  )

  /** 今日完成列表 */
  handle<undefined, Awaited<ReturnType<typeof listToday>>>(
    IPC_CHANNELS.POMODORO_TODAY,
    async () => listToday(),
  )

  /**
   * 最近 N 条 focus 完成记录（默认 50）。
   *
   * R-fix-pomodoro-listrecent-unexposed (medium documentation-drift)：
   * pomodoroService.listRecent 历史上一直存在（line ~418），但 channels.ts
   * 与 pomodoro-handlers.ts 都没把通道暴露出去 → header 文档（line 21 与
   * pomodoro-handlers.ts:15）声称存在 `pomodoro:recent -> PomodoroRecord[]`，
   * 但实际渲染端 / 其他模块调不到。现补上注册，让 header 文档与实现一致。
   * limit 走参数（不写死 50）：调用方传 1..200 区间，handler 内部做边界 clamp
   * 避免单次查询拉太多行阻塞 db-worker。
   */
  handle<{ limit?: number }, Awaited<ReturnType<typeof listRecent>>>(
    IPC_CHANNELS.POMODORO_RECENT,
    async (_e, args) => {
      // 防御性 clamp：渲染端可被 XSS 操控，越界值可能 OOM db-worker。
      // 与 listRecent 默认 50 / 上限 200 对齐（与 pomodorosRepo 同口径）。
      const raw = typeof args?.limit === 'number' && Number.isFinite(args.limit)
        ? Math.trunc(args.limit)
        : 50
      const limit = Math.max(1, Math.min(200, raw))
      return listRecent(limit)
    },
  )

  /**
   * 热力图数据：区间内每日专注分钟数（YYYY-MM-DD → minutes）
   * 完成口径与 pomodoros 表 completed=1 一致。
   *
   * R-fix-pomodoro-daily-daykey-validate：start/end 必须是严格
   * YYYY-MM-DD（防 2025-13-99 / '' / '2099-12-31' 等垃圾值）——
   * 否则 SQLite 文本比较要么空集（热力图假空）要么全表扫描
   * （DoS）。复用 ai/tools/validators.parseSafeDayKey 单一来源。
   */
  handle<{ start: string; end: string }, Record<string, number>>(
    IPC_CHANNELS.POMODORO_DAILY,
    async (_e, { start, end }) => {
      const safeStart = parseSafeDayKey(start)
      const safeEnd = parseSafeDayKey(end)
      if (!safeStart || !safeEnd) {
        throw new Error(
          `pomodoro:daily invalid day key (start=${JSON.stringify(start)}, end=${JSON.stringify(end)})`,
        )
      }
      // 单日（start >= end）也允许：直接退化为该日的 dailyMinutes
      // 调用，让渲染端拿到一个「明确知道是单日」的空结果，避免热力
      // 图在用户故意传同一天时无声吞掉。
      return pomodorosRepo.dailyMinutes(safeStart, safeEnd)
    },
  )
}