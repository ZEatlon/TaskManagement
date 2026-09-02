/**
 * 笔记文件系统监听器
 *
 * 使用 chokidar v4 监听 libraryPath/notes/ 目录中的 .md 文件变化：
 *   - add:    新增文件
 *   - change: 文件修改
 *   - unlink: 文件删除
 *   - addDir: 新增子目录
 *   - unlinkDir: 删除子目录
 *
 * 特性：
 *   - 防抖：300ms 内的多次事件合并为一次推送
 *   - 通过 IPC `note:fs-event` 主动推送到渲染进程
 *   - 通过 note_events 表记录热力图事件
 *
 * 备注：chokidar v4 使用原生 fs events，无需额外依赖。
 */
import { join } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { BrowserWindow } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import log from '../log'
import { NOTES_DIR } from '../lib/initializeLibrary'
import { conflictResolver } from './conflictResolver'
import { noteEventsRepo } from '../db/repositories/completions'
import { notesRepo } from '../db/repositories/notes'
import { parseFrontmatter } from './frontmatter'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { localDayKeyOf } from '../lib/localDayKey'

/** 文件系统事件类型 */
export type FsEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'ready'

/** 推送到渲染端的统一事件结构 */
export interface FsEvent {
  type: FsEventType
  path: string
  /** 仅在 add/change 时附带 mtime（ISO） */
  mtime?: string
}

/** 防抖延迟（毫秒） */
const DEBOUNCE_MS = 300

/**
 * R7G-6 修复：应用自身写入 / 删除的文件会被 chokidar 重新捕获，导致
 *   - 多余的 upsertFromFile（写盘已经走过一遍了）
 *   - 多余的 noteEvents 记录（每次保存热力图 +1）
 *
 * 维护一个短期 TTL 集合（路径 → 过期时间戳），schedule() 时检查并跳过：
 *   - writeNote 写完后调 skipNextEvents(path, ttlMs=2000)
 *   - moveNote 完成后 skipNextEvents(fromPath + toPath)
 *   - deleteNote 完成后 skipNextEvents(path)
 *
 * TTL 比 awaitWriteFinish stabilityThreshold 大，但比 IPC 延迟小，避免
 * 真正来自外部编辑器的修改被误吞。
 */
const SELF_WRITE_TTL_MS = 2000
// R21 修复 (medium memory leak)：原版 selfWriteSkipUntil 是无界 Map，
// 每个用户编辑过的笔记路径都会留下 entry（值是过期时间戳）。用户跑了几
// 个月后这个 Map 可能膨胀到几万条，IPC 重启 / 路径名空间切换都不释放。
// TTL 通常 2s，过期 entry 已无业务意义但仍占用内存。修复：每 30s 触发
// 一次 sweep，清掉 `value < Date.now()` 的 entry；同时在 schedule()
// 命中 isSelfWrite 的路径上新增 / 续期时如果发现旧 entry 也顺便清。
// 用 map iteration + delete 是 O(n) 但 n 通常 < 1000（活跃 TTL 窗口）
// —— 30s 一次的 sweep 不会成为热点。
const selfWriteSkipUntil = new Map<string, number>()
let lastSkipGcAt = 0
const SKIP_GC_INTERVAL_MS = 30_000

/** 清理已过期的 skip entry；超出 Map 大小阈值时强制 sweep */
function gcSkipUntil(now: number): void {
  if (now - lastSkipGcAt < SKIP_GC_INTERVAL_MS && selfWriteSkipUntil.size < 500) return
  lastSkipGcAt = now
  for (const [p, until] of selfWriteSkipUntil) {
    if (until <= now) selfWriteSkipUntil.delete(p)
  }
}

/** 仅监听 .md 文件 */
const EXT_FILTER = /\.md$/i

class NotesWatcher {
  private watcher: FSWatcher | null = null
  private watchDir: string | null = null
  /** 防抖 map：path → timeout + lastEvent */
  private pending = new Map<string, NodeJS.Timeout>()
  /** 启动代数计数器：每次 stop() 自增，用于让 stop 之后仍处于飞行中的回调尽早退出 */
  private generation = 0

  /**
   * 启动监听
   * - watchDir 通常为 <libraryPath>/.taskpilot/notes
   * - 已存在 watcher 时先停止再启动（支持切换库目录）
   */
  async start(watchDir: string): Promise<void> {
    if (this.watcher) {
      await this.stop()
    }
    // R26-Corr-6 修复 (medium stale-state)：原版 start() 不清 selfWriteSkipUntil
    // Map —— 用户切库（clearLibrary → re-import 同一目录）时，旧 watcher 写到
    // Map 里的 TTL 项（path → 过期时间戳）仍在生效。chokidar 重新 emit 每个
    // 文件的 'add'，schedule() 命中 isSelfWrite=true 跳 DB 写入与 note_events
    // 副作用 → 新库的所有笔记永远不进 UI，直到用户手动触发 rescan。
    // 修复：start() 入口清掉 Map（库的语义边界：换一个库就别继承旧库的「自写
    // 跳过」标记）。
    selfWriteSkipUntil.clear()
    this.watchDir = watchDir

    log.info(`[notes-watcher] starting at ${watchDir}`)

    const w = chokidar.watch(watchDir, {
      ignored: (p: string, stats?: { isDirectory(): boolean; isFile(): boolean }) => {
        // 跳过隐藏文件、临时文件、非 .md 文件
        const base = p.replace(/\\/g, '/').split('/').pop() ?? ''
        if (base.startsWith('.') || base.startsWith('~')) return true
        // 目录放行（chokidar 需要遍历），但排除非 .md 的文件
        if (stats?.isDirectory()) return false
        if (stats?.isFile() && !EXT_FILTER.test(base)) return true
        return false
      },
      // R23 修复 (medium security)：默认 followSymlinks=true，攻击者在 notesDir
      // 下丢一个 notes/secret -> C:\Users\james 的 symlink 会让 chokidar 递归
      // 整个用户目录，所有 .md 经 readFile 进入 TaskPilot DB，且 fs-event IPC
      // 把绝对路径广播到 renderer 泄密。关掉 symlink 跟踪。
      followSymlinks: false,
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    })

    w.on('add', (p) => this.schedule('add', p))
    w.on('change', (p) => this.schedule('change', p))
    w.on('unlink', (p) => this.schedule('unlink', p))
    w.on('addDir', (p) => this.schedule('addDir', p))
    w.on('unlinkDir', (p) => this.schedule('unlinkDir', p))
    w.on('ready', () => {
      this.broadcast({ type: 'ready', path: watchDir })
      log.info(`[notes-watcher] ready at ${watchDir}`)
    })
    w.on('error', (err) => {
      log.error('[notes-watcher] error', err)
    })

    this.watcher = w
  }

  /** 停止监听 */
  async stop(): Promise<void> {
    if (!this.watcher) return
    log.info('[notes-watcher] stopping')
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
    this.generation++
    try {
      await this.watcher.close()
    } catch (err) {
      log.warn('[notes-watcher] close error', err)
    }
    this.watcher = null
    this.watchDir = null
  }

  /** 是否正在监听 */
  isActive(): boolean {
    return this.watcher !== null
  }

  /** 当前监听目录 */
  getDir(): string | null {
    return this.watchDir
  }

  /**
   * 防抖调度：300ms 内的同一路径变化只触发一次推送
   */
  private schedule(type: FsEventType, fullPath: string): void {
    if (!EXT_FILTER.test(fullPath) && type !== 'addDir' && type !== 'unlinkDir') {
      return
    }
    // R7G-6：若 path 在 SELF_WRITE_TTL_MS 内被自家写过，直接丢弃。
    // 仍然需要保留广播让渲染端拿到事件 —— 但只在 handle 里跳过 DB upsert + 计数。
    const now = Date.now()
    // R21 修复：每次 schedule() 先做一次轻量级 GC —— 把已过期的 entry 清掉，
    // 防止 selfWriteSkipUntil 无限增长。
    gcSkipUntil(now)
    const skipUntil = selfWriteSkipUntil.get(fullPath) ?? 0
    const isSelfWrite = skipUntil > now
    if (isSelfWrite) {
      // R14 修复 (medium)：原版「命中就 delete」让 chokidar 在 TTL 窗口内
      // 的后续事件（例如 macOS FSEvents 偶尔发两次 'change'）落到下面
      // 真实 handler，触发冗余 upsert + note_events INSERT，热力图双增。
      // 改为「命中就续期」，整个 TTL 窗口内的事件都被吞掉，窗口外才
      // 允许真实 handler 跑一次（自然落库的最终态）。
      selfWriteSkipUntil.set(fullPath, now + SELF_WRITE_TTL_MS)
      log.debug(`[notes-watcher] skip self-write event: ${type} ${fullPath}`)
      // 仍然广播给渲染端（让 UI 知道有变化），但不下发 DB / note_events 副作用
      this.broadcast({ type, path: fullPath })
      return
    }
    const key = `${type}::${fullPath}`
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing)
    const gen = this.generation
    const t = setTimeout(async () => {
      this.pending.delete(key)
      if (gen !== this.generation) return
      await this.handle(type, fullPath, gen)
    }, DEBOUNCE_MS)
    this.pending.set(key, t)
  }

  /**
   * 通知 watcher：刚才是我们自己写 / 删除的路径，下次 chokidar 报同事件时跳过 DB 副作用。
   * 调用方应在 writeNote / renameNote / moveNote / deleteNote 写盘成功后调用。
   */
  skipNextEvents(fullPath: string, ttlMs: number = SELF_WRITE_TTL_MS): void {
    // R21 修复：写入前也跑一次 GC，避免 set 之前 Map 已膨胀。
    gcSkipUntil(Date.now())
    selfWriteSkipUntil.set(fullPath, Date.now() + ttlMs)
  }

  /**
   * 真正处理事件
   * - add/change: 读 frontmatter，更新 notes 仓储，通知冲突器，记录 note_events
   * - unlink: 删除仓储条目，删除状态
   * - addDir/unlinkDir: 仅推送事件
   */
  private async handle(type: FsEventType, fullPath: string, gen: number): Promise<void> {
    // R23-DI-6 修复 (medium data integrity)：原版把 gen !== this.generation
    // 检查放在 readFile / upsertFromFile / noteEventsRepo.record 之后，结果
    // stop()/start() 在 debounced 飞行期间被调用 → generation 自增，但 handle
    // 仍把陈旧路径写入 DB、并在热力图插入一条 'edit' 行。修复：把生成检查
    // 提到方法顶部，stale generation 直接返回，不再触达 DB / 缓存 / 计数。
    //
    // R28-Corr-3 修复 (medium race-condition)：R23 只在顶部检查一次，但
    // readFile/upsertFromFile/noteEventsRepo.record 都是 await，期间
    // stop()/start() 可能把 generation 推到新值；陈旧 gen 仍会在 DB 写入。
    // 修复：把每个 DB write 之前再补一次 gen guard；upsertFromFile 之后
    // 也补一次，避免 stale conflictResolver.onDiskChange + heatmap write。
    if (gen !== this.generation) return
    try {
      let mtime: string | undefined
      if (type === 'add' || type === 'change') {
        try {
          const [content, stats] = await Promise.all([
            readFile(fullPath, 'utf-8'),
            stat(fullPath),
          ])
          if (gen !== this.generation) return
          mtime = stats.mtime.toISOString()
          const parsed = parseFrontmatter(content)
          const meta = await notesRepo.upsertFromFile(fullPath, content, parsed, stats)
          if (gen !== this.generation) return
          conflictResolver.onDiskChange(fullPath, content)
          // 记录热力图事件
          await noteEventsRepo.record(meta.id, localDayKeyOf(), 'edit')
        } catch (err) {
          log.warn(`[notes-watcher] handle ${type} failed: ${fullPath}`, err)
          return
        }
      } else if (type === 'unlink') {
        if (gen !== this.generation) return
        await notesRepo.deleteByPath(fullPath)
        if (gen !== this.generation) return
        conflictResolver.onDelete(fullPath)
        if (gen !== this.generation) return
        await noteEventsRepo.record(null, localDayKeyOf(), 'delete')
      }

      // 若在 await 期间已被 stop()/start() 取代，则不再广播，避免向已停止的 watcher 推送陈旧事件
      if (gen !== this.generation) return

      this.broadcast({ type, path: fullPath, mtime })
    } catch (err) {
      log.error(`[notes-watcher] handle ${type} ${fullPath} failed`, err)
    }
  }

  /**
   * 主动向所有渲染端窗口广播事件
   */
  private broadcast(event: FsEvent): void {
    const wins = BrowserWindow.getAllWindows()
    for (const w of wins) {
      if (!w.isDestroyed()) {
        try {
          w.webContents.send(IPC_CHANNELS.NOTE_FS_EVENT, event)
        } catch (err) {
          // ignore
        }
      }
    }
  }

  /**
   * 应用启动时同步已有 .md 文件到 notes 仓储。
   * - 遍历 watchDir 下所有 .md
   * - 对仓储中不存在的条目插入；存在但 mtime 更新的更新
   */
  async hydrateFromDisk(): Promise<number> {
    if (!this.watchDir) return 0
    let count = 0
    const stack: string[] = [this.watchDir]
    while (stack.length) {
      const dir = stack.pop()!
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        if (name.startsWith('.') || name.startsWith('~')) continue
        const full = join(dir, name)
        const statRes = await stat(full).catch(() => null)
        if (!statRes) continue
        if (statRes.isDirectory()) {
          stack.push(full)
        } else if (EXT_FILTER.test(name)) {
          try {
            const content = await readFile(full, 'utf-8')
            const parsed = parseFrontmatter(content)
            await notesRepo.upsertFromFile(full, content, parsed, statRes)
            conflictResolver.onDiskChange(full, content)
            count++
          } catch (err) {
            log.warn(`[notes-watcher] hydrate failed: ${full}`, err)
          }
        }
      }
    }
    return count
  }
}

/** 单例 */
export const notesWatcher = new NotesWatcher()

/** 默认监听目录解析：<libraryPath>/.taskpilot/notes */
export function notesWatchDir(libraryPath: string | null): string | null {
  if (!libraryPath) return null
  return join(libraryPath, '.taskpilot', NOTES_DIR)
}
