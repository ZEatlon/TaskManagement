/**
 * AI → 番茄钟桥接层
 *
 * 目的：让 ai/tools.ts 里的 startPomodoro / stopPomodoro / pausePomodoro
 * 工具不直接依赖 pomodoro/ 目录的内部实现（timerEngine 状态机细节 /
 * notifications 推送），只通过 pomodoroService 暴露的公共 API 操作。
 * 这样 pomodoro 模块重构时只需要改这一个文件。
 *
 * 设计约束：
 *   - 本文件**只读写** pomodoroService 的导出函数，不触碰 timerEngine。
 *   - 所有函数返回「可直接 JSON.stringify 给 LLM」的纯数据结构，
 *     不返回 Date / class 实例。
 *   - 自定义时长（minutes）通过 saveConfig({ focusMin }) 落到用户配置里
 *     —— pomodoroService 没有「本次专注临时时长」的通道，所以这是一个
 *     **持久**变更；返回值用 focusMinChanged 明确告知 LLM，让它能在回复
 *     里如实告诉用户「已把默认专注时长改为 N 分钟」。
 *
 * R32-Corr-2 修复 (MEDIUM structure)：canonical 命名：
 *   - applyPomodoroAction({ action, ... })  合并 start / stop / pause 的统一入口
 *   - getPomodoroState()                     只读当前状态
 *   - getPomodoroStats(range)                番茄钟统计（实现仍留在
 *     statsBridge.ts；本文件只做 re-export，详见下方注释）
 *
 * 老 start / stop / pause / state 别名已删除（仓库内零调用方，R-fix
 * 清理）。tools/pomodoro.ts 全部走 canonical 入口。
 */
import {
  getState,
  loadConfig,
  saveConfig,
  start as serviceStart,
  stop as serviceStop,
  pause as servicePause,
  resume as serviceResume,
} from '../pomodoro/pomodoroService'
import { stickyNotesRepo } from '../db/repositories/stickyNotes'
import { POMODORO_FOCUS_MIN_LIMITS, type PomodoroState } from '@shared/ipc/channels'
import log from '../log'

/** 自定义专注时长的合法区间（分钟）。LLM 可能给 0 / -5 / 9999
 *
 * R32-Corr-3 修复 (HIGH consistency)：权威源迁回 @shared/ipc/channels 的
 * POMODORO_FOCUS_MIN_LIMITS —— 与 channels.ts 的 Zod schema / tools/pomodoro.ts
 * 的 minimum/maximum 同源。改 max 只需改 channels.ts 一处，bridge + schema + 工具描述
 * 自动跟随，不再靠「两个文件保持一致」的人肉同步（之前是漂移源）。
 */
const MIN_FOCUS_MINUTES = POMODORO_FOCUS_MIN_LIMITS.min
const MAX_FOCUS_MINUTES = POMODORO_FOCUS_MIN_LIMITS.max

/** 回给 LLM 的精简状态（不含内部字段） */
export interface BridgeState {
  mode: PomodoroState['mode']
  running: boolean
  remainingSec: number
  totalSec: number
  elapsedSec: number
  cycleIndex: number
  /** 关联便签 ID；未绑定时保留为 null（不要省略字段） */
  stickyNoteId: string | null
  startedAt: string | null
}

function toBridgeState(s: PomodoroState): BridgeState {
  return {
    mode: s.mode,
    running: s.running,
    remainingSec: s.remainingSec,
    totalSec: s.totalSec,
    elapsedSec: s.elapsedSec,
    cycleIndex: s.cycleIndex,
    stickyNoteId: s.stickyNoteId ?? null,
    startedAt: s.startedAt ?? null,
  }
}

/** applyPomodoroAction 的 action 判别字段 */
export type PomodoroAction = 'start' | 'stop' | 'pause'

/** start 专属参数（action='start' 时透传） */
export interface PomodoroActionStartOpts {
  /** 要绑定的便签 ID（可选） */
  stickyNoteId?: string | null
  /** 自定义专注时长（分钟，可选） */
  minutes?: number | null
}

/** stop 专属参数（action='stop' 时透传） */
export interface PomodoroActionStopOpts {
  /** 用户已明确表示「直接停」，跳过渲染端二级确认 */
  force?: boolean
}

/** pause 无专属参数（toggle 行为） */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PomodoroActionPauseOpts {
  // 空 —— pause 行为由当前 running / elapsed 自动判定
}

/** applyPomodoroAction 入参：action 必填，其余按 action 给具体 opts */
export type PomodoroActionInput =
  | ({ action: 'start' } & PomodoroActionStartOpts)
  | ({ action: 'stop' } & PomodoroActionStopOpts)
  | ({ action: 'pause' } & PomodoroActionPauseOpts)

/**
 * applyPomodoroAction 返回的判别联合：
 *   - 成功   → { ok: true, kind: 'start' | 'stop' | 'paused' | 'resumed', state, ...actionSpecific }
 *   - 失败   → { ok: false, error, state? }
 * 用 discriminated union（kind 字段）让调用方 / LLM 一眼区分本次实际执行
 * 的是哪个动作，避免老 PauseResult 里 action:'paused'|'resumed' 与外部
 * action:'start'|'stop'|'pause' 概念混淆。
 */
export type PomodoroActionResult =
  | {
      ok: true
      kind: 'start'
      state: BridgeState
      stickyNoteId?: string | null
      focusMinChanged?: boolean
      focusMin?: number
    }
  | {
      ok: true
      kind: 'stop'
      state: BridgeState
      /** 调用方是否要求跳过 UI 二次确认 */
      forced: boolean
    }
  | {
      ok: true
      kind: 'paused' | 'resumed'
      state: BridgeState
    }
  | {
      ok: false
      error: string
      state?: BridgeState
      /** 失败时透传当前 action —— 渲染端 / LLM 知道是哪条路径失败 */
      kind?: 'start'
    }
  | {
      ok: false
      error: string
      state?: BridgeState
      /** 失败时透传当前 action —— 渲染端 / LLM 知道是哪条路径失败 */
      kind?: 'stop'
      /** 与成功分支一致：保留 forced 字段让渲染端判断是否要弹二级确认 */
      forced: boolean
    }
  | {
      ok: false
      error: string
      state?: BridgeState
      /** 失败时透传当前 action —— 渲染端 / LLM 知道是哪条路径失败 */
      kind?: 'paused' | 'resumed'
    }

/**
 * 统一番茄钟动作入口。把 start / stop / pause 收敛到单一函数，与
 * tagBridge 的 applyTagToX / removeTagFromSticky 命名一致。
 *
 * 内部直接调 pomodoroService 的 start / stop / pause / resume；不再
 * 通过 start / stop / pause 旧函数中转（那两个别名已删除）。
 */
export async function applyPomodoroAction(
  input: PomodoroActionInput,
): Promise<PomodoroActionResult> {
  switch (input.action) {
    case 'start':
      return applyStart(input.stickyNoteId ?? null, input.minutes ?? null)
    case 'stop':
      return applyStop(input.force === true)
    case 'pause':
      return applyTogglePause()
  }
}

async function applyStart(
  stickyNoteIdRaw: string | null,
  minutesRaw: number | null,
): Promise<PomodoroActionResult> {
  const noteId =
    typeof stickyNoteIdRaw === 'string' && stickyNoteIdRaw.trim()
      ? stickyNoteIdRaw.trim()
      : null

  if (noteId) {
    const sticky = await stickyNotesRepo.findById(noteId)
    if (!sticky) {
      return { ok: false, error: '便签不存在，无法绑定番茄钟', kind: 'start' }
    }
  }

  let focusMinChanged = false
  let focusMin: number | undefined
  /**
   * 改 focusMin 之前的原始值，用于 serviceStart 失败 / 已运行守卫短路时回滚，
   * 避免「用户从未确认过的默认专注时长」被悄悄持久化（state-leak-on-failure）。
   * 只有当 minutes 实际被写入（focusMinChanged=true）时才需要回滚。
   */
  let previousFocusMin: number | undefined
  try {
    if (minutesRaw !== undefined && minutesRaw !== null) {
      const n = Number(minutesRaw)
      if (!Number.isFinite(n)) {
        return { ok: false, error: 'minutes 必须是数字', kind: 'start' }
      }
      const clamped = Math.min(Math.max(Math.round(n), MIN_FOCUS_MINUTES), MAX_FOCUS_MINUTES)
      const cur = await loadConfig()
      focusMin = clamped
      previousFocusMin = cur.focusMin
      if (cur.focusMin !== clamped) {
        await saveConfig({ focusMin: clamped })
        focusMinChanged = true
      }
    }

    const current = getState()
    if (current.running) {
      return {
        ok: false,
        error: '番茄钟已在运行中；如需切换请先 stopPomodoro',
        state: toBridgeState(current),
        kind: 'start',
      }
    }

    const state = await serviceStart(noteId)
    log.info(
      `[ai/pomodoroBridge] start stickyNoteId=${noteId ?? 'null'} focusMin=${focusMin ?? 'default'}`,
    )
    return {
      ok: true,
      kind: 'start',
      state: toBridgeState(state),
      stickyNoteId: noteId,
      ...(focusMin !== undefined ? { focusMin, focusMinChanged } : {}),
    }
  } catch (err) {
    // 回滚 focusMin：serviceStart（DB lock / notesRepo 异常 / getState 状态竞争）
    // 抛错时，cur.focusMin 必须恢复，否则下次新建番茄钟不带 minutes 时会用
    // 一个用户从未确认过的默认时长启动。注意：「已运行守卫」的 early return
    // 不会进 catch —— 那种情况下 focusMin 仍被写入是原有意行为（用户明确
    // 要求改默认值，仅是本次 start 被拒绝），不在本修复范围内。
    if (focusMinChanged && previousFocusMin !== undefined) {
      try {
        await saveConfig({ focusMin: previousFocusMin })
      } catch (rollbackErr) {
        // 回滚本身也失败 —— 至少日志告警，避免静默吞错让用户默认值处于不确定态。
        log.warn(
          `[ai/pomodoroBridge] focusMin rollback failed: ${(rollbackErr as Error)?.message ?? rollbackErr}`,
        )
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: message || '启动番茄钟失败',
      kind: 'start',
    }
  }
}

/**
 * 停止当前番茄钟。
 *
 * force 语义：工具层的 risk='side-effect' 已经让 stream.ts 弹一次确认对话
 * 框；force=true 表示用户在自然语言里已经明确表达「直接停，别再问我」，
 * 我们把它透传到结果里，渲染端可据此跳过自己那层「确定要放弃本次专注吗」
 * 的二次确认。主进程侧无论 force 与否都执行停止（第一层确认已经过了）。
 */
async function applyStop(force?: boolean): Promise<PomodoroActionResult> {
  const forced = force === true
  const current = getState()
  if (!current.running && current.elapsedSec === 0) {
    return {
      ok: false,
      error: '当前没有进行中的番茄钟',
      forced,
      state: toBridgeState(current),
      kind: 'stop',
    }
  }
  const state = serviceStop()
  log.info(`[ai/pomodoroBridge] stop forced=${forced}`)
  return { ok: true, kind: 'stop', state: toBridgeState(state), forced }
}

/**
 * 暂停 / 恢复（toggle）。
 *
 * running=true → pause()；running=false 且 startedAt 已设置 → resume()。
 * 完全没开始过（startedAt=null）时不 toggle，回报错误，避免 LLM 把
 * 「暂停」当成「开始」。
 *
 * R-fix-pause-resume-elapsed0 (HIGH correctness)：原条件
 * `startedAt !== null && elapsedSec > 0` 把「刚 start 后 < 1s 内就 pause」
 * 的状态（startedAt 已设但 tick 还没把 elapsedSec 从 0 推到 1）误判为
 * 「没有可恢复的番茄钟」，返回错误。timerEngine.resume() 内部对这种
 * 「pausedAt 存在但 elapsedSec=0」的状态是合法的（只检查
 * remainingSec <= 0），所以 bridge 不应该替它拒绝。把条件放宽到
 * `startedAt !== null && !running`：startedAt 已设且 running=false
 * 即可唯一标识「处于 paused 状态」，无论 first tick 是否已发生。
 */
async function applyTogglePause(): Promise<PomodoroActionResult> {
  const current = getState()
  if (current.running) {
    const state = servicePause()
    log.info('[ai/pomodoroBridge] pause')
    return { ok: true, kind: 'paused', state: toBridgeState(state) }
  }
  if (current.startedAt !== null && !current.running) {
    const state = serviceResume()
    log.info('[ai/pomodoroBridge] resume')
    return { ok: true, kind: 'resumed', state: toBridgeState(state) }
  }
  // R-fix-pausePomodoro-kind-on-failure (HIGH ai-quality)：失败分支以前
  // 固定返回 kind: 'paused'，LLM 据 kind 字段判定动作类型时会把失败误报
  // 成「已暂停」，且 error 字段被忽略 → 用户以为暂停成功但实际啥也没发生。
  // 改为失败分支**省略** kind 字段，让 ok:false + error 单独表达失败语义，
  // kind 字段严格绑定到成功分支（ok=true 时 kind 才有意义）。LLM 据工具
  // description 必须先判断 ok 字段，ok=false 时不要把任何 kind 当作可信。
  return {
    ok: false,
    error: '当前没有进行中或已暂停的番茄钟',
    state: toBridgeState(current),
  }
}

/**
 * R32-Corr-2：canonical 只读状态查询。
 */
export function getPomodoroState(): BridgeState {
  return toBridgeState(getState())
}

/**
 * R32-Corr-2：番茄钟统计 canonical 入口。
 *
 * 重要：实现**没有**并入本文件，仍完整留在 statsBridge.ts（prepareCached
 * 缓存 + queryRangeRows / queryCount / queryAllDates / computeStreak 一
 * 整套 + 类型 StatsRange / PomodoroStats / PomodoroStatsError 都在那里）。
 * 本文件只在末尾用一行 `export { getPomodoroStats } from './statsBridge'`
 * 把函数重新挂出，方便 tools/registry.ts 与未来任何 pomodoro 相关代码
 * 一处 import（`from '../pomodoroBridge'`）即可。
 *
 * 为什么不做物理合并：statsBridge.ts 自身 ~280 行 + 复杂 SQL/聚合逻辑，
 * 跟 pomodoroService 调用 + focusMin 回滚 + 判别联合返回值的 bridge 主
 * 体混在一起会让单文件膨胀到 600+ 行、阅读与 code review 成本徒增。canonical
 * 入口指"所有调用方都从 pomodoroBridge 拿函数"，不指"所有实现都在
 * pomodoroBridge 里"——这两件事请勿混淆，避免读 header 跳到本文件找不到
 * 实现时反复 grep。
 *
 * 类型导入建议：从 statsBridge.ts 直接拿（`import type { StatsRange,
 * PomodoroStats } from '../statsBridge'`），不在本文件 re-export 避免两份
 * 类型声明 drift。
 */
export { getPomodoroStats } from './statsBridge'