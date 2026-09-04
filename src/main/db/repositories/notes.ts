/**
 * 笔记元数据仓储
 *
 * 复用 notes 表（path, filename, title, tags_json, starred, archived, mtime, ctime, ...）
 * 提供：
 *   - upsertFromFile: 通过 chokidar 事件写入
 *   - findByPath / findAll / findStarred / findByTag / findArchived
 *   - update / deleteByPath
 *   - search: 按 title/filename 模糊匹配
 */
import { basename } from 'node:path'
import { Stats } from 'node:fs'
import { dbClient } from '../client'
import type { NoteMeta, ISODateTime, ID } from '@shared/types'
import type { ParsedNote } from '../../notes/frontmatter'
import log from '../../log'

interface NoteRow {
  id: string
  path: string
  filename: string
  title: string
  tags_json: string
  starred: number
  archived: number
  mtime: string
  ctime: string
  created_at: string
  updated_at: string
  folder_id: string | null
}

/**
 * 目标路径已被另一行占用。moveNote 抛出后由调用方决定是确认覆盖还是取消。
 *
 * 修复背景：notes.path 是 UNIQUE 索引（001-initial.sql:139）。原 moveNote
 * 直接 UPDATE → SQLITE_CONSTRAINT_UNIQUE → 错误冒泡到用户，没有可操作
 * 的语义。现在用 SELECT 1 预检 + 抛出此类型化错误，让上层 UI 能识别并
 * 提示"目标位置已存在笔记"而不是「database error」。
 */
export class PathCollisionError extends Error {
  readonly kind = 'path-collision' as const
  constructor(public readonly targetPath: string, public readonly existingId: ID) {
    super(`notes.path '${targetPath}' is already occupied by id=${existingId}`)
    this.name = 'PathCollisionError'
  }
}

function rowToMeta(r: NoteRow): NoteMeta {
  return {
    id: r.id,
    path: r.path,
    filename: r.filename,
    title: r.title,
    size: 0, // 暂不存 size，UI 不依赖
    mtime: r.mtime,
    ctime: r.ctime,
    tags: safeJsonArray(r.tags_json),
    isPinned: false,
    isFavorite: !!r.starred,
    folderId: r.folder_id ?? null,
  }
}

function safeJsonArray(s: string): string[] {
  try {
    const arr = JSON.parse(s || '[]')
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

// NOTE: 性能优化（低优先级，未实现）
//   - findAll / findStarred / findArchived 在大量笔记时每次都 prepare 新语句。
//   - 后续可在此仓储内维护一个 LRU stmtId 缓存，按 SQL 文本归一化作为 key，
//     避免重复 prepare 带来的 RPC 开销（better-sqlite3 端 prepare 也有开销）。
//   - 注意：dbClient.prepare 在主进程侧需要保证线程/连接安全，缓存时建议
//     使用单例 Map + WeakRef 防止 prepared statement 句柄泄漏。

/** R26-Corr-7 修复 (medium stmt-leak)：模块级 prepared statement 缓存 + prepare()
 *  helper，让 NotesRepository 走共享 stmtCache（与 stickyNotes 模式一致）。
 * NotesRepository 没继承 Repository 基类（自定义 fromRow 不通用），所以
 * 缓存放在 module scope，并通过 dbClient.registerStmtCacheInvalidator 在
 * worker respawn 时清空。
 */
const notesStmtCache = new Map<string, number>()
let notesInvalidatorRegistered = false

function notesPrepare(sql: string): Promise<number> {
  let id = notesStmtCache.get(sql)
  if (id !== undefined) return Promise.resolve(id)
  if (!notesInvalidatorRegistered) {
    // 首次调用时注册 invalidate 回调；不写进构造器是因为 NotesRepository
    // 没继承 Repository 基类，没有 super() 钩子。
    dbClient.registerStmtCacheInvalidator(() => {
      notesStmtCache.clear()
    })
    notesInvalidatorRegistered = true
  }
  return dbClient
    .call<{ stmtId: number }>('prepare', { sql })
    .then((res) => {
      if (!res) throw new Error('Failed to prepare statement')
      notesStmtCache.set(sql, res.stmtId)
      return res.stmtId
    })
}

/** findAll ORDER BY 白名单：避免把不可信字符串拼进 SQL */
const ALLOWED_ORDER_BY: ReadonlySet<string> = new Set([
  'mtime DESC',
  'mtime ASC',
  'ctime DESC',
  'ctime ASC',
  'created_at DESC',
  'created_at ASC',
  'updated_at DESC',
  'updated_at ASC',
  'title ASC',
  'title DESC',
  'filename ASC',
  'filename DESC',
])

export class NotesRepository {
  /**
   * chokidar 事件调用：从文件 upsert 到 notes 表。
   * - 用 INSERT ... ON CONFLICT(path) DO UPDATE 保证原子性；
   * - WHERE notes.mtime <= excluded.mtime 守卫防止旧事件覆盖新事件。
   * - 冲突时不更新 id / ctime / created_at，保留原行的 id。
   */
  async upsertFromFile(
    fullPath: string,
    _content: string,
    parsed: ParsedNote,
    stats: Stats,
  ): Promise<NoteMeta> {
    const now = new Date().toISOString()
    const filename = basename(fullPath)
    const fm = parsed.data
    const mtime = stats.mtime.toISOString()
    const ctime = stats.ctime.toISOString()

    const title =
      (typeof fm.title === 'string' && fm.title.trim()) ||
      filename.replace(/\.md$/i, '') ||
      '未命名笔记'

    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : []

    const starred = fm.starred ? 1 : 0
    const archived = fm.archived ? 1 : 0

    // 仅在没有现有行时使用该 id；冲突时保留原行 id（不在 SET 中改写 id）
    const candidateId =
      (typeof fm.id === 'string' && fm.id) || crypto.randomUUID()

    // R26-DI-8 修复 (medium mtime-cmp precision)：原版 `notes.mtime <=
    // excluded.mtime` 接受「等 mtime」事件进入 UPDATE 路径，把 updated_at
    // 与 tags_json 重新序列化。某些文件系统（FAT / 网络盘 / 子秒精度丢失）
    // 在同一次写入内可能产生完全相同的 mtime 字符串，导致「写盘 1 次 → DB
    // 重复 UPDATE N 次」 → updated_at 推进 → git autoSync 把无变化的 row
    // 当一次外部修改提交；tags_json 重新序列化还可能改变 key 顺序，破坏
    // byte-equality diff。修复：仅当新 mtime 严格大于 row mtime 才触发
    // UPDATE（用户首次新建时 INSERT 分支不走谓词，新行照样落库）。
    // R28-DI-3：notesPrepare() 共享 cache（这条 SQL 字符串是 module 常量，
    // 完全 cache-friendly）。chokidar 每次 add/change 事件都进这里，
    // 旧版裸 prepare 每事件漏一条 prepared stmt。
    const stmtId = await notesPrepare(
      `INSERT INTO notes (id, path, filename, title, tags_json, starred, archived,
                          mtime, ctime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         filename   = excluded.filename,
         title      = excluded.title,
         tags_json  = excluded.tags_json,
         starred    = excluded.starred,
         archived   = excluded.archived,
         mtime      = excluded.mtime,
         updated_at = excluded.updated_at
       WHERE notes.mtime < excluded.mtime`,
    )
    // 注意：folder_id 不在 SET 列表里 —— chokidar 文件事件不会清掉用户已分配的文件夹
    await dbClient.call('run', {
      stmtId,
      params: [
        candidateId,
        fullPath,
        filename,
        title,
        JSON.stringify(tags),
        starred,
        archived,
        mtime,
        ctime,
        typeof fm.created === 'string' ? fm.created : now,
        now,
      ],
    })

    const meta = await this.findByPath(fullPath)
    if (!meta) throw new Error('upsertFromFile: failed to read back row')
    return meta
  }

  async findByPath(path: string): Promise<NoteMeta | null> {
    // R26-Corr-7 修复 (medium stmt-leak)：原版走裸 dbClient.call('prepare', ...)
    // 不进 stmtCache，每次都新 prepare 一个 statement 但不 finalize —— 笔记
    // 导入 5000+ 文件循环里直接 5000 条 prepared statement 漏在 worker 的
    // prepared-stmt 缓存里，挤掉真实业务的 LRU statement。改为走模块级
    // notesPrepare() 共享 stmtCache 按 SQL 文本去重，worker 端也走同一个
    // prepared statement id。
    const stmtId = await notesPrepare('SELECT * FROM notes WHERE path = ?')
    const row = (await dbClient.call('get', { stmtId, params: [path] })) as NoteRow | null
    return row ? rowToMeta(row) : null
  }

  async findById(id: ID): Promise<NoteMeta | null> {
    // R26-Corr-7 修复 (medium stmt-leak)：见 findByPath 注释。
    const stmtId = await notesPrepare('SELECT * FROM notes WHERE id = ?')
    const row = (await dbClient.call('get', { stmtId, params: [id] })) as NoteRow | null
    return row ? rowToMeta(row) : null
  }

  /**
   * 列出全部未归档笔记，按 mtime DESC。
   * - archived = undefined: 包含全部
   * - archived = false: 仅未归档
   * - archived = true: 仅归档
   */
  async findAll(opts: {
    archived?: boolean
    starred?: boolean
    limit?: number
    orderBy?: string
  } = {}): Promise<NoteMeta[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (typeof opts.archived === 'boolean') {
      where.push('archived = ?')
      params.push(opts.archived ? 1 : 0)
    }
    if (typeof opts.starred === 'boolean') {
      where.push('starred = ?')
      params.push(opts.starred ? 1 : 0)
    }
    const orderBy = ALLOWED_ORDER_BY.has(opts.orderBy ?? '') ? (opts.orderBy as string) : 'mtime DESC'
    // R5S-5：opts.limit 非数字（NaN / 字符串）会被拼成 "LIMIT NaN"，prepare 时直接抛错。
    //
    // R25-DI-4 修复 (low)：原版即便数字合法，仍把 LIMIT 值字符串拼到 SQL
    // 里（` LIMIT ${Math.floor(n)}`），虽是受信任的 Number 转换但保留「SQL
    // 拼字符串」的隐患。SQLite 3.32+ 支持 `LIMIT ?` 绑定参数。改为参数
    // 化：limit > 0 时绑定 ?，否则省略 LIMIT 子句。
    //
    // Perf-fix #2：未传 opts.limit 时强制走默认上限（200）。原本 `NOTE_LIST`
    // renderer 经常省略该参数 → 无界 SELECT * → 数千笔记一次性走 IPC +
    // structured clone → 主进程阻塞数百 ms。设 200 兼容 sidebar 「最近笔记
    // 列表」的实际需求；想全量请显式传 limit（pagination 后续再加）。
    const n = Number(opts.limit)
    const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200
    const sql = `SELECT * FROM notes WHERE ${where.join(' AND ') || '1=1'} ORDER BY ${orderBy} LIMIT ?`
    // R28-DI-3 修复 (medium resource-leak)：原版裸 prepare 不进 cache
    // 也不 finalize，每次 findAll 调用（包括 sidebar 每次切换筛选条件）
    // 都新增一条 prepared statement 到 worker stmtCache，FIFO 满了之后
    // evict 正在跑的 stmtId → 下一次 all() 拿到 undefined row。改为走
    // notesPrepare() 共享 cache（同一 SQL 文本复用 stmtId），不再单独
    // finalize —— cache 自然管理生命周期。
    const stmtId = await notesPrepare(sql)
    params.push(limit)
    const rows = (await dbClient.call('all', { stmtId, params })) as NoteRow[]
    return rows.map(rowToMeta)
  }

  async findStarred(limit = 50): Promise<NoteMeta[]> {
    return this.findAll({ starred: true, archived: false, limit, orderBy: 'mtime DESC' })
  }

  async findArchived(limit = 200): Promise<NoteMeta[]> {
    return this.findAll({ archived: true, limit, orderBy: 'mtime DESC' })
  }

  /**
   * 按文件夹过滤：
   *  - folderId = string  → 仅在该文件夹
   *  - folderId = null    → 仅未分类
   *  - folderId = undefined → 不过滤（向后兼容）
   *
   * archived（与 findAll 对齐）：
   *  - archived = undefined → 不过滤（包含归档与未归档）
   *  - archived = false     → 仅未归档
   *  - archived = true      → 仅归档
   */
  async findByFolder(
    folderId: ID | null | undefined,
    opts: { archived?: boolean; limit?: number } = {},
  ): Promise<NoteMeta[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (folderId === null) {
      where.push('folder_id IS NULL')
    } else if (typeof folderId === 'string') {
      where.push('folder_id = ?')
      params.push(folderId)
    }
    if (typeof opts.archived === 'boolean') {
      where.push('archived = ?')
      params.push(opts.archived ? 1 : 0)
    }
    // R5S-5：NaN 守卫，与 findAll 对齐
    //
    // R25-DI-4 修复 (low)：与 findAll 同步改 LIMIT ? 绑定参数（见 findAll 注释）。
    const n = Number(opts.limit)
    let sql: string
    let stmtId: number
    if (Number.isFinite(n) && n > 0) {
      sql = `SELECT * FROM notes WHERE ${where.join(' AND ') || '1=1'} ORDER BY mtime DESC LIMIT ?`
      // R28-DI-3：与 findAll 同理，notesPrepare() 共享 cache，cache 自
      // 然管理 stmt 生命周期，不再 finalize。
      stmtId = await notesPrepare(sql)
      params.push(Math.floor(n))
    } else {
      sql = `SELECT * FROM notes WHERE ${where.join(' AND ') || '1=1'} ORDER BY mtime DESC`
      stmtId = await notesPrepare(sql)
    }
    const rows = (await dbClient.call('all', { stmtId, params })) as NoteRow[]
    return rows.map(rowToMeta)
  }

  /**
   * 把笔记移到指定文件夹；folderId === null 移到「未分类」。
   * 返回更新后的 NoteMeta。
   *
   * R20 修复 (medium lost-update)：原 UPDATE 无 CAS 谓词，并发 updateMeta() 用
   * updated_at CAS WHERE 命中时 → 当前会话写最新 mtime → 本会话再 UPDATE
   * folder_id 会把 updateMeta 的 mtime 覆盖 → updateMeta 后续的依赖 mtime
   * 单调的逻辑（如热力图 / 最近编辑列表）出现「移动文件夹后 mtime 倒退」。
   * 修复：用 existing.updated_at 做 CAS WHERE 谓词，CAS 失败 → 重新读最新
   * row 再次尝试，循环 max 3 次后报错。
   *
   * R21 修复 (high data integrity)：原版用 `existing.mtime` 作为 CAS 谓词的
   * 期望值（`WHERE updated_at = existing.mtime`）—— NoteMeta 只暴露 mtime
   * 字段，没暴露 updated_at，且 notes 表的 mtime 由 chokidar upsert 写入
   * （文件最后修改时间，秒级精度），与 CAS 谓词列 updated_at 是**两条独立
   * 列**。后果：
   *   - 当 mtime === updated_at 时（典型：用户手动编辑后立即把笔记拖到
   *     新文件夹），CAS 正常 work；
   *   - 当 mtime < updated_at 时（典型：chokidar 检测到文件修改 → upsert
   *     写 mtime=fs.mtime → 之后 updateMeta 又把 updated_at 推到 now > mtime），
   *     本函数的 CAS 谓词 `updated_at = mtime` 永远不命中 → 3 次重试后
   *     log warn + 仍调用 findById 返回最新 row —— 看上去成功了，但
   *     `folder_id` **从未被写入**（因为 changes 始终 = 0）。整个
   *     moveToFolder 是个静默失败的 no-op，用户的「拖到文件夹」操作
   *     在 UI 上看似成功（没报错），但下次重启 DB 后笔记还在原文件夹。
   * 修复：仿照 updateMeta 的做法，**直接 SELECT * 拿 NoteRow**（带
   * updated_at 列），用 NoteRow.updated_at 做 CAS 谓词；NoteRow 是仓储内部
   * 类型不外泄，不破坏 NoteMeta API。
   */
  async moveToFolder(id: ID, folderId: ID | null): Promise<NoteMeta | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // R26-Corr-1 修复 (medium stmt-leak)：原 findRowStmtId 走裸 prepare 不进
      // stmtCache，3 次 CAS 循环 × 任意高频 moveToFolder 调用累积数对未 finalize
      // 的 statement。改为走 notesPrepare() 共享 stmtCache，单 SQL 文本永远
      // 同一个 stmtId（worker 端也共享 prepared statement，零额外开销）。
      const findRowStmtId = await notesPrepare('SELECT * FROM notes WHERE id = ?')
      const existing = (await dbClient.call('get', {
        stmtId: findRowStmtId,
        params: [id],
      })) as NoteRow | null
      if (!existing) return null
      const now = new Date().toISOString()
      // R26-Corr-2 修复 (medium stmt-leak)：原 UPDATE stmtId 同样裸 prepare 且
      // 不 finalize，每次 CAS 失败重试也漏一条。共享 stmtCache 后 worker 端
      // 复用 prepared statement；不走 try/finally finalize（cache 不能破坏）
      // —— 依赖 worker LRU 兜底即可。
      const stmtId = await notesPrepare(
        'UPDATE notes SET folder_id = ?, updated_at = ? WHERE id = ? AND updated_at = ?',
      )
      const result = (await dbClient.call('run', {
        stmtId,
        params: [folderId, now, id, existing.updated_at],
      })) as { changes?: number }
      if (result?.changes === 1) return this.findById(id)
      // CAS 失败 → 重试
    }
    // R21：3 次重试失败说明持续并发冲突（极罕见）。原版静默 return findById
    // 让用户以为成功了 —— 改为抛错让 IPC 层把它透传给渲染端。修复这个
    // silent-failure 后，UI 可弹 toast 告知用户「文件夹移动失败，请重试」。
    log.warn('[notes] moveToFolder CAS failed after 3 attempts:', id)
    throw new Error(
      `[notes.moveToFolder] failed to move note ${id} to folder ${folderId ?? '<uncategorized>'} after 3 CAS attempts (concurrent update conflict)`,
    )
  }

  /**
   * 按 tag 名查找：使用 json_each() 解析 tags_json，避免 LIKE 通配符注入。
   * folderId（可选）：
   *   - string → 仅在该文件夹
   *   - null   → 仅未分类
   *   - undefined → 跨文件夹
   */
  async findByTag(
    tag: string,
    folderId?: ID | null,
    limit = 100,
  ): Promise<NoteMeta[]> {
    const tagStr = String(tag ?? '')
    if (!tagStr) return []
    const where: string[] = ['t.value = ?']
    const params: unknown[] = [tagStr]
    if (folderId === null) {
      where.push('n.folder_id IS NULL')
    } else if (typeof folderId === 'string') {
      where.push('n.folder_id = ?')
      params.push(folderId)
    }
    const sql = `SELECT DISTINCT n.*
                 FROM notes n, json_each(n.tags_json) AS t
                 WHERE ${where.join(' AND ')}
                 ORDER BY n.mtime DESC
                 LIMIT ?`
    params.push(limit)
    // R28-DI-3：notesPrepare() 共享 cache，cache 自行管理 stmt 生命周期，
    // 同一 SQL 文本重复调用命中 cache，不再每 keystroke 漏一条 prepared stmt。
    const stmtId = await notesPrepare(sql)
    const rows = (await dbClient.call('all', { stmtId, params })) as NoteRow[]
    return rows.map(rowToMeta)
  }

  /**
   * 搜索：title / filename 模糊匹配。
   * folderId（可选）：
   *   - string → 仅在该文件夹
   *   - null   → 仅未分类
   *   - undefined → 跨文件夹
   */
  async search(
    query: string,
    limit = 50,
    folderId?: ID | null,
  ): Promise<NoteMeta[]> {
    const q = query.trim()
    if (!q) return []
    // R12 修复 (low)：LIKE pattern 必须先转义反斜杠本身，再转义 % 和 _。
    // 否则用户搜 "\test" 会把 "\" 当字面字符，但 SQLite 的 ESCAPE '\' 会
    // 把后续的字符当作转义候选，匹配结果错位。
    const like = `%${q.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&')}%`
    const where: string[] = [
      "(title LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\')",
    ]
    const params: unknown[] = [like, like]
    if (folderId === null) {
      where.push('folder_id IS NULL')
    } else if (typeof folderId === 'string') {
      where.push('folder_id = ?')
      params.push(folderId)
    }
    params.push(limit)
    const sql = `SELECT * FROM notes
                 WHERE ${where.join(' AND ')}
                 ORDER BY mtime DESC
                 LIMIT ?`
    // R28-DI-3：同 findByTag，notesPrepare() 共享 cache。
    const stmtId = await notesPrepare(sql)
    const rows = (await dbClient.call('all', { stmtId, params })) as NoteRow[]
    return rows.map(rowToMeta)
  }

  /**
   * 更新元数据字段（星标/归档/标签/标题）。
   * - 用于笔记编辑器侧栏的元数据修改
   * - 只覆盖 patch 中显式给出的字段；未给出的字段（starred / archived 等）
   *   一律沿用现有行值，避免误把已归档的笔记取消归档。
   *
   * R15 修复 (high)：原来 SELECT + UPDATE 之间跨了两次 dbClient.call（异步 IPC），
   * 两个并发 updateMeta 都会读到相同的 existing，再各自 merge 自己的 patch 写回去，
   * 后写者覆盖先写者（lost-update）。改为在同一事务里：
   *   BEGIN; SELECT (拿 expectedUpdatedAt); UPDATE ... WHERE id=? AND updated_at=expectedUpdatedAt; COMMIT
   * 并发更新时第二个事务的 changes=0 → 抛 Conflict，渲染端可重新拉数据再决定。
   */
  async updateMeta(
    id: ID,
    patch: {
      starred?: boolean
      archived?: boolean
      tags?: string[]
      title?: string
      /** BUG-5 fix：把笔记直接归入文件夹（或 NULL = 未分类） */
      folderId?: ID | null
    },
  ): Promise<NoteMeta | null> {
    // R24-DI-1 修复 (high atomicity)：原版 BEGIN/COMMIT 跨多次 dbClient.call
    // IPC，让出事件循环。两个并发 updateMeta（用户连点星标 / AI 工具 + 用户
    // 操作 / 多窗口同步触发）会让第二个 BEGIN 撞上第一个未提交事务 →
    // 「cannot start a transaction within a transaction」 → 第二个 catch 块
    // 对**第一个**事务发 ROLLBACK 错杀。修复：用 dbClient.runInTransaction
    // 串行化，事务互斥锁保证前一个事务完全收尾前 work 不会启动。
    return await dbClient.runInTransaction(async () => {
      await dbClient.call('exec', { sql: 'BEGIN' })
      try {
        // R25-DI-7 修复 (high data integrity)：原版的 findRowStmtId 与
        // 后面的 UPDATE stmtId 都不 finalize —— runInTransaction 只串行化
        // 事务不负责清缓存。moveToFolder 的 3-attempt CAS 循环每次失败都
        // 漏一对 stmtId，updateMeta 每次冲突也漏一对，hot path 下累积。
        // 改为 findRowStmtId 用 try/finally 兜底 finalize；UPDATE stmtId 走
        // prepare() 命中 Repository.stmtCache（同一 SQL 文本共享同一 stmtId），
        // 这里就不重复 finalize（避免把 cache 里的 id 误删导致下个调用重新
        // prepare），改成依赖 worker LRU 兜底。但 findRowStmtId 不进缓存（直
        // 接 dbClient.call('prepare', ...) 而不是 this.prepare()），所以必须
        // finalize。
        const findRowStmtId = (
          await dbClient.call<{ stmtId: number }>('prepare', {
            sql: 'SELECT * FROM notes WHERE id = ?',
          })
        ).stmtId
        let existing: NoteRow | null = null
        try {
          existing = (await dbClient.call('get', {
            stmtId: findRowStmtId,
            params: [id],
          })) as NoteRow | null
        } finally {
          try {
            await dbClient.call('finalize', { stmtId: findRowStmtId })
          } catch {
            /* worker LRU may have evicted; harmless */
          }
        }
        if (!existing) {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
          return null
        }
        const now = new Date().toISOString()
        const merged: NoteRow = {
          id: existing.id,
          path: existing.path,
          filename: existing.filename,
          title: patch.title ?? existing.title,
          tags_json: JSON.stringify(patch.tags ?? safeJsonArray(existing.tags_json)),
          starred: patch.starred === undefined ? existing.starred : patch.starred ? 1 : 0,
          archived: patch.archived === undefined ? existing.archived : patch.archived ? 1 : 0,
          // R25-DI-1 修复 (high schema-drift)：原版把 `mtime = now` 写进
          // UPDATE。mtime 是「文件最后修改时间」（由 chokidar 在 fs 事件时
          // 从 stat 取来），不应被元数据编辑触碰 —— 这是两个独立的语义
          // 通道。每次点星标 / 改标签 / 改标题都把 mtime 推到 now，结果：
          //   1) 用户在文件管理器里改了 .md 后再没动，但热力图与最近编辑
          //      列表的 mtime 是上次点星标的时间，并非真正的文件修改时间；
          //   2) chokidar 监听 mtime 决定是否重新 upsertFromFile —— 如果
          //      updateMeta 的 mtime 比真实 mtime 还要新，下次文件被 touch
          //      时 chokidar 看到 fs.mtime < notes.mtime → ON CONFLICT
          //      WHERE 谓词失败 → 文件内容改了但 DB 不更新（用户改了
          //      .md 但编辑器读到旧 frontmatter）。
          // 修复：metadata-only UPDATE 不动 mtime；只 push updated_at。
          mtime: existing.mtime,
          ctime: existing.ctime,
          created_at: existing.created_at,
          updated_at: now,
          folder_id:
            patch.folderId === undefined ? (existing.folder_id ?? null) : patch.folderId,
        }
        // R26-Corr-2 修复 (medium stmt-leak)：原 UPDATE 走裸 prepare 不进 stmtCache，
        // 也不 finalize —— 每次 updateMeta 调用漏 1 条 prepared statement，hot
        // path（编辑器连续保存元数据 / 用户连点星标 / AI 工具批量调 updateMeta）
        // 累积漏 statement 直到 worker stmtCache LRU 驱逐业务 statement。改为
        // notesPrepare() 共享 stmtCache，并包 try/finally（防御性 finalize 失败
        // 由 cache 自身负责，不会双重释放）。
        const stmtId = await notesPrepare(
          `UPDATE notes
                SET title = ?, tags_json = ?, starred = ?, archived = ?,
                    folder_id = ?, updated_at = ?
                WHERE id = ? AND updated_at = ?`,
        )
        let result: { changes?: number } | null = null
        // R26 防御：cache 命中的 stmtId 不能在这里 finalize（会被其它调用者
        // 复用时变成 zombie）。worker 端 prepare 已固化 SQL，rebuild 仅在
        // worker respawn 后由 R25-DI-5 invalidator 触发，无需手动清理。
        // 异常直接抛给外层 ROLLBACK 兜底，不再用 try/catch rethrow。
        result = (await dbClient.call('run', {
          stmtId,
          params: [
            merged.title,
            merged.tags_json,
            merged.starred,
            merged.archived,
            merged.folder_id,
            merged.updated_at,
            id,
            existing.updated_at,
          ],
        })) as { changes?: number }
        if (!result || result.changes === 0) {
          // R15：CAS 失败说明中途有另一个 updateMeta / updateFolderId 改了同一行。
          // 抛错让 IPC handler 把错误回传给渲染端，渲染端应重新 fetch 并提示用户。
          await dbClient.call('exec', { sql: 'ROLLBACK' })
          throw new Error(
            'updateMeta: note was modified concurrently — please refresh and retry',
          )
        }
        await dbClient.call('exec', { sql: 'COMMIT' })
        return this.findById(id)
      } catch (err) {
        try {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
        } catch {
          /* ignore */
        }
        throw err
      }
    })
  }

  async deleteByPath(path: string): Promise<boolean> {
    // R28-DI-3：notesPrepare() 共享 cache —— chokidar unlink 事件 + 显
    // 式 delete UI 都会调这里。旧版裸 prepare 不 finalize，每次调用漏
    // 一条 prepared stmt 到 worker cache。
    const stmtId = await notesPrepare('DELETE FROM notes WHERE path = ?')
    const info = (await dbClient.call('run', { stmtId, params: [path] })) as { changes: number }
    return info.changes > 0
  }

  /**
   * R7G-1 修复：把同一笔记的 path / filename 改为新值，保留原 id。
   *
   * 原 moveNote 的"删 + 重 upsert"会触发 upsertFromFile 在新路径下生成
   * 一个全新的 candidateId（当源文件 frontmatter 没有显式 id 时），
   * 让所有引用原 id 的 FK（completions / note_events / 渲染端 pin / 归档）
   * 全部变成孤儿。
   *
   * 这里只用一次 UPDATE 把 path / filename / mtime / updated_at 改成新值，
   * 保持 id / folder_id / starred / archived / tags 不动。
   *
   * R23-DI-1 修复：notes.path 是 UNIQUE 列（001-initial.sql:139）。原版直接
   * UPDATE，若 toPath 已被另一行占用 → `SQLITE_CONSTRAINT_UNIQUE` 抛错，
   * moveNote 的 catch 块只能 `log.error + rethrow`，用户看到一条 "database
   * error" 而原因不明。这里在 UPDATE 之前先 SELECT 1 探测目标路径是否已
   * 被其他行占用；占用则抛 PathCollisionError 让上层决定是否提示用户
   * 确认覆盖或取消。SELECT 走独立 stmtId，try/finally 兜底 finalize 不泄漏
   * 缓存条目。
   */
  async updatePath(
    fromPath: string,
    toPath: string,
    stats: { mtime: Date },
  ): Promise<NoteMeta | null> {
    const now = new Date().toISOString()
    const newFilename = basename(toPath)
    // R30-DI-7 修复 (MEDIUM stmt-cache-leak)：原版每次 moveNote 调用都
    // 裸 prepare 2 条 SQL（探测 SELECT + UPDATE），try/finally finalize
    // 兜底。moveNote 是用户主动操作（folders 重命名 / 笔记拖拽），
    // 频率不高但 SQL 文本完全固定（常量），每次重复 prepare + finalize
    // 多走 2 趟 IPC，worker LRU 也会被无用 prepared 短暂占满（驱逐
    // 其它正常 SQL 的缓存）。改为走 notesPrepare() 共享 stmtCache：
    // SQL 文本相同永远命中 cache，worker respawn 时 invalidator 自动清空。
    if (fromPath !== toPath) {
      const checkStmtId = await notesPrepare('SELECT id FROM notes WHERE path = ?')
      const collide = (await dbClient.call('get', {
        stmtId: checkStmtId,
        params: [toPath],
      })) as { id: string } | null
      if (collide) {
        throw new PathCollisionError(toPath, collide.id)
      }
    }
    const stmtId = await notesPrepare(
      `UPDATE notes
        SET path = ?, filename = ?, mtime = ?, updated_at = ?
        WHERE path = ?`,
    )
    const info = (await dbClient.call('run', {
      stmtId,
      params: [toPath, newFilename, stats.mtime.toISOString(), now, fromPath],
    })) as { changes: number }
    if (info.changes === 0) return null
    return this.findByPath(toPath)
  }

  async count(): Promise<number> {
    // R28-DI-3：sidebar / header 统计每渲染就调一次，notesPrepare() 共
    // 享 cache，旧版每次漏一条 prepared stmt。
    const stmtId = await notesPrepare('SELECT COUNT(*) as c FROM notes')
    const row = (await dbClient.call('get', { stmtId })) as { c: number } | null
    return row?.c ?? 0
  }

  /** 获取所有出现过的标签（去重） */
  async allTags(): Promise<string[]> {
    // R28-DI-3：tag-picker UI 每 keystroke 重查，notesPrepare() 共享 cache。
    const stmtId = await notesPrepare('SELECT tags_json FROM notes')
    const rows = (await dbClient.call('all', { stmtId })) as Array<{ tags_json: string }>
    const set = new Set<string>()
    for (const r of rows) {
      for (const t of safeJsonArray(r.tags_json)) set.add(t)
    }
    return Array.from(set).sort()
  }
}

/** 单例 */
export const notesRepo = new NotesRepository()

/** 兼容旧字段名 - ISODateTime 仅用于类型导出 */
export type { ISODateTime }
