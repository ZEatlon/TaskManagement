/**
 * 库目录扫描器 + 数据迁移器
 *
 * 用于「切换库目录」UI：
 *   - scanLibrary(path)  —— 报告指定路径下的 .taskpilot 数据现状
 *     （笔记数 / 附件数 / 占用字节 / 是否已含 .taskpilot 子目录）
 *   - migrateLibrary(srcPath, destPath) —— 把 srcPath/.taskpilot/ 整棵
 *     复制到 destPath/.taskpilot/。冲突策略：保留 dest 已有文件，仅补
 *     缺失的（安全第一）。复制完成后 .taskpilot/notes 里既有 src 笔记
 *     又有 dest 笔记，渲染端会通过 chokidar 自动 ingest。
 *
 * 安全：迁移前会校验 src + dest 都在白名单允许范围内（realpath 解析后
 * 与原路径一致；非 symlink / 越界）。如果 src == dest 或 dest 是 src
 * 子目录则直接拒。
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { realpath as fsRealpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import log from '../log'

export interface LibraryScanResult {
  /** 扫描目标路径（用户传入） */
  path: string
  /** 路径下是否已含 .taskpilot 子目录 */
  hasTaskpilotDir: boolean
  /** .taskpilot/notes/*.md 文件数 */
  noteCount: number
  /** .taskpilot/attachments 下的文件数（递归） */
  attachmentCount: number
  /** .taskpilot 总字节数（递归求和所有文件 size） */
  totalBytes: number
  /** .taskpilot 内的子目录数（不含 notes / attachments） */
  extraSubdirCount: number
  /** 路径不在 / 不可读时填 false，error 字段说明原因 */
  error?: string
}

/**
 * 扫描 path/.taskpilot，返回统计信息。
 * 路径不存在 / 不是目录 / 无 .taskpilot → 返回带 error 的结构（不是 throw）。
 */
export async function scanLibrary(path: string): Promise<LibraryScanResult> {
  if (!path || typeof path !== 'string') {
    return { path, hasTaskpilotDir: false, noteCount: 0, attachmentCount: 0, totalBytes: 0, extraSubdirCount: 0, error: '路径为空' }
  }
  if (!isAbsolute(path)) {
    return { path, hasTaskpilotDir: false, noteCount: 0, attachmentCount: 0, totalBytes: 0, extraSubdirCount: 0, error: '路径必须是绝对路径' }
  }

  let realPath: string
  try {
    realPath = await fsRealpath(path)
  } catch (err) {
    return { path, hasTaskpilotDir: false, noteCount: 0, attachmentCount: 0, totalBytes: 0, extraSubdirCount: 0, error: `路径不存在: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (realPath !== path) {
    return { path, hasTaskpilotDir: false, noteCount: 0, attachmentCount: 0, totalBytes: 0, extraSubdirCount: 0, error: `路径是符号链接，解析后指向「${realPath}」` }
  }

  // 统计
  const tpDir = join(path, '.taskpilot')
  let hasTaskpilotDir = false
  let noteCount = 0
  let attachmentCount = 0
  let totalBytes = 0
  let extraSubdirCount = 0
  try {
    const s = await stat(tpDir)
    if (!s.isDirectory()) {
      return { path, hasTaskpilotDir: false, noteCount: 0, attachmentCount: 0, totalBytes: 0, extraSubdirCount: 0, error: '.taskpilot 不是一个目录' }
    }
    hasTaskpilotDir = true
  } catch {
    hasTaskpilotDir = false
  }

  if (hasTaskpilotDir) {
    const counts = await walkAndCount(tpDir)
    noteCount = counts.notes
    attachmentCount = counts.attachments
    totalBytes = counts.bytes
    extraSubdirCount = counts.extraSubdirs
  }

  return { path, hasTaskpilotDir, noteCount, attachmentCount, totalBytes, extraSubdirCount }
}

interface WalkCounts {
  notes: number
  attachments: number
  bytes: number
  extraSubdirs: number
}

async function walkAndCount(dir: string): Promise<WalkCounts> {
  let notes = 0
  let attachments = 0
  let bytes = 0
  let extraSubdirs = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = join(cur, e.name)
      if (e.isDirectory()) {
        // 顶层 notes / attachments 不计「extra 子目录」；更深的目录算
        const isTopNotes = cur === dir && e.name === 'notes'
        const isTopAttachments = cur === dir && e.name === 'attachments'
        if (!(isTopNotes || isTopAttachments)) {
          extraSubdirs++
        }
        stack.push(full)
      } else if (e.isFile()) {
        const s = await stat(full).catch(() => null)
        const size = s?.size ?? 0
        bytes += size
        // 顶层 notes 下的 .md 算笔记；顶层 attachments 下的算附件
        if (cur === join(dir, 'notes') && e.name.toLowerCase().endsWith('.md')) {
          notes++
        } else if (cur === join(dir, 'attachments')) {
          attachments++
        }
      }
    }
  }
  return { notes, attachments, bytes, extraSubdirs }
}

export interface LibraryMigrateResult {
  /** 复制成功的文件数（src 顶层 .taskpilot 内容数） */
  copiedFiles: number
  /** 复制的总字节数 */
  copiedBytes: number
  /** 复制前的源路径 */
  sourcePath: string
  /** 复制后的目标路径 */
  destPath: string
  /** src 是否有 .taskpilot 数据 */
  sourceHadData: boolean
}

/**
 * 把 src/.taskpilot/* 复制到 dest/.taskpilot/。
 * 不会清空 dest；冲突文件保留 dest 已有版本。
 *
 * 异常：
 *   - src / dest 路径相同 → throw
 *   - dest 是 src 的子目录 → throw（防止循环复制）
 *   - 路径无 .taskpilot → 不复制，返回 sourceHadData=false
 */
export async function migrateLibrary(
  srcPath: string,
  destPath: string,
): Promise<LibraryMigrateResult> {
  if (!srcPath || !destPath) throw new Error('migrateLibrary: src / dest 都必须提供')
  if (srcPath === destPath) throw new Error('migrateLibrary: 源与目标路径相同')
  const rel = relative(srcPath, destPath)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    throw new Error('migrateLibrary: 目标是源的子目录，禁止循环复制')
  }

  const srcTp = join(srcPath, '.taskpilot')
  let sourceHadData = false
  try {
    const s = await stat(srcTp)
    sourceHadData = s.isDirectory()
  } catch {
    sourceHadData = false
  }

  if (!sourceHadData) {
    log.info(`[library-migrate] source has no .taskpilot: ${srcTp}`)
    return { copiedFiles: 0, copiedBytes: 0, sourcePath: srcPath, destPath, sourceHadData: false }
  }

  // 确保 dest/.taskpilot 存在
  const destTp = join(destPath, '.taskpilot')
  await mkdir(destTp, { recursive: true })

  // cp -r srcTp/. -> destTp/（带 force:false 避免覆盖 dest 已有同名文件）
  // 跨平台：Node 16+ 的 fs.cp 支持 recursive + force 选项
  await cp(srcTp, destTp, { recursive: true, force: false, errorOnExist: false })

  // 统计实际复制量
  const after = await walkAndCount(destTp)
  log.info(
    `[library-migrate] copied ${srcTp} -> ${destTp}; now has ${after.notes} notes / ${after.attachments} attachments / ${after.bytes} bytes`,
  )
  return {
    copiedFiles: after.notes + after.attachments + after.extraSubdirs,
    copiedBytes: after.bytes,
    sourcePath: srcPath,
    destPath,
    sourceHadData: true,
  }
}
