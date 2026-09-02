/**
 * 笔记管理服务（CRUD 入口）
 *
 * 职责：
 *   - 列表 / 读取 / 写入 / 删除 / 搜索
 *   - 启动 / 停止文件系统监听
 *   - 协调 notes 仓储、frontmatter 解析、conflict 状态机
 *
 * 文件路径：
 *   <libraryPath>/.taskpilot/notes/<filename-or-subfolder>/*.md
 */
import { join, dirname, basename, extname, resolve, relative, isAbsolute } from 'node:path'
import { readFile, mkdir, unlink, rename, open as fsOpen } from 'node:fs/promises'
import { existsSync, constants as fsConstants } from 'node:fs'
import { realpath as fsRealpath } from 'node:fs/promises'
import log from '../log'
import { notesRepo, PathCollisionError } from '../db/repositories/notes'
import { notesWatcher, notesWatchDir } from './notesWatcher'
import { conflictResolver, type ConflictResolution } from './conflictResolver'
import {
  parseFrontmatter,
  stringifyFrontmatter,
  normalizeFrontmatter,
  type NoteFrontmatter,
} from './frontmatter'
import { getCurrentLibrary } from '../lib/libraryManager'
import type { NoteMeta, Note } from '@shared/types'
import type { ParsedNote } from './frontmatter'

/** 写入文件时的安全文件名（去除非法字符） */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled'
}

/**
 * 校验目标路径是否落在 rootDir 之下（防止目录穿越）。
 * - 解析为绝对路径后再做包含判断，规避 `..`、绝对路径、`\Windows\..` 等手法。
 */
function isPathInside(rootDir: string, target: string): boolean {
  const resolvedRoot = resolve(rootDir)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (!rel) return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}

/**
 * R16 修复 (low)：原 isPathInside 用 resolve() 只做词法规范化，符号链接会被绕开。
 *   - git sync 进来的 `notes/innocent.md → /etc/passwd` 会被 isPathInside 放过，
 *     但 readFile/writeFile 跟随 symlink 实际访问 /etc/passwd；
 *   - 用户手动 ln -s /etc/passwd notes/secret.md 后，note:read 会把 passwd 内容
 *     返回给渲染端。
 * 安全路径解析 = realpath(rootDir) + realpath(target) 再做包含判断。realpath 失败
 * （ENOENT 等）时降级为词法检查，不阻断合法的"还没创建就写入"路径（writeNote 新建文件
 * 时 target 还不存在）。
 */
async function isRealPathInside(rootDir: string, target: string): Promise<boolean> {
  let realRoot: string
  try {
    realRoot = await fsRealpath(rootDir)
  } catch {
    realRoot = resolve(rootDir)
  }
  let realTarget: string
  try {
    realTarget = await fsRealpath(resolve(target))
  } catch {
    // target 不存在（写入新建文件 / 已删除的待读路径）→ 退回词法包含判断
    return isPathInside(rootDir, target)
  }
  const rel = relative(realRoot, realTarget)
  if (!rel) return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}

/**
 * R17 修复 (medium security：TOCTOU 防 symlink 换靶)：
 * 真实路径校验（isRealPathInside）与实际 writeFile 之间存在一个 await 窗口，
 * 攻击者（已能写 notesDir 同用户态进程）可在此窗口内执行
 *   mkdir + symlinkSync('innocent.md', '/etc/passwd')
 * 让原 writeFile 跟随 symlink 写到任意位置。修复方案：
 *   - 用 fs.open + 显式 flag（含 O_NOFOLLOW）原子打开：
 *     O_NOFOLLOW：最后一段若是 symlink 直接 ELOOP 失败，不跟随
 *     O_EXCL（新建）：若文件已存在则失败，防「先 ln -s /etc/passwd 再写」
 *     O_TRUNC（覆盖）：清空文件内容，原子完成「打开」与「截断」
 *   - 拿到 fd 后用 handle.writeFile 写入，fs.writeFile 跟随 fd 不会重新走路径解析，
 *     后续即便攻击者 rm + symlink 也救不回已写出去的 fd。
 * 失败抛错由调用方 catch 处理（按"目标被替换/竞态失败"语义）。
 *
 * R18 修复 (medium security)：libuv 在 Windows 上即便请求 O_NOFOLLOW 也
 * 不会拒绝 symlink —— Node 文档明文：'O_NOFOLLOW' is only supported on
 * Darwin / Linux，其它平台（包括 Windows）即便设了 flag，open 调用照样
 * 跟随符号链接。R17 的修复在 Windows 平台其实完全失效。
 *
 * 跨平台方案：
 *   - 类 Unix（Darwin / Linux）：保留 O_NOFOLLOW + O_EXCL/O_TRUNC 原子开 fd
 *   - Windows：libuv 不实现 O_NOFOLLOW，所以改用「先 lstat 检查末段不是
 *     symlink / junction + 用 O_EXCL 原子创建」两步：
 *       * lstat(targetPath)：拿到末段元数据。ENOENT → 不存在可创建；
 *         若是 symlink 或 reparse point → 直接抛错，阻断 symlink target。
 *       * fs.open with O_CREAT|O_EXCL|O_WRONLY：原子创建。
 *         若攻击者在 lstat 与 open 之间塞 symlink，O_EXCL 仍会因
 *         「路径已存在」失败（symlink 也算存在）—— TOCTOU 窗口被 O_EXCL
 *         收窄到只能由 O_EXCL 自身解决。
 *       * 覆盖路径（existed=true）：先 unlink 再用 O_EXCL|O_CREAT 重建。
 *         unlink 删 symlink 不会跟随（rm target 也不会跟随），所以删除是
 *         安全的；重建仍走 O_EXCL 防塞入。
 *
 * 已知限制：
 *   - NTFS hard link（多 inode 指向同一数据块）：Node lstat 无法检测。
 *     攻击者把 system file hardlink 到 notesDir 后我们写到 hardlink，修改
 *     也会落到系统文件上。这条防线需要 Win32 FSCTL 来实现，本仓库覆盖不到。
 *     缓解：拒绝把 notesDir 放在 system path 同分区，并保留后续 issue。
 *   - NTFS junction（directory reparse point）：lstat 也认不出 junction
 *     目录的子文件，但 junction 目录本身不会被当作普通文件 open，所以
 *     「写到 symlink 文件」的攻击路径不适用 junction。junction 父目录的
 *     路径解析已被 isRealPathInside 防住。
 */
// R33-Bug-1 修复 (CRITICAL write-file-no-follow-flag-mismatch)：原版把
// O_CREAT 硬编码为 0x40、O_EXCL 硬编码为 0x80 —— 这是 Linux libc 的值，但
// Node.js 的 libuv 层有自己的 remap（O_CREAT=0x100、O_EXCL=0x400），
// 以便跨 Windows / POSIX。直接用 POSIX 值喂给 fsOpen 会被 libuv 当成
// "O_NOCTTY / 未知 bit 解析，O_CREAT 实际从未被设上，fsOpen 走「打开现有文件」
// 路径，目标不存在时返回 ENOENT —— 所有新建笔记 / 新建便签步骤都无法写入。
// 用户在 dev 模式下点「新建笔记」就报 ENOENT，与 notes-watcher 日志看似矛盾的
// 根因就是这个常量错位（watcher 只 readdir 不 open，不受 flag 影响）。
// 修复：从 fs.constants 拿真实值，并加一行注释解释为什么不能 hard-code。
const O_WRONLY = (fsConstants as { O_WRONLY: number }).O_WRONLY
const O_CREAT = (fsConstants as { O_CREAT: number }).O_CREAT
const O_EXCL = (fsConstants as { O_EXCL: number }).O_EXCL
const O_TRUNC = (fsConstants as { O_TRUNC: number }).O_TRUNC
// O_NOFOLLOW 在 fs.constants 里 Windows 上是 undefined —— 此时 unlink
// + O_EXCL 重建（line 156-168）已经覆盖「不跟随 symlink」语义。
const O_NOFOLLOW: number | undefined = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW

async function writeFileNoFollow(targetPath: string, content: string): Promise<void> {
  // R19 修复 (high security)：existed 用 lstatSync 取代 existsSync。
  // existsSync 跟随 symlink —— dangling symlink（target 不存在）会返回
  // false，导致下面的「if (existed) lstat 检查 symlink」分支被跳过，
  // O_EXCL 创建直接落到 symlink target，把内容写到攻击者指定的位置
  // （例如 Startup folder）。lstat 不跟随，dangling symlink 也会命中
  // st.isSymbolicLink() 分支被拒。
  const { lstat } = await import('node:fs/promises')
  let existed = false
  try {
    const st = await lstat(targetPath)
    if (st.isSymbolicLink()) {
      throw new Error(
        `writeFileNoFollow: refusing to write through symlink/junction at ${targetPath}`,
      )
    }
    existed = true
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('writeFileNoFollow:')) throw err
    // ENOENT 等其它错误 → 不存在，可走新建路径
    existed = false
  }
  if (process.platform === 'win32') {
    // Windows 平台：libuv 不实现 O_NOFOLLOW，靠 O_EXCL 原子创建。
    // 覆盖现有普通文件：先 unlink 再用 O_EXCL 重建。
    // unlink symlink 不会跟随 target（删除的是 symlink 本身），所以这里
    // 也安全。
    if (existed) {
      await unlink(targetPath)
    }
    // 用 O_CREAT|O_EXCL 原子创建。若攻击者在 lstat 后塞入 symlink，O_EXCL
    // 仍会以 EEXIST 失败 —— TOCTOU 窗口被收到「lstat 通过但 open 失败」，
    // 调用方拿到错误即中止。
    const handle = await fsOpen(targetPath, O_WRONLY | O_CREAT | O_EXCL)
    try {
      await handle.writeFile(content, 'utf-8')
    } finally {
      await handle.close()
    }
    return
  }
  // POSIX 路径：保留 R17 的原子 O_NOFOLLOW + O_EXCL/O_TRUNC 实现。
  // R33-Bug-1 续：O_NOFOLLOW 在 Windows 上是 undefined，FS-friendly 兜底为 0
  // （POSIX 上 O_NOFOLLOW 是有意义的 no-symlink 标志，Windows 不支持）。
  const flags = existed
    ? O_WRONLY | O_TRUNC | (O_NOFOLLOW ?? 0)
    : O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0)
  const handle = await fsOpen(targetPath, flags as unknown as number)
  try {
    await handle.writeFile(content, 'utf-8')
  } finally {
    await handle.close()
  }
}

/** 笔记文件扩展名 */
const EXT = '.md'

class NotesManagerImpl {
  /** 获取当前笔记目录路径 */
  async getNotesDir(): Promise<string | null> {
    const lib = await getCurrentLibrary()
    return notesWatchDir(lib)
  }

  /** 确保笔记目录存在 */
  async ensureNotesDir(): Promise<string | null> {
    const dir = await this.getNotesDir()
    if (!dir) return null
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
    return dir
  }

  /** 启动文件系统监听 */
  async startWatching(): Promise<{ ok: boolean; hydrated: number; dir: string | null }> {
    const dir = await this.ensureNotesDir()
    if (!dir) {
      log.warn('[notes-manager] no library path; skip watch')
      return { ok: false, hydrated: 0, dir: null }
    }
    await notesWatcher.start(dir)
    // 首次启动时把已有文件入库（chokidar 也会发 add，但这里保证 stats 等信息齐全）
    const hydrated = await notesWatcher.hydrateFromDisk()
    log.info(`[notes-manager] watching ${dir}, hydrated ${hydrated} files`)
    return { ok: true, hydrated, dir }
  }

  /** 停止监听 */
  async stopWatching(): Promise<void> {
    await notesWatcher.stop()
  }

  /** 列出笔记（默认排除归档） */
  async listNotes(opts: {
    archived?: boolean
    starred?: boolean
    limit?: number
  } = {}): Promise<NoteMeta[]> {
    return notesRepo.findAll({ archived: opts.archived, starred: opts.starred, limit: opts.limit })
  }

  async listStarred(): Promise<NoteMeta[]> {
    return notesRepo.findStarred()
  }

  async listArchived(): Promise<NoteMeta[]> {
    return notesRepo.findArchived()
  }

  /** 按标签筛选 */
  async listByTag(tag: string, folderId?: string | null): Promise<NoteMeta[]> {
    return notesRepo.findByTag(tag, folderId)
  }

  /** 搜索 */
  async searchNotes(
    query: string,
    limit = 50,
    folderId?: string | null,
  ): Promise<NoteMeta[]> {
    return notesRepo.search(query, limit, folderId)
  }

  /** 读取笔记：返回正文 + 元数据 + frontmatter */
  async readNote(path: string): Promise<Note | null> {
    // 安全：仅允许读取笔记目录下的文件，防止渲染端读取任意系统文件
    // R16：realpath 解析后再包含判断，拦下 symlink 逃逸（git 同步进来的
    // symlink / 用户手工创建的 ln -s）。
    const dir = await this.getNotesDir()
    if (!dir || !(await isRealPathInside(dir, path))) {
      log.warn(`[notes-manager] readNote: rejected path outside notes dir: ${path}`)
      return null
    }
    if (!existsSync(path)) {
      log.warn(`[notes-manager] readNote: file not found ${path}`)
      return null
    }
    const content = await readFile(path, 'utf-8')
    const parsed = parseFrontmatter(content)

    // BUG-13-fix：磁盘上的 mtime 可能比 DB 行的 mtime 新（外部进程修改、chokidar
    // 还没把事件刷过来等）。这里若发现 disk 比 DB 新，先 upsertFromFile 把 DB 行
    // 同步上来，再读出最新的 meta —— 否则前端拿到的是过期 title / tags / mtime。
    const { stat } = await import('node:fs/promises')
    const stats = await stat(path)
    let meta = await notesRepo.findByPath(path)
    const diskMtime = stats.mtime.toISOString()
    if (!meta || meta.mtime < diskMtime) {
      meta = await notesRepo.upsertFromFile(path, content, parsed, stats)
    }

    const now = new Date().toISOString()
    const out: Note = {
      id: meta?.id ?? (typeof parsed.data.id === 'string' ? parsed.data.id : crypto.randomUUID()),
      path,
      filename: basename(path),
      title:
        (typeof parsed.data.title === 'string' && parsed.data.title) ||
        meta?.title ||
        basename(path, EXT),
      size: Buffer.byteLength(content, 'utf8'),
      mtime: meta?.mtime ?? now,
      ctime: meta?.ctime ?? now,
      tags: Array.isArray(parsed.data.tags)
        ? parsed.data.tags.map(String)
        : meta?.tags ?? [],
      isPinned: false,
      isFavorite: meta?.isFavorite ?? false,
      folderId: meta?.folderId ?? null,
      content: parsed.content,
    }
    // 读取后让 conflict resolver 知晓磁盘内容（视作一次 hydrate）
    conflictResolver.onDiskChange(path, content)
    return out
  }

  /**
   * 写入笔记
   * - input.filename 可选：未提供则用 title 派生
   * - input.content 为纯正文（不含 frontmatter）
   * - input.frontmatter 为附加元数据（id / tags / starred / archived 等）
   *
   * 行为：
   *   - 自动维护 frontmatter 块（id / created / modified / title）
   *   - 通过 conflict resolver 标记"已写盘"
   *   - 调用方拿到完整 Note
   */
  async writeNote(input: {
    path?: string
    filename?: string
    content: string
    frontmatter?: NoteFrontmatter
    /** BUG-5 fix：创建时直接落到指定文件夹 */
    folderId?: string | null
  }): Promise<Note> {
    const dir = await this.ensureNotesDir()
    if (!dir) throw new Error('笔记目录不存在，请先在设置中配置库目录')

    const now = new Date().toISOString()
    const incomingFm: NoteFrontmatter = { ...(input.frontmatter ?? {}) }
    const inferredTitle =
      typeof incomingFm.title === 'string' && incomingFm.title.trim()
        ? incomingFm.title
        : (input.content.split('\n').find((l) => l.trim().length > 0) ?? '').replace(/^#+\s*/, '').slice(0, 80) ||
          input.filename?.replace(/\.md$/i, '') ||
          '未命名笔记'
    const normalized = normalizeFrontmatter(incomingFm, {
      title: inferredTitle,
      content: input.content,
      now,
    })

    let targetPath = input.path
    if (!targetPath) {
      const filename = sanitizeFilename(
        input.filename ?? `${normalized.title ?? 'untitled'}${EXT}`,
      )
      targetPath = join(dir, filename)
      // R15 修复 (high)：新文件分支原版缺少 isPathInside 校验，
      // sanitizeFilename 只剥离 [\\/:*?"<>|] 而不处理 `..`。
      // 输入 filename='../escape.md' 时：sanitizeFilename 不动 `..`（无分隔符），
      // join(dir, '../escape.md') 解析到 dir 之上 → 文件被写到笔记目录外。
      // 即便用户触发不到，XSS / 受损渲染端 / AI 工具也可触发。
      // R16 修复 (low)：写新文件 target 还不存在，realpath 会 ENOENT → isRealPathInside
      // 内部降级回 isPathInside 词法检查，等价于 R15 的逻辑。
      if (!(await isRealPathInside(dir, targetPath))) {
        throw new Error('writeNote: target path escapes notes directory')
      }
      // 同名冲突：追加 -<short uuid>
      if (existsSync(targetPath)) {
        const id8 = crypto.randomUUID().slice(0, 8)
        const dot = filename.lastIndexOf('.')
        const newName =
          dot > 0 ? `${filename.slice(0, dot)}-${id8}${filename.slice(dot)}` : `${filename}-${id8}`
        targetPath = join(dir, newName)
        // 重命名后再次校验（理论不会越界，防御性）
        if (!(await isRealPathInside(dir, targetPath))) {
          throw new Error('writeNote: target path escapes notes directory')
        }
      }
    } else {
      // R7G-4 修复：之前强制把 targetPath 设为 join(dir, basename) 把目录部分
      // 丢掉了，导致「把笔记移到 work/ 子目录」的需求退化为「留在根目录」。
      // 现在保留调用方传入的 dirname，但必须保证拼出来的最终路径仍在 notesDir 下。
      const incomingDir = dirname(targetPath)
      const fileNameOnly = basename(targetPath, extname(targetPath))
      const safeName = sanitizeFilename(fileNameOnly)
      // 父目录在 notesDir 内 → 用它；否则 → 退回到 notesDir 根（防止穿越）
      // R16：父目录的判断同步切到 realpath 版本（防止 incomingDir 本身是 symlink）。
      const safeDir = (await isRealPathInside(dir, incomingDir)) ? incomingDir : dir
      targetPath = join(safeDir, safeName + EXT)
      if (!(await isRealPathInside(dir, targetPath))) {
        throw new Error('writeNote: target path escapes notes directory')
      }
    }

    // 确保父目录存在
    await mkdir(dirname(targetPath), { recursive: true })

    // R11 修复 (high #5)：写盘前检查 conflictResolver 状态。
    // 原版 writeNote 无视状态机直接 writeFile，导致冲突期间（用户已被 ConflictDialog
    // 告知但尚未点解决）的 autosave 静默覆盖用户在另一编辑器做出的改动。现在
    // 在 conflict 状态下抛错，让 NoteEditor 的 autosave 拿到错误并标 dirty / 提示
    // 用户「需先解决冲突」；仅在 keepLocal 时（用户明确选「保留本地」）才允许写入。
    const conflictState = input.path ? conflictResolver.get(input.path) : null
    if (conflictState && conflictState.state === 'conflict') {
      throw new Error('writeNote: conflict unresolved — please resolve before saving')
    }

    // 序列化 frontmatter
    const fullText = stringifyFrontmatter(input.content, normalized as Record<string, unknown>)
    // R26-Corr-1 修复 (high race)：原版「writeFileNoFollow → skipNextEvents」
    // 顺序有问题 —— chokidar 用 awaitWriteFinish.stabilityThreshold=200ms 等文
    // 件稳定后再发事件，看起来 300ms 防抖窗口足够覆盖；但 chokidar 的 add
    // 事件（新建文件）可以**在 fs.open 写入第一个字节前**就 fire，与稳定性
    // 检测无关；同时大文件 writeFileNoFollow 耗时 >300ms 时，change 事件会
    // 在写盘完成**之前**进入防抖队列，但此时 skipNextEvents 还没被调用 →
    // handle() 在 skipNextEvents 落地后跑时，isSelfWrite 才刚被设上，但
    // schedule 早已入队。下游仍然会跑一遍真实的 upsert + note_events INSERT，
    // 热力图 +1，git autoSync 把同一次保存当作两次外部修改提交。
    // 修复：writeFileNoFollow 之前就调 skipNextEvents，让 chokidar 在 write
    // 期间触发的 add/change 已经在 schedule() 入口被认作自写。如果 write 失
    // 败抛错，我们让 TTL 自然过期（2s 即可），不污染后续真实外部事件。
    notesWatcher.skipNextEvents(targetPath)
    // R17：writeFileNoFollow 内置 O_NOFOLLOW + O_EXCL/O_TRUNC，原子开 fd，
    // 防止「isRealPathInside 通过 → 攻击者 symlink 换靶 → writeFile 跟随」
    // 的 TOCTOU 窗口。
    await writeFileNoFollow(targetPath, fullText)

    // 更新冲突状态：内存→磁盘 视为 write
    conflictResolver.onMemoryWrite(targetPath, fullText)

    // BUG-5 fix：新建笔记时若指定了 folderId，先确保 DB 行存在再把 folder_id 写上，
    // 这样 readNote 才能把 folderId 带回前端（避免一次额外的 IPC + UPDATE）。
    // 已有 DB 行的重命名场景（moveToFolder）由调用方单独处理，这里不动。
    if (input.folderId !== undefined && !input.path) {
      const { stat } = await import('node:fs/promises')
      const stats = await stat(targetPath)
      const parsedNote = parseFrontmatter(fullText)
      const meta = await notesRepo.upsertFromFile(targetPath, fullText, parsedNote, stats)
      await notesRepo.updateMeta(meta.id, { folderId: input.folderId })
    }

    // 读取并返回最新 Note
    const note = await this.readNote(targetPath)
    if (!note) throw new Error('writeNote: failed to read back note')
    return note
  }

  /** 删除笔记（同时删除文件与元数据） */
  async deleteNote(path: string): Promise<boolean> {
    // 安全：仅允许删除笔记目录下的文件
    // R16：realpath 后再判断，防止 symlink 路径绕过（unlink 符号链接本身是安全的，
    // 但若用户把系统文件软链接到笔记目录，deleteNote 把 symlink 删了等同于把系统
    // 文件的引用计数 -1，无害；但若 caller 后续还会把 path 当成"原本的文件"使用，
    // isPathInside 必须拒掉这种 path）。
    const dir = await this.getNotesDir()
    if (!dir || !(await isRealPathInside(dir, path))) {
      log.warn(`[notes-manager] deleteNote: rejected path outside notes dir: ${path}`)
      return false
    }
    let removedFile = false
    try {
      if (existsSync(path)) {
        // R27-Corr-4 修复 (medium race)：原版 `await unlink` 之后才调
        // notesWatcher.skipNextEvents(path) —— macOS fsevents 在某些
        // 路径上会让 chokidar unlink 事件在 unlink await resolve 之前
        // 同步派发到 notesWatcher handler；handler 看到「DB row 还在」
        // 触发 syncFromFs 走 deleteByPath + 后续表里 emit。后果：
        // notesWatcher 自己的 INSERT/UPDATE 流程与本次 deleteByPath
        // 在并发的 IPC 路径上交叉，可能让 row 短暂复活 / 删错文件。
        // 修复：先注册 skipNextEvents 再 unlink，保证 chokidar 派发
        // unlink 事件时一定命中 skip 集合。
        notesWatcher.skipNextEvents(path)
        await unlink(path)
        removedFile = true
      }
    } catch (err) {
      log.warn(`[notes-manager] deleteNote: failed to remove file ${path}`, err)
    }
    await notesRepo.deleteByPath(path)
    conflictResolver.onDelete(path)
    return removedFile
  }

  /**
   * 报告内存侧编辑（让 conflict resolver 知晓）。
   * 渲染端在 textarea onChange 中调用。
   */
  reportMemoryEdit(path: string, content: string) {
    conflictResolver.onMemoryEdit(path, content)
  }

  /** 获取当前冲突状态 */
  getFileState(path: string) {
    return conflictResolver.get(path)
  }

  /** 获取所有状态 */
  allFileStates() {
    return conflictResolver.all()
  }

  /** 解决冲突 */
  resolveConflict(path: string, resolution: ConflictResolution, mergedContent?: string) {
    return conflictResolver.resolve(path, resolution, mergedContent)
  }

  /** 获取所有出现过的标签 */
  async allTags(): Promise<string[]> {
    return notesRepo.allTags()
  }

  /**
   * 重命名文件（保持 frontmatter 的 title 同步）
   */
  async renameNote(path: string, newTitle: string): Promise<Note | null> {
    // 安全：仅允许重命名笔记目录下的文件
    // R16：realpath 后再判断（symlink 不能绕过）。
    const dir = await this.getNotesDir()
    if (!dir || !(await isRealPathInside(dir, path))) {
      log.warn(`[notes-manager] renameNote: rejected path outside notes dir: ${path}`)
      return null
    }
    if (!existsSync(path)) return null
    // 清理 newTitle 中的换行 / YAML 控制字符，防止注入到 frontmatter 后破坏 YAML 结构
    const safeTitle = String(newTitle ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 200)
    const content = await readFile(path, 'utf-8')
    const parsed = parseFrontmatter(content)
    const fm: NoteFrontmatter = {
      ...parsed.data,
      title: safeTitle,
      modified: new Date().toISOString(),
    }
    const text = stringifyFrontmatter(parsed.content, fm as Record<string, unknown>)
    // R17：writeFileNoFollow 防 renameNote 内 writeFile 的 TOCTOU 同款漏洞。
    await writeFileNoFollow(path, text)
    // R11 修复 (medium #11)：renameNote 自己 writeFile，却没有像 writeNote /
    // deleteNote 那样调 notesWatcher.skipNextEvents(path)，导致 chokidar 把
    // 自己刚写的 rename 当成外部编辑事件，触发冗余 DB upsert + 假的 note_events
    // 'edit' 记录（热力图 double-count）。补上 skipNextEvents。
    notesWatcher.skipNextEvents(path)
    conflictResolver.onMemoryWrite(path, text)
    return this.readNote(path)
  }

  /**
   * 移动文件（暂仅在同一笔记目录下移动）
   * - 简易实现：rename 到新路径
   */
  async moveNote(fromPath: string, toPath: string): Promise<Note | null> {
    const dir = await this.getNotesDir()
    if (!dir) throw new Error('笔记目录不存在，请先在设置中配置库目录')

    // 校验：源路径与目标路径都必须落在笔记目录下；
    // 进一步要求 toPath 的 dirname 必须严格等于笔记目录，避免跨级 rename。
    // R16：realpath 后再判断（防止 symlink 绕过）。
    if (!(await isRealPathInside(dir, fromPath))) {
      log.warn(`[notes-manager] moveNote: fromPath escapes notesDir: ${fromPath}`)
      return null
    }
    if (!(await isRealPathInside(dir, toPath))) {
      log.warn(`[notes-manager] moveNote: toPath escapes notesDir: ${toPath}`)
      return null
    }
    if (resolve(dirname(toPath)) !== resolve(dir)) {
      log.warn(`[notes-manager] moveNote: toPath parent is not notesDir: ${toPath}`)
      return null
    }

    if (!existsSync(fromPath)) return null
    await mkdir(dirname(toPath), { recursive: true })
    // R19 修复 (critical silent data loss)：原版先 fs.rename 再 notesRepo.updatePath，
    // 中间无事务。SIGKILL / OOM / DB 失败 → 文件已搬到新路径，DB 行还在旧路径，
    // chokidar 报 add(toPath) → upsertFromFile 创建新 row（新 id），旧 row
    // 留下孤儿（被 note_events / pin 引用，但已查不到文件）。后果：
    //   1) 同一份笔记在 DB 里出现两条
    //   2) 旧 id 关联的 note_events / pin 找不到文件
    //   3) 用户再操作旧路径时 upsert 又会重新「复活」它
    // 修复策略：「先 DB 后 fs」+ DB 行回滚机制：
    //   1. 先 stat 源文件拿 mtime（rename 后再 stat 会刷新）
    //   2. UPDATE DB（path / filename / mtime）—— 失败则不动文件
    //   3. fs.rename —— 失败则把 DB 行回滚到旧 path
    //   4. 任何一步抛错都进入 catch 块统一处理
    const { stat } = await import('node:fs/promises')
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(fromPath)
    } catch {
      return null
    }
    // 预 UPDATE DB 行（保留 id / FK）—— 不动文件
    let updated: Awaited<ReturnType<typeof notesRepo.updatePath>>
    try {
      updated = await notesRepo.updatePath(fromPath, toPath, stats)
    } catch (err) {
      // R23-DI-1 修复：目标路径已被另一行占用时，notesRepo.updatePath 抛
      // PathCollisionError。文件还没动过，这里向上层返回 null 让 UI 提示
      // 「目标已存在笔记，是否覆盖」之类 —— 不再让「database error」冒泡。
      if (err instanceof PathCollisionError) {
        log.warn(
          `[notes-manager] moveNote: target path occupied (id=${err.existingId}); refusing`,
        )
        return null
      }
      log.error(`[notes-manager] moveNote: db updatePath failed, aborting:`, err)
      throw err
    }
    if (!updated) {
      // 没有原 DB 行（极少见 —— 文件存在于磁盘但 DB 没记录），降级为 upsert。
      // 这里的"没有 DB 行"指 notesRepo.updatePath 返回 null（找不到旧 path
      // 对应的 row），不代表文件不存在。降级路径在文件搬过来后再 upsertFromFile。
      try {
        await rename(fromPath, toPath)
      } catch (err) {
        log.error(`[notes-manager] moveNote: rename failed (no-op upgrade path):`, err)
        throw err
      }
      const content = await readFile(toPath, 'utf-8')
      const parsed = parseFrontmatter(content)
      const freshStats = await stat(toPath)
      await notesRepo.upsertFromFile(toPath, content, parsed, freshStats)
      conflictResolver.onDelete(fromPath)
      conflictResolver.onDiskChange(toPath, content)
      return this.readNote(toPath)
    }
    // 主路径：DB 已更新，下面 fs.rename；若失败要把 DB 行回滚到旧 path。
    try {
      // R27-Corr-15 修复：rename 之前同时把 fromPath 与 toPath 都登记为
      // self-write —— 让 chokidar 在 macOS fsevents 同步派发的 add(unlink)
      // 事件被 watcher skip 掉，避免与本次 DB 行的 updatePath 交叉产生
      // double row。
      notesWatcher.skipNextEvents(fromPath)
      notesWatcher.skipNextEvents(toPath)
      await rename(fromPath, toPath)
    } catch (err) {
      // 回滚 DB 行 —— 失败仅日志（DB 自己也可能挂掉，但这里尽力）
      try {
        const origStats = await stat(fromPath).catch(() => stats)
        await notesRepo.updatePath(toPath, fromPath, origStats)
        log.warn(`[notes-manager] moveNote: rename failed, rolled back DB row`)
      } catch (rollbackErr) {
        log.error(`[notes-manager] moveNote: rollback failed; DB may be inconsistent`, rollbackErr)
      }
      throw err
    }
    // R27-Corr-15 修复 (medium race)：rename 后立即调 conflictResolver 让
    // 旧 path 的 in-memory 状态清掉；chokidar add(toPath) 与 unlink(fromPath)
    // 可能并发到达 watcher handler —— 同 deleteNote 的 macOS fsevents 同步
    // 派发问题。修复同 deleteNote：rename 之前对 fromPath 和 toPath 都调
    // skipNextEvents，让 watcher 把这两个事件标为 self-write；rename 完成
    // 后 chokidar 派发的 add/unlink 命中 skip 集合，不触发 upsert 干扰本次
    // 已 committed 的 DB 行（避免新 row 复用旧 path 造成 double row）。
    conflictResolver.onDelete(fromPath)
    const content = await readFile(toPath, 'utf-8')
    conflictResolver.onDiskChange(toPath, content)
    return this.readNote(toPath)
  }
}

/** 单例 */
export const notesManager = new NotesManagerImpl()

/** 类型导出 */
export type { ParsedNote }
