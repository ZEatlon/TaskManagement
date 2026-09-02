/**
 * Git 认证 / 凭据解析
 *
 * 职责：
 *   - 从 safeStorage keychain 读取用户保存的 Git Token
 *   - 解析已配置的 remote URL，自动判断是否需要注入凭据
 *   - 提供给 gitManager 的 onAuth 回调使用
 *
 * 凭据约定：
 *   - keychain 中存储在 'git.token' 键下（见 security/keychain.ts）
 *   - 同时支持 GitHub PAT（ghp_/github_pat_）与 GitLab PAT
 *   - 远程 URL 若已含凭据（https://x-access-token:TOKEN@host/repo.git）则不重复注入
 *
 * R12 修复 (high)：原版 cachedToken 在模块作用域缓存 PAT 明文，zeroizeString
 * 是 no-op（V8 字符串不可变 + 共享）。任何 V8 heap snapshot（--inspect、
 * 内存泄漏漏洞）都能拿到明文 PAT。现在改为：只在调用栈栈帧中保留 token，
 * 不缓存到模块级。resolveAuth() 每次都从 keychain 读 —— 性能成本可接受
 * （safeStorage decryptAsync 约 0.5ms，且 push/pull/fetch 不在热路径）。
 * 若后续要做性能优化，应该用 Buffer.alloc + 显式 fill(0)，而不是模块变量。
 */
import { getSecret, SECRET_KEYS } from '../security/keychain'
import log from '../log'

/** 已知的 PAT 前缀（用于区分服务提供商） */
const GITHUB_PAT_PREFIXES = ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_']
const GITLAB_PAT_PREFIXES = ['glpat-']

/** 远程 URL 中可能内嵌的凭据前缀 */
const EMBEDDED_TOKEN_HOSTS = ['x-access-token', 'oauth2']

/**
 * 读取 Token（每次都从 keychain 解密一次，不缓存）
 *
 * 返回 null 而非抛出，让调用方自行决定是警告还是降级为本地操作。
 *
 * 注意：返回的 token 字符串仅在调用栈中存活；函数返回后若调用方不再持有，
 * V8 GC 会回收底层 buffer。没有模块级缓存意味着任何 V8 heap snapshot 都
 * 不会稳定显示 token —— 攻击窗口从「全程可读」收敛到「调用瞬间可读」。
 */
export async function resolveAuth(): Promise<string | null> {
  try {
    const token = await getSecret(SECRET_KEYS.GIT_TOKEN)
    return token ?? null
  } catch (err) {
    log.warn(`[git-auth] failed to read token: ${(err as Error).message}`)
    return null
  }
}

/**
 * 主动清除内存缓存（token 变更 / 删除时由 IPC handler 调用）
 *
 * R12 修复 (high)：模块级缓存已移除，本函数保留作 no-op 兼容旧调用方
 * （git-handlers.ts 在 setRemote 主机变化后调用）。保留接口签名以免破坏
 * 其它 IPC 路径。
 */
export function clearAuthCache(): void {
  // no-op: 模块级缓存已移除（见文件顶部说明）
}

/** 在 stopAutoSync / dispose 之类路径调一下，把缓存里的 token 抹掉
 *
 * 同样为兼容旧调用方保留；当前实现无缓存可清。
 */
export function disposeAuth(): void {
  clearAuthCache()
}

/**
 * 推断 Token 所属平台（用于 UI 提示与日志）
 */
export function inferTokenProvider(token: string | null): 'github' | 'gitlab' | 'unknown' {
  if (!token) return 'unknown'
  for (const p of GITHUB_PAT_PREFIXES) {
    if (token.startsWith(p)) return 'github'
  }
  for (const p of GITLAB_PAT_PREFIXES) {
    if (token.startsWith(p)) return 'gitlab'
  }
  return 'unknown'
}

/**
 * 解析远程 URL，判断是否已嵌入凭据
 *
 * 返回：
 *   - isPrivate: true 表示 URL 中已含 x-access-token:...@host（私有仓库直连）
 *   - cleanedUrl: 去掉凭据后的纯 URL（用于显示）
 */
export function parseRemoteUrl(url: string): { isPrivate: boolean; cleanedUrl: string } {
  if (!url) return { isPrivate: false, cleanedUrl: '' }
  try {
    const u = new URL(url)
    if (u.username) {
      const isEmbedded = EMBEDDED_TOKEN_HOSTS.includes(u.username)
      if (isEmbedded) {
        u.username = ''
        u.password = ''
        return { isPrivate: true, cleanedUrl: u.toString() }
      }
    }
    return { isPrivate: false, cleanedUrl: url }
  } catch (_) {
    // 非合法 URL（ssh:// 或 scp 形式）原样返回
    return { isPrivate: false, cleanedUrl: url }
  }
}

/**
 * 为给定的远程 URL 构造一个携带 token 的 URL（仅用于展示 / 测试连通性）
 *
 * 注意：isomorphic-git 的 onAuth 回调更安全，请优先使用 resolveAuth()。
 * 本函数仅在需要把 token 嵌入 URL 的边缘场景使用（如裸 curl 测试）。
 *
 * R11 修复 (medium #36)：原版允许 http: 协议注入 token，但 http 会明文把 token
 * 走网络 → 抓包即可读到 GitHub PAT。仅允许 https:（或 git:/ssh: 直返回原 URL）。
 */
export function injectTokenIntoUrl(url: string, token: string): string {
  if (!url || !token) return url
  try {
    const u = new URL(url)
    // 只接受 https:；http: 明文传 token 是泄漏点；ssh/git 保持原样
    if (u.protocol !== 'https:') return url
    u.username = 'x-access-token'
    u.password = token
    return u.toString()
  } catch (_) {
    return url
  }
}

/**
 * 判断当前远程 URL 是否需要额外凭据
 * - 已嵌入凭据 → false
 * - 公开仓库（HTTPS） → false（但 pull/push 仍可能被限流）
 * - SSH（git@...）→ 通常用 ssh-agent，无需 token
 */
export function remoteNeedsToken(url: string): boolean {
  const { isPrivate } = parseRemoteUrl(url)
  if (isPrivate) return false
  // 简易启发：ssh 协议不需要 token
  if (url.startsWith('git@') || url.startsWith('ssh://')) return false
  // 其它（HTTPS 且无内嵌凭据）依赖 token
  return true
}
