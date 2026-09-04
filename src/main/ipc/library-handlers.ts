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
 *   - lib:scan               扫描指定路径报告 .taskpilot 数据现状
 *   - lib:migrate            把当前库数据复制到新路径
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
import { scanLibrary, migrateLibrary } from '../lib/libraryScanner'
import { IPC_CHANNELS } from '@shared/ipc/channels'

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

  /**
   * 扫描指定路径：报告 .taskpilot 子目录的数据现状（笔记数 / 附件数 /
   * 占用字节 / 是否有子目录）。用于「切换库目录」前先预览新目录里
   * 已有多少数据 → 用户选择「解析原有数据」或「在新建库」。
   */
  handle<{ path: string }, {
    path: string
    hasTaskpilotDir: boolean
    noteCount: number
    attachmentCount: number
    totalBytes: number
    extraSubdirCount: number
    error?: string
  }>(IPC_CHANNELS.LIB_SCAN, async (_e, args) => {
    if (!args || typeof args.path !== 'string' || !args.path) {
      return {
        path: args?.path ?? '',
        hasTaskpilotDir: false,
        noteCount: 0,
        attachmentCount: 0,
        totalBytes: 0,
        extraSubdirCount: 0,
        error: '路径为空',
      }
    }
    return scanLibrary(args.path)
  })

  /**
   * 把当前库（<currentLibrary>/.taskpilot/）数据复制到新路径。
   * - 不清空新目录已有文件（cp force:false）
   * - src == dest 或 dest 是 src 子目录 → 拒绝
   * - 复制完成后 .taskpilot/notes 下既有 src 笔记 + dest 笔记（如果有），
   *   chokidar watcher 会自动 ingest；渲染端随后调用 setCurrent 切到新路径。
   */
  handle<{ destPath: string }, {
    copiedFiles: number
    copiedBytes: number
    sourcePath: string
    destPath: string
    sourceHadData: boolean
  }>(IPC_CHANNELS.LIB_MIGRATE, async (_e, args) => {
    if (!args || typeof args.destPath !== 'string' || !args.destPath) {
      throw new Error('lib:migrate: destPath 必填')
    }
    const destValidation = await validateDirectory(args.destPath)
    if (!destValidation.valid) {
      throw new Error(`lib:migrate: 目标路径无效：${destValidation.reason ?? '未知'}`)
    }
    const current = await getCurrentLibrary()
    if (!current) {
      throw new Error('lib:migrate: 当前未设置库目录，无法迁移')
    }
    return migrateLibrary(current, args.destPath)
  })
}
