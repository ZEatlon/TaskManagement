/**
 * Git 同步相关 IPC 处理器
 *
 * 通道清单（与 src/shared/ipc/channels.ts 同步）：
 *   - git:is-repo         是否 Git 仓库
 *   - git:status          仓库状态概览
 *   - git:init            初始化仓库（幂等）
 *   - git:commit          提交（add + commit）
 *   - git:pull            拉取远端（fast-forward only）
 *   - git:push            推送到远端
 *   - git:log             最近 N 条提交
 *   - git:remote-get      获取 remote URL
 *   - git:remote-set      设置 remote URL
 *   - git:sync-now        立即触发一次自动同步流程
 *   - git:auto-start      启用自动同步
 *   - git:auto-stop       停止自动同步
 *   - git:auto-restart    重启自动同步（设置变更后）
 *   - git:state           读取当前同步状态
 *
 * 注意：
 *   所有调用都会先验证 settings.libraryPath 是否存在，
 *   避免在未初始化库时执行 git 命令。
 */
import { handle } from './channels'
import { settingsRepo } from '../db/repositories/settings'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import type {
  GitStatusInfo,
  GitLogEntry,
  GitRemoteInfo,
  GitSyncState,
} from '@shared/ipc/channels'
import log from '../log'
import {
  isRepo,
  getStatus,
  initRepo,
  commit,
  pull,
  push,
  getLog,
  getRemote,
  setRemote,
} from '../git/gitManager'
import { clearAuthCache } from '../git/auth'
import {
  startAutoSync,
  stopAutoSync,
  restartAutoSync,
  runOnceNow,
  getSyncState,
  isAutoSyncStarted,
} from '../git/autoSync'
import { isBlockedHostname, assertHostnameStillPublic } from '../lib/networkSafety'

/** settings 表中 AppSettings 的 key */
const SETTINGS_KEY = 'app.settings'

/**
 * git:log depth 上限：renderer 单次最多看 500 条提交。
 *
 * 防御场景：被攻陷的渲染端（XSS / 恶意 dev dep / window.api hijacker）
 * 调 `window.api.git.log(1e9)`，让 isomorphic-git 在主进程事件循环里
 * 走完整提交历史 → CPU + 内存被占满 → UI 卡死 + 自动同步被阻塞。
 * 500 足够覆盖任意正常使用（commit history 浏览 / 渲染）。
 */
const MAX_LOG_DEPTH = 500
const DEFAULT_LOG_DEPTH = 20

/** commit message 字节上限（8 KiB；git 自身的「良好实践」上限） */
const MAX_COMMIT_MESSAGE_BYTES = 8 * 1024

/**
 * R-Fix-GIT_AUTO_COMMIT_PUSH-input-validation (high security)：
 * git:auto-commit-push 此前把 IPC args.message 直接透传给 runOnceNow，
 * 绕过了 git:commit 在 IPC 边界做的 8 KiB 字节上限 + CR/Tab 清洗。
 * 后果：被攻陷的渲染端可发 {message: 'A'.repeat(50_000_000)} 写一个
 * 多 MB 的 commit object（IO + 内存爆），或在 message 里塞 CR / 竖向制表
 * 符污染 git log 显示。统一在 helper 里做校验，GIT_COMMIT 和
 * GIT_AUTO_COMMIT_PUSH 两入口都走它（runOnceNow 还会把 message 透传给
 * commitAndPush → 同样的 commit() 调用被两条 IPC 路径触发）。
 */
function sanitizeCommitMessage(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('commit message must be a string')
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_COMMIT_MESSAGE_BYTES) {
    throw new Error(
      `commit message exceeds ${MAX_COMMIT_MESSAGE_BYTES} bytes (got ${bytes})`,
    )
  }
  // 去掉 CR / Tab —— 多行 message 保留 LF（subject 空行 body 是合法格式）
  return raw.replace(/[\r\t]+/g, ' ')
}

/**
 * 允许的远端协议。
 *
 * 只允许 https / ssh：
 *   - http 明文会把 PAT 以 Basic Auth 头发到未加密信道
 *   - git:// 无认证无加密
 *   - file:// / ext:: 等可被用来触发本地命令或读取任意路径
 */
const ALLOWED_REMOTE_PROTOCOLS = new Set(['https:', 'ssh:'])

/** scp 风格 SSH 地址：git@github.com:owner/repo.git（非合法 URL，需要先归一化） */
const SCP_LIKE_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):(?!\/)(.+)$/

/** 触发“远端主机变更需确认”时抛出的错误标记，渲染端据此弹出二次确认 */
export const REMOTE_HOST_CHANGE_MARKER = 'REMOTE_HOST_CHANGE_REQUIRES_CONFIRMATION'

/**
 * 把 scp 风格地址归一化为 ssh:// URL，其它原样返回
 */
function normalizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim()
  const m = SCP_LIKE_RE.exec(trimmed)
  if (m) return `ssh://${m[1]}@${m[2]}/${m[3]}`
  return trimmed
}

/**
 * 校验并归一化远端 URL
 *
 * 背景（安全）：gitManager 的 onAuth 回调会把 keychain 中的 PAT 交给
 * isomorphic-git 发往 remote 指定的任意主机。若此处不做校验，
 * 一个被写入的恶意 remote 就等同于 token 外泄。
 *
 * isBlockedHostname 已抽取到 ../lib/networkSafety.ts，setting-handlers 也
 * 复用，避免两份实现漂移。
 *
 * @returns 归一化后的 URL 与其主机名
 */
async function validateRemoteUrl(raw: unknown): Promise<{ url: string; host: string }> {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('remote url is required')
  }
  const normalized = normalizeRemoteUrl(raw)

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch (_) {
    throw new Error(`invalid remote url: ${raw}`)
  }

  if (!ALLOWED_REMOTE_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `unsupported remote protocol '${parsed.protocol}' — only https:// and ssh:// are allowed`,
    )
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(
      `remote host '${parsed.hostname}' is not allowed (loopback / link-local / private address)`,
    )
  }

  // R21 修复 (critical security)：原版只做词法校验（nip.io / sslip.io /
  // lvh.me 等公共 wildcard DNS 解析到内网可绕过）。现在 await DNS 解析并
  // 校验每个 A/AAAA 记录都不是 blocked；同 setting-handlers 的 R19 修复
  // 一致。注意：此校验在「写入时」执行；运行时 DNS rebinding（写入合法、
  // 拉取时被中间人改 A 记录）的攻击面见 F21.19 / networkSafety 的
  // 「每次连接重解」加固。
  await assertHostnameStillPublic(parsed.hostname)

  return { url: normalized, host: parsed.hostname.toLowerCase() }
}

/**
 * 取出已有 remote 的主机名（无 remote 或无法解析时返回 null）
 */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(normalizeRemoteUrl(url)).hostname.toLowerCase()
  } catch (_) {
    return null
  }
}

/**
 * R17 修复 (high security)：pull / push / sync-now 前的 remote URL 二次校验。
 * 仓库被 clone 后 .git/config 可被外部进程篡改 —— 在 setRemote 时校验一次
 * 不够，攻击者写库目录后下一次自动同步就把 PAT 静默外泄到内网 / loopback。
 * 这里强制每次 push/pull 前都重新读 .git/config 并过 isBlockedHostname：
 *   - 没有 remote：抛错（push/pull 必然失败，避免静默）
 *   - 主机被判定为 blocked：抛错并阻断 push/pull
 *   - URL 无法解析：抛错（保守策略，避免新发现的 transition 形式绕过）
 */
async function assertRemoteSafe(dir: string): Promise<void> {
  const remote = await getRemote(dir, 'origin')
  if (!remote?.url) {
    throw new Error('git remote is not configured; refusing to push/pull')
  }
  const host = hostOf(remote.url)
  if (!host) {
    throw new Error(`git remote url cannot be parsed: ${remote.url}`)
  }
  if (isBlockedHostname(host)) {
    log.error(
      `[git] refusing push/pull: remote host '${host}' is loopback / private / link-local; ` +
        'this may indicate .git/config tampering',
    )
    throw new Error(
      `git remote host '${host}' is not allowed (loopback / private / link-local)`,
    )
  }
}

/**
 * 读取当前生效 libraryPath
 */
async function getLibraryPath(): Promise<string | null> {
  const all = await settingsRepo.getAll()
  const cfg = (all[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}
  return (cfg.libraryPath as string | null | undefined) ?? null
}

/**
 * 检查 libraryPath 是否可用；不可用时抛错
 */
async function requireLibraryPath(): Promise<string> {
  const p = await getLibraryPath()
  if (!p) throw new Error('libraryPath not configured')
  return p
}

export function registerGitHandlers(): void {
  /** 是否 Git 仓库 */
  handle(IPC_CHANNELS.GIT_IS_REPO, async (): Promise<{ isRepo: boolean }> => {
    const dir = await getLibraryPath()
    if (!dir) return { isRepo: false }
    return { isRepo: await isRepo(dir) }
  })

  /** 仓库状态概览 */
  handle(IPC_CHANNELS.GIT_STATUS, async (): Promise<GitStatusInfo> => {
    const dir = await requireLibraryPath()
    return getStatus(dir)
  })

  /** 初始化仓库（不创建 remote） */
  handle(IPC_CHANNELS.GIT_INIT, async (): Promise<{ ok: true; path: string }> => {
    const dir = await requireLibraryPath()
    await initRepo(dir)
    return { ok: true, path: dir }
  })

  /** 提交（带默认 author） */
  handle(
    IPC_CHANNELS.GIT_COMMIT,
    async (
      _e,
      args: { message: string; author?: { name: string; email: string } },
    ): Promise<{ sha: string | null }> => {
      const dir = await requireLibraryPath()
      // R-Fix-GIT_COMMIT-input-validation (medium)：原版直接透传 args.message
      // 与 args.author 到 gitManager.commit()。被攻陷的渲染端可以：
      //   1) message = 'A'.repeat(50_000_000) → isomorphic-git 写一个
      //      多 MB 的 commit object，IO + 内存压力暴涨；
      //   2) author = { name: 'Coworker', email: 'coworker@corp' } →
      //      伪造 author identity，push 到共享远端后污染协作归因。
      // 在 IPC 边界统一校验：message 走字节上限 + 控制字符清洗（helper
      // 内做），author 永远不接收 —— commit 始终用 server-side 的
      // DEFAULT_AUTHOR，与系统其余部分一致；如未来需要「用户配置身份」，
      // 应来自 server-side settings 表，不是每条 IPC 入参）。
      const sanitized = sanitizeCommitMessage(args?.message)
      const sha = await commit(dir, sanitized)
      return { sha }
    },
  )

  /** 拉取 */
  handle(IPC_CHANNELS.GIT_PULL, async (): Promise<{ ok: true }> => {
    const dir = await requireLibraryPath()
    // R17 修复 (high security)：每次 pull 前重新校验当前 remote URL。
    // 原版只 setRemote 时校验一次 —— 仓库被 clone 后 .git/config 可被外部
    // 进程篡改（任意能写库目录的用户态进程），把 remote 改成内网主机后下
    // 一次 pull 把 Basic Auth header / keychain PAT 静默外泄。这里强制每次
    // 都过 isBlockedHostname。
    await assertRemoteSafe(dir)
    await pull(dir)
    return { ok: true }
  })

  /** 推送 */
  handle(IPC_CHANNELS.GIT_PUSH, async (): Promise<{ ok: true }> => {
    const dir = await requireLibraryPath()
    await assertRemoteSafe(dir)
    await push(dir)
    return { ok: true }
  })

  /** 最近 N 条提交（默认 20） */
  handle(IPC_CHANNELS.GIT_LOG, async (_e, args: { depth?: number }): Promise<GitLogEntry[]> => {
    const dir = await requireLibraryPath()
    // R-Fix-GIT_LOG-depth-unbounded (low)：被攻陷的渲染端可调
    // `git.log(1e9)` 让 isomorphic-git 走完整 commit 历史 → CPU
    // 钉死 + UI 卡死。在 IPC 边界把 depth 钳到 [1, MAX_LOG_DEPTH]；
    // gitManager.getLog 内部还有第二道 clamp 作 defense-in-depth。
    const raw = args?.depth
    const depth =
      typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(MAX_LOG_DEPTH, Math.max(1, Math.floor(raw)))
        : DEFAULT_LOG_DEPTH
    return getLog(dir, depth)
  })

  /** 读取 remote URL */
  handle(IPC_CHANNELS.GIT_REMOTE_GET, async (): Promise<GitRemoteInfo | null> => {
    const dir = await getLibraryPath()
    if (!dir) return null
    return getRemote(dir)
  })

  /**
   * 设置 remote URL
   *
   * 安全约束：
   *   1. 仅接受 https / ssh，且主机不得是回环 / 内网 / link-local 地址
   *   2. 若新主机与现有 remote 主机不同，必须由调用方显式传入
   *      confirmHostChange: true（渲染端应先向用户二次确认），
   *      否则拒绝——换主机意味着 PAT 会被发往一个新的服务器。
   */
  handle(
    IPC_CHANNELS.GIT_REMOTE_SET,
    async (
      _e,
      args: { url: string; remote?: string; confirmHostChange?: boolean },
    ): Promise<{ ok: true }> => {
      // R-fix-git-remote-set-null-args (LOW input-validation-asymmetry)：
      // 原版直接 args.remote ?? 'origin'。IPC 跨信任边界可发 null，被攻
      // 渲染端触发 args === null 时 `args.remote` 抛 TypeError，错误信息
      // 模糊、stack 污染主进程日志。同文件 GIT_COMMIT 已用 args?.message
      // optional chaining 规避；这里同样兜底 + 显式拒绝，错误信息更清晰。
      if (!args || typeof args !== 'object') {
        throw new Error('git:remote-set: args must be object')
      }
      const dir = await requireLibraryPath()
      const remoteName = args.remote ?? 'origin'
      const { url, host } = await validateRemoteUrl(args.url)

      const existing = await getRemote(dir, remoteName)
      const existingHost = hostOf(existing?.url)
      const hostChanged = existing != null && existingHost !== host
      if (hostChanged && args.confirmHostChange !== true) {
        throw new Error(
          `${REMOTE_HOST_CHANGE_MARKER}: remote '${remoteName}' host would change from ` +
            `'${existingHost ?? existing.url}' to '${host}'; explicit user confirmation required`,
        )
      }
      if (hostChanged) {
        log.warn(
          `[git] remote '${remoteName}' host change confirmed: ${existingHost ?? '?'} -> ${host}`,
        )
      }

      await setRemote(dir, url, remoteName)
      // 主机可能已变化：清空 token 缓存，避免旧凭据被带到新远端
      clearAuthCache()
      return { ok: true }
    },
  )

  /** 立即同步（commit + push） */
  handle(
    IPC_CHANNELS.GIT_SYNC_NOW,
    async (): Promise<{ ok: boolean; error?: string; sha?: string | null }> => {
      // R18 修复 (high security)：assertRemoteSafe 已下沉到 autoSync.runOnceInternal
      // （覆盖 cron + 5s 初始 timer + 手动同步 + IPC_AUTO_COMMIT_PUSH 全入口）。
      // 之前 R17 在这里再调一次只是历史遗留 —— 现在去掉避免双重 IO，但
      // 调用方拿到的 result.error 已经包含「remote is not allowed」的报错。
      await requireLibraryPath()
      const result = await runOnceNow()
      return result
    },
  )

  /** 启用自动同步 */
  handle(IPC_CHANNELS.GIT_AUTO_START, async (): Promise<{ ok: true }> => {
    await startAutoSync()
    return { ok: true }
  })

  /** 停止自动同步 */
  handle(IPC_CHANNELS.GIT_AUTO_STOP, async (): Promise<{ ok: true }> => {
    stopAutoSync()
    return { ok: true }
  })

  /** 重启自动同步（设置变更后调用） */
  handle(IPC_CHANNELS.GIT_AUTO_RESTART, async (): Promise<{ ok: true }> => {
    await restartAutoSync()
    return { ok: true }
  })

  /** 读取当前同步状态 */
  handle(IPC_CHANNELS.GIT_STATE, async (): Promise<GitSyncState & { running: boolean }> => {
    return { ...getSyncState(), running: isAutoSyncStarted() }
  })

  /**
   * R-fix-git-tab-broken (critical correctness)：GitTab 的自动推送
   * 配置（gitAutoPushEnabled / gitPushIntervalMinutes）必须通过专用
   * 通道持久化。背景：
   *   - 这两个字段存储在 app.settings（不是 app.git 子文档）；
   *   - 走 setting:set({key:'gitAutoPushEnabled', ...}) 顶层 key
   *     → assertPrivilegedFieldsNotTouched 命中 TOP_LEVEL_KEY_TO_DOC 拒；
   *   - 走 setting:set({key:'app.settings', value:{...gitAutoPushEnabled}})
   *     → assertPrivilegedFieldsNotTouched 命中 PRIVILEGED_FIELDS_BY_DOC.settings 拒；
   *   - 走 setting:set({key:'app.git', value:{...}}) → 拒（app.git 三字段都是 privileged）。
   * 本通道是唯一允许持久化这两个字段的入口：
   *   1. 显式接收 {enabled, intervalMinutes}，不接收其它字段（防御
   *      privilege-escalation：被劫持渲染端不能借此写库目录 / 远端 URL 等）；
   *   2. intervalMinutes 钳到 [1, 59]（与 autoSync 内部的 cron minute
   *      字段合法值范围一致；超出范围静默 clamp 而不是抛错，避免 UI
   *      输入 1440 这类大数时被 catch 后误导用户）；
   *   3. 持久化到 app.settings（merge 到现有 row，保留其它字段）；
   *   4. 持久化后调 restartAutoSync() —— 已开启自动推送但间隔变更需要
   *      重启 cron tick；关闭时不重启，避免把已启动的同步器又拉起来。
   */
  handle(
    IPC_CHANNELS.GIT_SET_CONFIG,
    async (
      _e,
      args: { enabled?: unknown; intervalMinutes?: unknown },
    ): Promise<{ ok: true; enabled: boolean; intervalMinutes: number }> => {
      if (!args || typeof args !== 'object') {
        throw new Error('git:set-config: args must be object')
      }
      // 类型校验：只接受 boolean / number，其它全部抛错（fail-fast，避免
      // 后续 settingsRepo.set 把 undefined / null 误写入 SQLite）。
      let enabled: boolean | undefined
      if (args.enabled !== undefined) {
        if (typeof args.enabled !== 'boolean') {
          throw new Error('git:set-config: enabled must be boolean')
        }
        enabled = args.enabled
      }
      let intervalMinutes: number | undefined
      if (args.intervalMinutes !== undefined) {
        if (typeof args.intervalMinutes !== 'number' || !Number.isFinite(args.intervalMinutes)) {
          throw new Error('git:set-config: intervalMinutes must be number')
        }
        intervalMinutes = Math.min(59, Math.max(1, Math.floor(args.intervalMinutes)))
      }

      const all = await settingsRepo.getAll()
      const current = (all[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}
      const merged: Record<string, unknown> = { ...current }
      if (enabled !== undefined) merged.gitAutoPushEnabled = enabled
      if (intervalMinutes !== undefined) merged.gitPushIntervalMinutes = intervalMinutes
      await settingsRepo.set(SETTINGS_KEY, merged)

      // 关闭时不重启（避免已停的 sync 被拉起）；开启 / 间隔变更 → restart
      // 让 cron tick 立即按新配置生效。
      if (enabled === false) {
        stopAutoSync()
      } else if (enabled === true || intervalMinutes !== undefined) {
        await restartAutoSync()
      }

      return {
        ok: true,
        enabled: Boolean(merged.gitAutoPushEnabled),
        intervalMinutes: Number(merged.gitPushIntervalMinutes),
      }
    },
  )

  // 便捷组合：自动同步一次（commit + push），等价于 sync-now 但语义清晰
  // R11 修复 (critical #3)：原版直接调 commitAndPush，绕过 autoSync 的 syncInFlight
  // 锁。如果用户在手动 "立即同步" 还没返回的瞬间调用本通道、或 cron tick 与本通道
  // 撞上 → 两个 commitAndPush 并发跑，.git/index 加锁竞争，可能损坏 index 也可能
  // push 被远端拒绝为 non-fast-forward。现在改为走 runOnceNow() 复用锁：已有同步
  // 在跑就共享同一个 promise；没在跑就由本通道启动新的。失败时直接抛出，由 handle()
  // 统一记录日志并把错误透传给渲染端。
  handle(
    IPC_CHANNELS.GIT_AUTO_COMMIT_PUSH,
    async (_e, args: { message: string }): Promise<{ ok: true; sha: string | null }> => {
      // R-Fix-GIT_AUTO_COMMIT_PUSH-input-validation (high security)：
      // 复用 sanitizeCommitMessage helper —— 此入口此前直接透传
      // args.message 到 runOnceNow，绕过字节上限 + CR/Tab 清洗，与
      // git:commit 形成 handler-to-handler 不一致。现在两入口共用
      // 同一道闸门；runOnceNow 在 cron / 5s 初始 timer 路径里不接收
      // 外部 message，所以这条 helper 只覆盖 IPC 入口，cron tick 用
      // defaultCommitMessage() 走纯 server-side 字符串，本身安全。
      const sanitized = sanitizeCommitMessage(args?.message)
      const result = await runOnceNow(sanitized)
      if (!result.ok) {
        throw new Error(result.error ?? 'git auto commit+push failed')
      }
      return { ok: true, sha: result.sha ?? null }
    },
  )
}
