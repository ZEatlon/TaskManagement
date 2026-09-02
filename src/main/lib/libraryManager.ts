/**
 * 库目录管理器
 *
 * 职责：
 *   1. 弹出系统对话框让用户选择库目录
 *   2. 校验目录是否合法（存在、可读可写等）
 *   3. 读取 / 写入当前库路径到 settings 表
 *   4. 检测是否首次启动（settings.app.settings 还未设置或 libraryPath 为空）
 */
import { dialog, BrowserWindow } from 'electron'
import { access, constants, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import log from '../log'
import { settingsRepo } from '../db/repositories/settings'

/** settings 表中存储 AppSettings 的 key */
const SETTINGS_KEY = 'app.settings'

/** 库目录校验结果 */
export interface DirectoryValidation {
  valid: boolean
  /** 当 valid=false 时描述失败原因，便于向用户展示 */
  reason?: string
}

/**
 * 弹出系统目录选择器
 * - 默认打开用户文档目录
 * - 允许创建新目录
 * - 返回用户选择的绝对路径；取消则返回 null
 */
export async function selectDirectory(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const defaultPath = join(homedir(), 'Documents', 'TaskPilot')

  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: '选择 TaskPilot 库目录',
    defaultPath,
    buttonLabel: '选择此目录',
    properties: ['openDirectory', 'createDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0] ?? null
}

/**
 * 校验目录是否可作为库目录使用
 * - 必须存在
 * - 必须是目录（不是文件）—— R12 修复 (high)
 * - 必须可读写
 * - 必须是绝对路径 —— R12 修复：拒绝相对路径，避免工作目录不同导致行为漂移
 *
 * R32-01 修复 (MEDIUM symlink-target-mismatch)：原版只 stat 路径本身，
 * 不解析 realpath。攻击场景：用户通过 dialog 选了
 * `<somewhere>/.taskpilot-alias`（一个指向 `/etc` 或指向 `~/.ssh` 的
 * symlink），stat(path) 拿到 isDirectory=true（symlink 指向目录），
 * validateDirectory 通过 → setLibrary 写入 libraryPath → 所有写入逻辑
 * （notesManager / autoSync / createNoteConfirmed 的 `join(library, '.taskpilot',
 * 'notes')`）实际写到 symlink 目标 → 污染 victim 系统目录。
 *
 * 修复：用 realpath() 解析 symlink，得到真实目录路径；做一次「realpath
 * 解析后路径与原路径一致」的轻量检测（若不一致 → 拒绝）。同时把解析
 * 后的 realPath 通过 reason 字段回传给 UI 让用户看到「你选的其实是 X
 * 的 symlink，指向 Y」，避免「明明选了 C:\data 却在 D:\notes 写」这种
 * 静默混淆。
 */
export async function validateDirectory(path: string): Promise<DirectoryValidation> {
  if (!path || typeof path !== 'string') {
    return { valid: false, reason: '路径为空' }
  }
  // R12 修复 (high)：拒绝对相对路径，避免 ../ 跳转或当前工作目录变化
  // 导致校验/写入行为漂移。
  if (!isAbsolute(path)) {
    return { valid: false, reason: '路径必须是绝对路径' }
  }

  try {
    // R12 修复 (high)：原版只检查 access(R_OK|W_OK)，但普通文件（如
    // C:\Windows\System32\drivers\etc\hosts）同样可读可写，导致 setLibrary
    // 把文件路径当成库目录写进去 → 后续 notes/attachments join 全部错位。
    // 先 stat 确认是目录。
    const s = await stat(path)
    if (!s.isDirectory()) {
      return { valid: false, reason: '路径不是目录' }
    }
    // R32-01 修复：realpath 解析 symlink/junction。
    const { realpath: rp } = await import('node:fs/promises')
    const realPath = await rp(path).catch((rpErr) => {
      log.warn(`[library] realpath failed for ${path}: ${rpErr instanceof Error ? rpErr.message : String(rpErr)}`)
      return path
    })
    // 检测：路径是否是 symlink / junction —— 简单做法是比较解析前后
    // 是否一致（Windows 上大小写不敏感，但 rp 已在 win32 上处理）。
    // 若解析后路径不同 → 拒绝，明确告诉用户「这是 symlink，指向 X」。
    if (realPath !== path) {
      log.warn(
        `[library] refusing symlinked library: ${path} -> ${realPath}; would write to unexpected location`,
      )
      return {
        valid: false,
        reason: `所选路径是符号链接，解析后指向「${realPath}」。为防止越界写入，请选择非 symlink/junction 的真实目录`,
      }
    }
    // 访问检查（读写权限）
    await access(path, constants.R_OK | constants.W_OK)
    return { valid: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`[library] validateDirectory failed: ${path} -> ${msg}`)
    if (msg.includes('ENOENT')) {
      return { valid: false, reason: '目录不存在' }
    }
    if (msg.includes('EACCES') || msg.includes('EPERM')) {
      return { valid: false, reason: '没有读写权限' }
    }
    return { valid: false, reason: `无法访问目录：${msg}` }
  }
}

/**
 * 获取当前库路径
 * 从 settings 表读取 app.settings.libraryPath
 */
export async function getCurrentLibrary(): Promise<string | null> {
  const all = await settingsRepo.getAll()
  const cfg = all[SETTINGS_KEY] as { libraryPath?: string | null } | undefined
  if (!cfg) return null
  return cfg.libraryPath ?? null
}

/**
 * 设置当前库路径并持久化
 * 仅写入 libraryPath 字段，保留其它设置项
 */
export async function setLibrary(path: string): Promise<void> {
  const all = await settingsRepo.getAll()
  const current = (all[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}
  const next = { ...current, libraryPath: path }
  await settingsRepo.set(SETTINGS_KEY, next)
  log.info(`[library] libraryPath set to: ${path}`)
}

/**
 * 检测是否首次启动
 * - settings 表中尚无 app.settings 记录 → 首次启动
 * - 或者 app.settings.libraryPath 为空字符串 / null → 视为首次启动
 */
export async function isFirstRun(): Promise<boolean> {
  const current = await getCurrentLibrary()
  return !current || current.trim().length === 0
}

/**
 * 清除当前库路径（用于"重置库"场景）
 *
 * R23-DI-5 修复 (medium data integrity)：原版只写 settings.libraryPath = null，
 * 不停掉依赖旧路径的运行时（notesWatcher / autoSync / taskScheduler / heatmap
 * 缓存 / scanLocalChanges 状态）。结果：用户"重置库"后，notesWatcher 仍在
 * 监听旧目录的 .md，upsertFromFile 把残留文件继续塞进同一 DB，taskScheduler
 * 继续按旧 sticky 触发通知，autoSync 继续往旧 remote 推"看上去无库"的
 * 提交。状态不一致时间无限长。
 *
 * 修复：在写 null 之前先并行停掉所有依赖 libraryPath 的服务（幂等、可重入，
 * 即使当前没启动也安全）。下次 setLibrary + initializeLibrary 会按正常路径
 * 重启它们。
 */
export async function clearLibrary(): Promise<void> {
  // 动态 import 避免循环依赖（scheduler / autoSync / notesManager 都反向依赖
  // settingsRepo，而 libraryManager 已经依赖 settingsRepo）。
  const [{ stopTaskScheduler }, { stopAutoSync }, { notesManager }] =
    await Promise.all([
      import('../scheduler/taskScheduler'),
      import('../git/autoSync'),
      import('../notes/notesManager'),
    ])
  // 先停一切写路径（避免停 watcher 前还有 pending handle 在跑）
  stopTaskScheduler()
  stopAutoSync()
  await notesManager.stopWatching()

  const all = await settingsRepo.getAll()
  const current = (all[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}
  const next = { ...current, libraryPath: null }
  await settingsRepo.set(SETTINGS_KEY, next)
  log.info('[library] libraryPath cleared (services stopped)')
}
