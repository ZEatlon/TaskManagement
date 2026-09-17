/**
 * W2-A note-handlers 拆分 —— 文件监听 / 冲突 / 资源解析子模块
 *
 * 注册以下通道：
 *   note:watch-start       启动文件监听
 *   note:watch-stop        停止文件监听
 *   note:report-edit       上报内存侧编辑（驱动 conflict 状态机）
 *   note:resolve           解决冲突
 *   note:file-state        获取某文件状态
 *   note:file-states       获取全部文件状态
 *   note:resolve-asset     解析 markdown 里的相对资源路径为 file:// URL
 */
import { handle } from '../channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { notesManager } from '../../notes/notesManager'
import type { ConflictResolution, FileStateKind } from '../../notes/conflictResolver'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isPathInside, isRealPathInside } from '../../notes/pathSafety'
import {
  assertId,
  MAX_CONTENT_BYTES,
  MAX_NOTE_PATH_BYTES,
} from './_shared'

export function registerNoteFileHandlers(): void {
  handle<undefined, { ok: boolean; hydrated: number; dir: string | null }>(
    IPC_CHANNELS.NOTE_WATCH_START,
    async () => {
      return notesManager.startWatching()
    },
  )

  handle<undefined, { ok: boolean }>(IPC_CHANNELS.NOTE_WATCH_STOP, async () => {
    await notesManager.stopWatching()
    return { ok: true }
  })

  /** 上报内存编辑（textarea onChange） */
  handle<{ path: string; content: string }, { state: FileStateKind }>(
    IPC_CHANNELS.NOTE_REPORT_EDIT,
    async (_e, args) => {
      // R35-Corr-2：path 必须是 non-empty string，否则 conflict 状态机错乱
      assertId(args?.path, IPC_CHANNELS.NOTE_REPORT_EDIT)
      // R36 修复 (medium DoS)：path / content 字节上限。
      // path 用于 conflictResolver.states Map 的 key —— 长 path / 大量
      // unique path 可让 Map 无界增长；content 走 createHash('sha1') 同步
      // 计算，没有字节上限可让主进程 CPU 长时间钉死。
      if (Buffer.byteLength(args.path, 'utf8') > MAX_NOTE_PATH_BYTES) {
        throw new Error(`${IPC_CHANNELS.NOTE_REPORT_EDIT}: path exceeds ${MAX_NOTE_PATH_BYTES} bytes`)
      }
      if (typeof args?.content !== 'string') {
        throw new Error(`${IPC_CHANNELS.NOTE_REPORT_EDIT}: content must be string`)
      }
      if (Buffer.byteLength(args.content, 'utf8') > MAX_CONTENT_BYTES) {
        throw new Error(`${IPC_CHANNELS.NOTE_REPORT_EDIT}: content exceeds ${MAX_CONTENT_BYTES} bytes`)
      }
      notesManager.reportMemoryEdit(args.path, args.content)
      const state = notesManager.getFileState(args.path)
      return { state: state?.state ?? 'clean' }
    },
  )

  /** 解决冲突 */
  handle<
    { path: string; resolution: ConflictResolution; mergedContent?: string },
    { ok: boolean; state: FileStateKind | null }
  >(IPC_CHANNELS.NOTE_RESOLVE, async (_e, args) => {
    // R35-Corr-2：path 校验
    assertId(args?.path, IPC_CHANNELS.NOTE_RESOLVE)
    // R36 修复 (medium DoS)：path 字节上限（与 NOTE_REPORT_EDIT 同款），
    // 防止 conflictResolver.states Map key 被注长字符串拉爆。
    if (Buffer.byteLength(args.path, 'utf8') > MAX_NOTE_PATH_BYTES) {
      throw new Error(`${IPC_CHANNELS.NOTE_RESOLVE}: path exceeds ${MAX_NOTE_PATH_BYTES} bytes`)
    }
    // R36 修复 (medium DoS)：mergedContent 字节上限 —— 与 NOTE_WRITE
    // 同款 5 MiB 上限。conflictResolver.resolve 在 resolution === 'merge'
    // 分支走 ConflictResolver.hash(mergedContent) 同步 SHA1 大段 utf8，
    // 无上限可让主进程 CPU 100% 持续 30s+。
    if (args.mergedContent !== undefined) {
      if (typeof args.mergedContent !== 'string') {
        throw new Error(`${IPC_CHANNELS.NOTE_RESOLVE}: mergedContent must be string`)
      }
      if (Buffer.byteLength(args.mergedContent, 'utf8') > MAX_CONTENT_BYTES) {
        throw new Error(`${IPC_CHANNELS.NOTE_RESOLVE}: mergedContent exceeds ${MAX_CONTENT_BYTES} bytes`)
      }
    }
    const result = notesManager.resolveConflict(args.path, args.resolution, args.mergedContent)
    return { ok: result !== null, state: result?.state ?? null }
  })

  /** 单文件状态 */
  handle<string, { state: FileStateKind } | null>(IPC_CHANNELS.NOTE_FILE_STATE, async (_e, path) => {
    const s = notesManager.getFileState(path)
    return s ? { state: s.state } : null
  })

  /** 全部文件状态 */
  handle<undefined, Array<{ path: string; state: FileStateKind }>>(
    IPC_CHANNELS.NOTE_FILE_STATES,
    async () => {
      return notesManager.allFileStates().map((s) => ({ path: s.path, state: s.state }))
    },
  )

  /**
   * 解析 markdown 里的相对资源路径（图片 / 附件）为 file:// URL。
   *
   * 入参 `{ notePath, relativePath }`：
   *   - notePath 当前笔记的绝对路径
   *   - relativePath markdown 里的相对路径（支持 `./` / `../` / 裸文件名 / 绝对路径）
   *
   * 出参 `{ fileUrl } | null`：
   *   - 解析成功 + 文件存在 + 落在 library 内 → 返回 file:// URL（可放 <img>）
   *   - 解析失败 / 越界 / 文件不存在 → 返回 null
   *
   * 安全：resolved 路径必须 realpath 落在 notesDir 内 —— 防止
   * `../../etc/passwd` 之类的路径穿越。
   */
  handle<{ notePath: string; relativePath: string }, { fileUrl: string } | null>(
    IPC_CHANNELS.NOTE_RESOLVE_ASSET,
    async (_e, args) => {
      if (!args?.notePath || !args?.relativePath) return null
      const notesDir = await notesManager.getNotesDir()
      if (!notesDir) return null

      // notePath 可能不带 .md / 不在 notesDir / 来自 AI 注入 —— 全部按字符串解析
      const noteDir = dirname(resolve(args.notePath))
      const candidate = resolve(noteDir, args.relativePath)

      // 词法 + 真实路径双层校验（统一走 ../notes/pathSafety，与 notesManager 同源）
      const lexical = isPathInside(notesDir, candidate)
      if (!lexical) return null
      // 资源必须存在 —— NOTE_RESOLVE_ASSET 拿到的是要渲染到 <img> 的 file:// URL，
      // 文件不存在时直接拒掉（isRealPathInside 在 ENOENT 时会回退到词法检查并
      // 返回 true，与此处"文件必须存在"的语义不符，所以这里前置 existsSync
      // 拦截不存在的路径，避免把不存在的路径放进 <img> 触发 404）。
      if (!existsSync(candidate)) return null
      if (!(await isRealPathInside(notesDir, candidate))) return null

      return { fileUrl: pathToFileURL(candidate).href }
    },
  )
}
