/**
 * Git 自动同步调度器
 *
 * 职责：
 *   - 使用 croner 周期性触发 commit → push
 *   - 根据 settings.gitAutoPushEnabled 与 settings.gitPushIntervalMinutes 决定是否启动
 *   - 将同步进度通过 IPC 推送给渲染进程（start / end / error）
 *
 * 触发条件：
 *   - libraryPath 已设置
 *   - 已配置 origin remote
 *   - settings.gitAutoPushEnabled === true
 *   - 已有 git.token 凭据（私有仓库必需；公开仓库可省略但建议配置）
 *
 * 失败策略：
 *   - 单次失败仅记日志 + 推送 GIT_SYNC_ERROR，不停止 cron
 *   - 连续失败 N 次（默认 3）后自动暂停，并通知用户
 */
import { Cron } from 'croner'
import { BrowserWindow } from 'electron'
import log from '../log'
import { settingsRepo } from '../db/repositories/settings'
import {
  IPC_CHANNELS,
  defaultCommitMessage,
  type GitSyncState,
  type GitSyncPhase,
} from '@shared/ipc/channels'
import {
  commitAndPush,
  isRepo,
  getStatus,
  getRemote,
  GitError,
} from './gitManager'
import { isBlockedHostname, assertHostnameStillPublic } from '../lib/networkSafety'

/**
 * R18 修复 (high security)：每次 commit+push 前重新读 .git/config 并
 * 校验 origin 的 hostname 不是 loopback / 内网 / link-local。
 *
 * R17 只在 git-handlers.ts 的 GIT_PULL / GIT_PUSH / GIT_SYNC_NOW 三个
 * IPC 入口前调用 assertRemoteSafe。但自动同步调度器（cron tick + 5s 首
 * 次延迟 timer）和 GIT_AUTO_COMMIT_PUSH 通道（git-handlers.ts:336）都
 * 直接调 runOnceNow()，绕过 assertRemoteSafe —— 攻击者写库目录后下
 * 一次自动同步就把 PAT 静默外泄。
 *
 * 现在把 assertRemoteSafe 抽到本文件，作为 runOnceInternal 流程的强制
 * 第一步：所有入口（cron + initialTimer + 手动 + IPC）都共用同一个安全
 * 闸门，绕过入口就绕过校验的可能被堵死。
 */
export async function assertRemoteSafe(dir: string): Promise<void> {
  const remote = await getRemote(dir, 'origin')
  if (!remote?.url) {
    throw new Error('git remote is not configured; refusing to push/pull')
  }
  // 复用 git-handlers.ts 的 hostOf 思路：本文件不再依赖 git-handlers，
  // 自己用 URL 解析 hostname（保留 ssrf 解析逻辑的一致性）。
  let host: string | null = null
  try {
    host = new URL(remote.url).hostname.toLowerCase()
  } catch {
    host = null
  }
  if (!host) {
    throw new Error(`git remote url cannot be parsed: ${remote.url}`)
  }
  if (isBlockedHostname(host)) {
    log.error(
      `[git-auto] refusing push/pull: remote host '${host}' is loopback / private / link-local; ` +
        'this may indicate .git/config tampering',
    )
    throw new Error(
      `git remote host '${host}' is not allowed (loopback / private / link-local)`,
    )
  }
  // R22 修复 (high security)：仅靠 isBlockedHostname 词法检查挡不住 DNS rebinding
  // —— 用户配置的 `mygit.duckdns.org` 在 cron 触发时若被 rebind 到 127.0.0.1，
  // 词法检查通过，PAT 仍会发到 loopback 上。补 assertHostnameStillPublic 在
  // push/pull 真正发生时再解析一次，把动态 DNS / nip.io / sslip.io 等
  // DDNS 通杀（assertHostnameStillPublic 内部用 dns.lookup 并检查每个返回 IP）。
  await assertHostnameStillPublic(host)
}

/** settings 表中 AppSettings 的 key（与 libraryManager.ts 保持一致） */
const SETTINGS_KEY = 'app.settings'

/** 默认自动同步间隔（分钟） */
const DEFAULT_INTERVAL_MIN = 5

/** 连续失败超过此次数自动暂停 */
const MAX_CONSECUTIVE_FAILURES = 3

/** 当前调度器实例 */
let cronJob: Cron | null = null
/** R5S-7：startAutoSync 排定了一个 5s 后的首次同步 setTimeout，必须保存 handle，
 *  stopAutoSync 才能取消。否则用户在 5s 内关闭自动同步，timer 仍会触发
 *  commit+push，造成「关闭后还会偷偷推一次」的行为。 */
let initialTimer: NodeJS.Timeout | null = null

/** 是否已启动 */
let started = false

/**
 * R7G-2 / R7G-3 修复：in-flight 锁。
 *
 * 原实现没有并发控制：
 *   - 手动 "立即同步" 与 cron tick 同时跑 → commit/push 并发 → .git/index 损坏
 *   - croner 默认 protect:false，sync 时长 > 间隔时下一次 tick 重叠
 *
 * 用一个全局 in-flight promise 串行化所有同步入口（cron + 手动 + 首次延迟）。
 * 若已有同步进行中，新调用直接返回现有 promise（不是错误 —— "已经在同步了"）。
 */
let syncInFlight: Promise<{ ok: boolean; error?: string }> | null = null

/** 同步状态（最近一次） */
const state: GitSyncState = {
  phase: 'idle',
  lastSyncAt: null,
  lastError: null,
  autoEnabled: false,
}

/** 连续失败计数 */
let consecutiveFailures = 0

/** 间隔分钟数（启动时锁定，运行中变更需 restart） */
let currentIntervalMin = DEFAULT_INTERVAL_MIN

/** 启动流程的 in-flight promise；用于合并并发 startAutoSync 调用，避免创建多个 cron */
let startInFlight: Promise<void> | null = null

/**
 * 把当前状态广播给所有渲染窗口
 */
function broadcastState(phase?: GitSyncPhase): void {
  if (phase !== undefined) state.phase = phase
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.GIT_STATE_CHANGED, state)
  }
}

/**
 * 发送同步事件（start / end / error）
 */
function emit(channel: 'start' | 'end' | 'error', payload: unknown): void {
  const name =
    channel === 'start'
      ? IPC_CHANNELS.GIT_SYNC_START
      : channel === 'end'
        ? IPC_CHANNELS.GIT_SYNC_END
        : IPC_CHANNELS.GIT_SYNC_ERROR
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(name, payload)
  }
}

/**
 * 读取当前生效设置
 */
async function readSettings(): Promise<{
  libraryPath: string | null
  gitAutoPushEnabled: boolean
  gitPushIntervalMinutes: number
}> {
  const all = await settingsRepo.getAll()
  const cfg = (all[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}
  return {
    libraryPath: (cfg.libraryPath as string | null | undefined) ?? null,
    gitAutoPushEnabled: Boolean(cfg.gitAutoPushEnabled),
    gitPushIntervalMinutes:
      typeof cfg.gitPushIntervalMinutes === 'number'
        ? cfg.gitPushIntervalMinutes
        : DEFAULT_INTERVAL_MIN,
  }
}

/**
 * 启动自动同步调度器（幂等）
 *
 * 行为：
 *   - 已启动则跳过
 *   - 库目录不存在或未启用则不启动
 *   - 启动 cron 后首次立即执行一次（fire-and-forget）
 *
 * 并发安全：
 *   - 使用 in-flight promise 合并并发调用，避免重启路径与启动路径同时跑出两个 cron
 */
export async function startAutoSync(): Promise<void> {
  if (started) {
    log.warn('[git-auto] already started')
    return
  }
  if (startInFlight) {
    return startInFlight
  }
  startInFlight = (async () => {
    try {
      const settings = await readSettings()
      if (!settings.libraryPath) {
        log.info('[git-auto] skipped: libraryPath is empty')
        return
      }
      if (!settings.gitAutoPushEnabled) {
        log.info('[git-auto] skipped: auto-push disabled in settings')
        state.autoEnabled = false
        broadcastState('idle')
        return
      }

      // 检查仓库是否就绪
      const repoOk = await isRepo(settings.libraryPath)
      if (!repoOk) {
        log.info(`[git-auto] skipped: not a git repo: ${settings.libraryPath}`)
        state.autoEnabled = false
        broadcastState('idle')
        return
      }

      state.autoEnabled = true
      // R11 修复 (medium #30)：原版只 Math.max(1, ...) 没上限，用户填 720（12 小时）
      // 或 1440（24 小时）会生成 "*/720 * * * *" —— croner / cron 在 minute 字段只
      // 接受 0-59，*/720 等价「每 720 分钟一次」实际语义被解释为「minute=720」（不存在）
      // → cron 永远不触发 / 设置里能改但实际无效。
      // 现在把 interval clamp 到 [1, 59]（分钟字段合法值范围）。更大间隔需求应在
      // croner 的 hour/day 字段构造表达式，或改为 hourly/daily 模式。当前没有
      // hour/day 字段的设置入口，所以先 clamp 并日志提醒用户。
      const requestedMin = Number.isFinite(settings.gitPushIntervalMinutes)
        ? settings.gitPushIntervalMinutes
        : DEFAULT_INTERVAL_MIN
      currentIntervalMin = Math.min(59, Math.max(1, Math.floor(requestedMin)))
      if (currentIntervalMin !== requestedMin) {
        log.warn(
          `[git-auto] gitPushIntervalMinutes=${requestedMin} clamped to ${currentIntervalMin} (cron minute field accepts 1-59)`,
        )
      }
      const cronExpr = `*/${currentIntervalMin} * * * *`
      // R7G-3 + R11 修复 (high #12)：cron tick 也走 runOnceNow() 而不是直接
      // runOnceInternal() —— protect:true 让 cron 不会与自己重叠，但用户手动
      // 「立即同步」(runOnceNow) 和 cron tick 同时跑时，protect 只挡 cron 自己，
      // 手动同步的 syncInFlight 锁挡不了 cron tick。统一通过 runOnceNow 让两条
      // 入口共享同一个 in-flight promise。
      cronJob = new Cron(cronExpr, { name: 'git-auto-sync', protect: true }, async () => {
        await runOnceNow()
      })
      started = true
      consecutiveFailures = 0
      log.info(`[git-auto] started (cron='${cronExpr}')`)
      broadcastState('idle')

      // 首次延迟 5s 后立即触发一次（避免冷启动时与 DB 抢占资源）
      initialTimer = setTimeout(() => {
        // 计时器触发时再次确认 started 仍为 true（用户可能在 5s 内关闭了自动同步）
        if (!started) return
        // R12 修复 (high)：initialTimer 原本直接调 runOnceInternal() 绕过
        // syncInFlight 锁，与同时到达的 cron tick / 手动 "立即同步" 可能并发
        // commit+push。改为走 runOnceNow() 共享同一 in-flight promise，确保
        // 三个入口串行。
        void runOnceNow()
      }, 5_000)
    } finally {
      startInFlight = null
    }
  })()
  return startInFlight
}

/**
 * 停止调度器
 */
export function stopAutoSync(): void {
  // R5S-7：先取消首次同步 timer，再停 cron。否则用户在 5s 内关闭自动同步，
  // timer 仍会触发 commit+push。
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (cronJob) {
    cronJob.stop()
    cronJob = null
  }
  started = false
  state.autoEnabled = false
  consecutiveFailures = 0
  broadcastState('idle')
  log.info('[git-auto] stopped')
}

/**
 * 应用设置变更时由 IPC handler 调用，重启调度器以应用新间隔
 *
 * R11 修复 (medium #31)：原版 stopAutoSync() 后立刻 startAutoSync()，但没等
 * syncInFlight 完成 —— 如果旧的 cron tick 正在跑 commit+push，新 cron 启动后
 * 下一次 tick 仍可能和旧操作撞上 .git/index。现在先 await syncInFlight 让旧
 * 同步完成（或超时放弃），再 stop+start。
 */
export async function restartAutoSync(): Promise<void> {
  if (syncInFlight) {
    log.info('[git-auto] restart: waiting for in-flight sync to finish')
    try {
      await syncInFlight
    } catch (_) {
      // runOnceInternal 不会抛；保险起见吞掉
    }
  }
  stopAutoSync()
  await startAutoSync()
}

/**
 * 手动触发一次同步（UI 上的"立即同步"按钮）
 *
 * R7G-2 修复：若已有同步在跑，直接复用其 promise，不发起新的 commit+push。
 * 这样 cron tick + 手动点击不会撞 .git/index。
 *
 * R11 修复 (critical #3)：把 GIT_AUTO_COMMIT_PUSH 也通过本入口，commit+push 不再
 * 绕过 syncInFlight 锁。messageOverride 允许 IPC 端传入自定义 commit message。
 */
export async function runOnceNow(messageOverride?: string): Promise<{
  ok: boolean
  error?: string
  sha?: string | null
}> {
  if (syncInFlight) {
    log.info('[git-auto] runOnceNow: joining in-flight sync')
    return syncInFlight
  }
  syncInFlight = runOnceInternal(true, messageOverride).finally(() => {
    syncInFlight = null
  })
  return syncInFlight
}

/**
 * 调度器 / 手动按钮共用实现
 *
 * 调用方应通过 runOnceNow() 入口（手动）或 cron tick（自动）触发；本函数
 * 自身不做并发控制（protect + 手动入口已加 in-flight 锁）。
 */
async function runOnceInternal(
  reportToUi = false,
  messageOverride?: string,
): Promise<{ ok: boolean; error?: string; sha?: string | null }> {
  const settings = await readSettings()
  const dir = settings.libraryPath
  if (!dir) {
    const msg = 'libraryPath is empty'
    state.lastError = msg
    if (reportToUi) emit('error', { message: msg })
    return { ok: false, error: msg }
  }

  // R18 修复 (high security)：commit+push 前先 assertRemoteSafe —— 这步
  // 拦截 cron tick + 5s 初始 timer + 手动立即同步 + IPC_AUTO_COMMIT_PUSH
  // 全部入口；任何入口想绕过同步安全闸门都必须直接调 commitAndPush，
  // 而 runOnceNow 是唯一的官方入口。
  try {
    await assertRemoteSafe(dir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.lastError = msg
    log.error(`[git-auto] remote safety check failed: ${msg}`)
    if (reportToUi) emit('error', { message: msg, kind: 'security' })
    return { ok: false, error: msg }
  }

  broadcastState('committing')
  emit('start', { phase: 'committing', at: new Date().toISOString() })

  try {
    // 先检查 status（避免无变更 commit 产生噪音 commit）
    const status = await getStatus(dir)

    if (!status.dirty) {
      // 工作区干净 — 无变更可同步
      state.phase = 'idle'
      state.lastError = null
      state.lastSyncAt = new Date().toISOString()
      broadcastState('idle')
      emit('end', { ok: true, noop: true })
      return { ok: true, sha: null }
    }

    // 有变更 → commit + push（合并原子操作）
    broadcastState('pushing')
    emit('start', { phase: 'pushing', at: new Date().toISOString() })
    const result = await commitAndPush(
      dir,
      messageOverride ?? defaultCommitMessage(),
    )
    // R11 修复 (high #9)：commitAndPush 现在区分 committed/pushed/sha 三种信号。
    // 如果本地 commit 成功但 push 失败（如网络中断 / 远端拒绝），仍要把这次
    // 失败计入 consecutiveFailures → 达到上限会暂停自动同步提醒用户。
    if (result.committed && !result.pushed) {
      const msg = `commit ${String(result.sha ?? '').slice(0, 7)} succeeded but push failed`
      state.lastError = msg
      consecutiveFailures++
      log.warn(`[git-auto] ${msg} (consecutive=${consecutiveFailures})`)
      broadcastState('idle')
      emit('error', {
        message: msg,
        kind: 'network',
        at: new Date().toISOString(),
      })
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.warn(`[git-auto] reached max consecutive failures, pausing`)
        stopAutoSync()
      }
      return { ok: false, error: msg, sha: result.sha }
    }
    state.lastSyncAt = new Date().toISOString()
    state.lastError = null
    consecutiveFailures = 0
    state.phase = 'idle'
    broadcastState('idle')
    emit('end', { ok: true, sha: result.sha })
    return { ok: true, sha: result.sha }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.lastError = msg
    state.phase = 'idle'
    consecutiveFailures++
    log.error(`[git-auto] sync failed (consecutive=${consecutiveFailures}): ${msg}`)
    broadcastState('idle')
    emit('error', {
      message: msg,
      kind: err instanceof GitError ? err.kind : 'other',
      at: new Date().toISOString(),
    })

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log.warn(`[git-auto] reached max consecutive failures, pausing`)
      stopAutoSync()
    }
    return { ok: false, error: msg }
  }
}

/**
 * 读取当前内部状态（用于 IPC handler 同步给新连接的渲染端）
 */
export function getSyncState(): GitSyncState {
  return { ...state, phase: state.phase }
}

/**
 * 是否已启动
 */
export function isAutoSyncStarted(): boolean {
  return started
}
