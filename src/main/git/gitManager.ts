/**
 * Git 操作封装（基于 isomorphic-git）
 *
 * 职责：
 *   - 将 isomorphic-git 的命令式 API 封装为 Promise-based 工具函数
 *   - 提供 init / status / pull / push / commit / log 等常用操作
 *   - 与 auth.ts 配合，从 keychain 注入凭据
 *
 * 设计要点：
 *   - fs adapter 使用 Node fs（不在渲染端调用）
 *   - http auth 通过 onAuth 回调注入 PAT
 *   - 所有 IO 操作集中在文件顶层导入，便于测试 mock
 */
import fs from 'node:fs'
import path from 'node:path'
import { promises as dns } from 'node:dns'
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import type {
  GitStatusInfo,
  GitLogEntry,
  GitRemoteInfo,
} from '@shared/ipc/channels'
import log from '../log'
import { resolveAuth } from './auth'

/** 默认分支名（初始化仓库时使用） */
const DEFAULT_BRANCH = 'main'

/** 默认的 commit author */
const DEFAULT_AUTHOR = { name: 'TaskPilot', email: 'taskpilot@local' }

/** 默认远端名 */
const DEFAULT_REMOTE = 'origin'

/**
 * 包装后的 Git 错误（便于上层区分网络/权限/未初始化）
 */
export class GitError extends Error {
  /** 错误分类 */
  readonly kind: 'not-repo' | 'no-remote' | 'no-token' | 'network' | 'conflict' | 'other'
  constructor(kind: GitError['kind'], message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'GitError'
    this.kind = kind
  }
}

/**
 * 检测指定目录是否已是 Git 仓库
 *
 * 通过检查 `.git` 入口（目录或文件，worktree 场景下是文件）来判断。
 * 这是 isomorphic-git 文档推荐的轻量探测方式。
 */
export async function isRepo(dir: string): Promise<boolean> {
  try {
    const gitdir = `${dir}${path.sep}.git`
    // `.git` 可能是目录（普通仓库）或文件（gitlink / worktree）
    const stat = await fs.promises.stat(gitdir)
    return stat.isDirectory() || stat.isFile()
  } catch (_) {
    return false
  }
}

/**
 * 初始化一个空仓库（不自动 commit、不设置 remote）
 * 重复初始化是幂等的：若已存在 .git 则跳过
 */
export async function initRepo(dir: string, branch = DEFAULT_BRANCH): Promise<void> {
  const existed = await isRepo(dir)
  if (existed) {
    log.info(`[git] repo already initialized at: ${dir}`)
    return
  }
  await git.init({ fs, dir, defaultBranch: branch })
  log.info(`[git] repo initialized at: ${dir} (branch=${branch})`)
}

/**
 * 读取远程仓库 URL（origin），未设置则返回 null
 */
export async function getRemote(dir: string, remote = DEFAULT_REMOTE): Promise<GitRemoteInfo | null> {
  try {
    const url = await git.getConfig({ fs, dir, path: `remote.${remote}.url` })
    if (!url) return null
    return { remote, url }
  } catch (_) {
    return null
  }
}

/**
 * 设置远程地址
 */
export async function setRemote(
  dir: string,
  url: string,
  remote = DEFAULT_REMOTE,
): Promise<void> {
  await git.addRemote({ fs, dir, remote, url, force: true })
  log.info(`[git] remote '${remote}' set to: ${url}`)
}

/**
 * 构造受限的 onAuth 回调
 *
 * isomorphic-git 会把每个实际请求的 URL 交给 onAuth，包括重定向后的目标。
 * 无条件返回 token 意味着任何一次跳转（或一个被篡改的 remote）都能把 PAT
 * 带到第三方主机。这里只在“https + 主机与配置的 remote 完全一致”时才放行凭据。
 */
// isomorphic-git 的 AuthCallback 允许返回 Promise<GitAuth | void>（见
// node_modules/isomorphic-git/index.d.ts:535），DNS 防护需要 dns.lookup 的
// async 结果，所以此处签名必须声明为 Promise 返回类型。
function makeOnAuth(
  remoteUrl: string,
  token: string | null,
): (url: string) => Promise<{
  username?: string
  password?: string
}> {
  let expectedHost: string | null = null
  try {
    expectedHost = new URL(remoteUrl).hostname.toLowerCase()
  } catch (_) {
    expectedHost = null
  }

  // R23 修复 (medium security)：原版仅词法比对 hostname，无法挡住 DNS rebinding
  // 期间 isomorphic-git 跟随 301 跳转到 attacker.tld 的子域（主机名变了会拒）
  // 但请求本身仍到 attacker 的 IP + 用 GET/HEAD 泄露的 .git/objects 写入路径
  // 受攻击者控制。在每次实际请求时再解析一次 target.hostname，把所有返回 IP
  // 与调用 assertHostnameStillPublic 时拿到的"安全 IP 集"对比，不在白名单
  // 的 IP 一律拒绝带凭据。
  // 注意：resolveAndValidateIps 是 best-effort —— DNS 失败 / 解析慢（>2s）
  // 走兜底「无 ip 集合 → 拒绝带凭据」（fail-closed）。
  let safeIps: Set<string> | null = null
  let safeIpsStamp = 0
  const SAFE_IPS_TTL_MS = 60_000

  async function refreshSafeIps(): Promise<void> {
    if (!expectedHost) return
    if (safeIps && Date.now() - safeIpsStamp < SAFE_IPS_TTL_MS) return
    try {
      const addrs = await dns.lookup(expectedHost, { all: true })
      const ips = new Set<string>()
      for (const a of addrs) ips.add(a.address)
      safeIps = ips
      safeIpsStamp = Date.now()
    } catch (err) {
      log.warn(`[git] failed to resolve ${expectedHost} for auth gating:`, err)
      safeIps = null // fail-closed
    }
  }

  return async (url: string) => {
    if (!token) return {}
    let target: URL
    try {
      target = new URL(url)
    } catch (_) {
      return {}
    }
    if (target.protocol !== 'https:') {
      log.warn(`[git] credentials withheld: non-https target (${target.protocol})`)
      return {}
    }
    if (!expectedHost || target.hostname.toLowerCase() !== expectedHost) {
      log.warn(`[git] credentials withheld: host mismatch (${target.hostname} != ${expectedHost})`)
      return {}
    }
    // DNS rebinding 防护：每次 onAuth 触发都重新解析，校验 IP 集合
    await refreshSafeIps()
    if (!safeIps || safeIps.size === 0) {
      log.warn(
        `[git] credentials withheld: no resolvable IPs for ${expectedHost} (fail-closed)`,
      )
      return {}
    }
    let targetIps: string[]
    try {
      const addrs = await dns.lookup(target.hostname, { all: true })
      targetIps = addrs.map((a) => a.address)
    } catch (err) {
      log.warn(
        `[git] credentials withheld: failed to resolve target ${target.hostname}:`,
        err,
      )
      return {}
    }
    const allPublic = targetIps.every((ip) => safeIps!.has(ip))
    if (!allPublic) {
      log.error(
        `[git] credentials withheld: target ${target.hostname} resolved to ${targetIps.join(',')} which is not in trusted IP set {${[...safeIps].join(',')}}`,
      )
      return {}
    }
    return { username: token, password: token }
  }
}

/**
 * 获取仓库状态概览
 *
 * 字段含义：
 *   ahead: 本地领先远端的提交数
 *   behind: 远端领先本地的提交数
 *   modified: 工作区相对 HEAD 有改动的文件
 *   untracked: 工作区未跟踪的新文件
 */
export async function getStatus(dir: string): Promise<GitStatusInfo> {
  const repo = await isRepo(dir)
  if (!repo) {
    return {
      ahead: 0,
      behind: 0,
      modified: [],
      untracked: [],
      deleted: [],
      conflicted: [],
      dirty: false,
      currentSha: null,
      hasRemote: false,
    }
  }

  // 当前 HEAD SHA（可能为 null — 全新仓库无任何 commit）
  let currentSha: string | null = null
  try {
    currentSha = await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch (_) {
    currentSha = null
  }

  // 工作区相对 HEAD 的变更矩阵（复用 getLocalStatus 的本地扫描实现）
  const local = await getLocalStatus(dir)
  const { modified, untracked, deleted, conflicted } = local

  // 远端对比（仅当存在 remote 时才尝试）
  let ahead = 0
  let behind = 0
  let hasRemote = false
  const remote = await getRemote(dir)
  if (remote && currentSha) {
    hasRemote = true
    try {
      const token = await resolveAuth()
      await git.fetch({
        fs,
        http,
        dir,
        singleBranch: true,
        onAuth: makeOnAuth(remote.url, token),
      })
      const localRef = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null)
      const remoteRef = await git
        .resolveRef({ fs, dir, ref: `refs/remotes/${remote.remote}/${DEFAULT_BRANCH}` })
        .catch(() => null)
      if (localRef && remoteRef) {
        ahead = await countCommits({ fs, dir, from: remoteRef, to: localRef })
        behind = await countCommits({ fs, dir, from: localRef, to: remoteRef })
      }
    } catch (err) {
      // 远端查询失败不影响本地 dirty 检测；仅记录日志
      log.warn(`[git] status remote compare failed: ${(err as Error).message}`)
    }
  }

  // R11 修复 (high #8)：dirty 表示"工作区有待提交的变更"，**不应包含 ahead**。
  // 原版 ahead > 0 也算 dirty → 每次 cron tick 都把"本地领先远端的提交"
  // 当成有新工作区改动，commit() 跑一遍发现空 modified/untracked 抛
  // NothingToCommitError，consecutiveFailures++ → 3 次后自动停止同步。
  // 现在 dirty 仅反映 working tree vs HEAD（modified/untracked/deleted/conflicted），
  // ahead 单独由 commitAndPush 的 push 阶段处理。
  const dirty =
    modified.length > 0 ||
    untracked.length > 0 ||
    deleted.length > 0 ||
    conflicted.length > 0
  return { ahead, behind, modified, untracked, deleted, conflicted, dirty, currentSha, hasRemote }
}

/**
 * 统计 from..to 之间的提交数
 */
async function countCommits(args: {
  fs: typeof fs
  dir: string
  from: string
  to: string
}): Promise<number> {
  try {
    const commits = await git.log({
      fs: args.fs,
      dir: args.dir,
      ref: args.to,
      depth: 1000,
    })
    let count = 0
    for (const c of commits) {
      if (c.oid === args.from) break
      count++
    }
    return count
  } catch (_) {
    return 0
  }
}

/**
 * 工作区 vs HEAD 的本地状态（不发起网络 fetch）
 *
 * 与 getStatus() 不同：本函数只扫描 working tree 与 index，不调用 git.fetch，
 * 也不会取 ahead/bebehind。commit() 等"只关心本地 dirty"的操作应该用这个，
 * 避免每次 commit 都打一次远端（offline 时直接抛 network 错 → commit 失败）。
 */
export async function getLocalStatus(dir: string): Promise<{
  modified: string[]
  untracked: string[]
  deleted: string[]
  conflicted: string[]
  dirty: boolean
}> {
  if (!(await isRepo(dir))) {
    throw new GitError('not-repo', `not a git repository: ${dir}`)
  }
  const matrix = await git.statusMatrix({ fs, dir })
  const modified: string[] = []
  const untracked: string[] = []
  const deleted: string[] = []
  const conflicted: string[] = []
  for (const [filepath, , workdir, stage] of matrix) {
    if (stage === 0 && workdir === 0) continue
    // isomorphic-git 的 WorkdirStatus / StageStatus 是字面量联合类型（0|1|2|3），
    // 但 TS 把它们收窄为窄字面量。这里用 typeof === 0/1/2/3 比较会被推断为
    // 「与字面量 3 不可能重叠」，改为 (workdir as number) === 3 强制当数字比较。
    if ((workdir as number) === 3 || (stage as number) === 3) {
      conflicted.push(filepath)
      continue
    }
    if (stage === 0 && workdir === 2) {
      untracked.push(filepath)
      continue
    }
    if (workdir === 0) {
      deleted.push(filepath)
      continue
    }
    modified.push(filepath)
  }
  const dirty =
    modified.length > 0 ||
    untracked.length > 0 ||
    deleted.length > 0 ||
    conflicted.length > 0
  return { modified, untracked, deleted, conflicted, dirty }
}

/**
 * 将所有变更（modified + untracked + deleted）add 并提交
 *
 * R11 修复 (medium #35)：原版 commit() 内调 getStatus(dir)，而 getStatus 在存在
 * remote 的情况下会调 git.fetch —— 每次本地 commit 都要先发网络请求，offline
 * 状态下 commit 永远失败（network err 而非 nothing-to-commit）。改为调
 * getLocalStatus(dir) 只扫本地矩阵，不发 fetch。
 *
 * @returns 提交 SHA；若无任何变更返回 null
 */
export async function commit(
  dir: string,
  message: string,
  author: { name: string; email: string } = DEFAULT_AUTHOR,
): Promise<string | null> {
  if (!(await isRepo(dir))) {
    throw new GitError('not-repo', `not a git repository: ${dir}`)
  }

  const status = await getLocalStatus(dir)
  if (!status.dirty) {
    log.info('[git] commit skipped: working tree clean')
    return null
  }

  // 把所有变更文件加入 index（modified + untracked + 删除）
  const all = Array.from(
    new Set([...status.modified, ...status.untracked, ...status.deleted]),
  )
  for (const filepath of all) {
    await git.add({ fs, dir, filepath })
  }

  const sha = await git.commit({
    fs,
    dir,
    message,
    author,
  })
  log.info(`[git] committed ${sha.slice(0, 7)}: ${message}`)
  return sha
}

/**
 * 拉取远端变更（ff-only 优先；非快进时抛错由调用方决定 merge / rebase）
 *
 * 流程：fetch → merge（fast-forward only）
 */
export async function pull(dir: string): Promise<{ oid: string; summary: string } | null> {
  if (!(await isRepo(dir))) {
    throw new GitError('not-repo', `not a git repository: ${dir}`)
  }
  const remote = await getRemote(dir)
  if (!remote) {
    throw new GitError('no-remote', 'no remote configured')
  }

  try {
    const token = await resolveAuth()
    await git.fetch({
      fs,
      http,
      dir,
      singleBranch: true,
      onAuth: makeOnAuth(remote.url, token),
    })
    // fast-forward merge
    const result = await git.merge({
      fs,
      dir,
      theirs: remote.remote,
      fastForwardOnly: true,
    })
    log.info(`[git] pulled from ${remote.remote}: ${JSON.stringify(result)}`)
    return {
      oid: (result as { oid?: string }).oid ?? '',
      summary: (result as { mergeCommit?: { message?: string } }).mergeCommit?.message ?? 'fast-forward',
    }
  } catch (err) {
    throw mapGitError(err, 'pull')
  }
}

/**
 * 推送本地提交到远端
 *
 * R11 修复 (medium #34)：原版硬编码 ref: 'main'，但用户可能在 'master' / 'develop' /
 * 自定义分支 —— hardcoded 'main' 会让 isomorphic-git 找不到本地 ref 而抛错。
  这里改成查询 currentBranch()，detached HEAD 时降级回 DEFAULT_BRANCH。
 */
export async function push(dir: string): Promise<void> {
  if (!(await isRepo(dir))) {
    throw new GitError('not-repo', `not a git repository: ${dir}`)
  }
  const remote = await getRemote(dir)
  if (!remote) {
    throw new GitError('no-remote', 'no remote configured')
  }

  let branchToPush = DEFAULT_BRANCH
  try {
    const cur = await git.currentBranch({ fs, dir })
    if (cur && cur !== 'HEAD') branchToPush = cur
  } catch (err) {
    log.warn(`[git] push: currentBranch failed, fallback to ${DEFAULT_BRANCH}:`, (err as Error).message)
  }

  try {
    const token = await resolveAuth()
    await git.push({
      fs,
      http,
      dir,
      remote: remote.remote,
      ref: branchToPush,
      onAuth: makeOnAuth(remote.url, token),
    })
    log.info(`[git] pushed to ${remote.remote}/${branchToPush}`)
  } catch (err) {
    throw mapGitError(err, 'push')
  }
}

/**
 * 提交 → 推送（自动同步主流程）
 *
 * 失败时若已 commit 成功会保留本地提交，由用户决定重试
 *
 * R11 修复 (high #9)：原版 sha === null 时返回 { pushed: true } 但根本没调
 * push —— 误报"已推送"，用户以为本地提交已落到远端，实际 still unpushed。
 * 现在明确区分：未 commit → committed:false, pushed:false；commit 成功但
 * push 失败 → committed:true, pushed:false；两者都成功 → committed:true,
 * pushed:true。让上层能据此渲染正确的状态徽章。
 */
export async function commitAndPush(dir: string, message: string): Promise<{
  committed: boolean
  pushed: boolean
  sha: string | null
}> {
  const sha = await commit(dir, message)
  if (!sha) {
    // 无变更：committed=false, pushed=false（明确表示"没推"而非"推成功"）
    return { committed: false, pushed: false, sha: null }
  }
  try {
    await push(dir)
    return { committed: true, pushed: true, sha }
  } catch (err) {
    return { committed: true, pushed: false, sha }
  }
}

/**
 * 读取最近 N 条提交记录
 */
export async function getLog(dir: string, depth = 20): Promise<GitLogEntry[]> {
  if (!(await isRepo(dir))) {
    return []
  }
  try {
    // R28-Corr-2 修复 (medium correctness)：原版硬编码 `ref: DEFAULT_BRANCH`
    // ('main')，与 push() 已经在用的 currentBranch() 模式不一致 —— 仓库
    // 默认分支是 'master' / 自定义分支时返回空列表，IPC handler 把空数
    // 组 bubble 成错误。改为先 query currentBranch，detached HEAD 或失败
    // 时降级 DEFAULT_BRANCH（与 push 同模式）。
    let ref = DEFAULT_BRANCH
    try {
      const cur = await git.currentBranch({ fs, dir })
      if (cur) ref = cur
    } catch (err) {
      log.warn(
        `[git] log: currentBranch failed, fallback to ${DEFAULT_BRANCH}:`,
        (err as Error).message,
      )
    }
    const commits = await git.log({ fs, dir, depth, ref })
    return commits.map((c) => ({
      sha: c.oid,
      message: c.commit.message,
      author: {
        name: c.commit.author.name,
        email: c.commit.author.email,
      },
      date: new Date(c.commit.author.timestamp * 1000).toISOString(),
    }))
  } catch (err) {
    log.warn(`[git] log failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * 探测网络连通性（通过 fetch 是否抛错判断）
 */
export async function pingRemote(dir: string): Promise<boolean> {
  if (!(await isRepo(dir))) return false
  const remote = await getRemote(dir)
  if (!remote) return false
  try {
    const token = await resolveAuth()
    await git.fetch({
      fs,
      http,
      dir,
      singleBranch: true,
      onAuth: makeOnAuth(remote.url, token),
    })
    return true
  } catch (_) {
    return false
  }
}

/**
 * 把 isomorphic-git 抛出的错误归类为 GitError
 */
function mapGitError(err: unknown, op: string): GitError {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('NotFoundError') || msg.includes('not found')) {
    return new GitError('not-repo', `${op}: ${msg}`, err)
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('Authentication')) {
    return new GitError('no-token', `${op}: 认证失败 — 请检查 Git Token`, err)
  }
  if (
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout')
  ) {
    return new GitError('network', `${op}: 网络错误 — ${msg}`, err)
  }
  if (msg.includes('MergeNotSupportedError') || msg.includes('conflict')) {
    return new GitError('conflict', `${op}: 存在冲突需要手动合并 — ${msg}`, err)
  }
  return new GitError('other', `${op}: ${msg}`, err)
}
