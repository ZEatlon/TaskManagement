/**
 * 库目录相关 IPC 处理器
 *
 * 暴露给渲染进程的通道（与 src/shared/ipc/channels.ts 保持同步）：
 *   - lib:select-directory   弹出系统目录选择器
 *   - lib:get-current        获取当前库路径
 *   - lib:set-current        设置当前库路径
 *   - lib:initialize         在指定路径创建库骨架（.taskpilot 子目录）
 *   - lib:validate           校验目录是否可用
 *   - lib:is-first-run       是否首次启动
 *   - lib:clear              清除当前库路径（用于重置）
 */
import { handle } from './channels'
import {
  selectDirectory,
  getCurrentLibrary,
  setLibrary,
  validateDirectory,
  isFirstRun,
  clearLibrary,
} from '../lib/libraryManager'
import { initializeLibrary } from '../lib/initializeLibrary'

export function registerLibraryHandlers(): void {
  /** 弹出系统目录选择器，返回选中的绝对路径或 null（取消） */
  handle('lib:select-directory', async () => {
    return selectDirectory()
  })

  /** 读取当前库路径（可能为 null） */
  handle('lib:get-current', async () => {
    return getCurrentLibrary()
  })

  /** 设置当前库路径（仅持久化，不实际初始化目录） */
  handle('lib:set-current', async (_e, args: { path: string }) => {
    if (!args || typeof args.path !== 'string' || !args.path) {
      throw new Error('library path is required')
    }
    // R11 修复 (medium #27)：原版任何 string 都接受，渲染进程被 XSS 注入后可
    // 把 libraryPath 设为 C:\Windows\System32 等系统目录，后续 initializeLibrary
    // 会 mkdir -p + 写 .taskpilot 子目录，可能误伤系统目录。改为先调用
    // validateDirectory 校验真实存在 + 可读写，校验失败的 path 拒绝持久化。
    const validation = await validateDirectory(args.path)
    if (!validation.valid) {
      throw new Error(`invalid library path: ${validation.reason ?? 'unknown'}`)
    }
    await setLibrary(args.path)
    return { ok: true, path: args.path }
  })

  /**
   * 在指定路径创建库骨架。
   * 一般流程：先 validate 再 initialize；这里也允许 idempotent 重复调用。
   * R11 修复 (medium #27)：与 lib:set-current 一致，先 validate 校验目录可读可写，
   * 避免任意 path 落到 initializeLibrary 里 mkdir 系统目录。
   */
  handle('lib:initialize', async (_e, args: { path: string }) => {
    if (!args || typeof args.path !== 'string' || !args.path) {
      throw new Error('library path is required')
    }
    const validation = await validateDirectory(args.path)
    if (!validation.valid) {
      throw new Error(`invalid library path: ${validation.reason ?? 'unknown'}`)
    }
    const tpRoot = await initializeLibrary(args.path)
    return { ok: true, path: args.path, taskpilotDir: tpRoot }
  })

  /** 校验目录是否可作为库使用 */
  handle('lib:validate', async (_e, args: { path: string }) => {
    if (!args || typeof args.path !== 'string' || !args.path) {
      return { valid: false, reason: '路径为空' }
    }
    return validateDirectory(args.path)
  })

  /** 是否首次启动（settings 中 libraryPath 为空） */
  handle('lib:is-first-run', async () => {
    return isFirstRun()
  })

  /** 清除当前库路径（用于重置向导等场景） */
  handle('lib:clear', async () => {
    await clearLibrary()
    return { ok: true }
  })
}
