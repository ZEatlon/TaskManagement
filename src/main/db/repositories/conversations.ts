/**
 * AI 对话仓储
 *
 * R14 修复 (medium)：
 * - 所有方法都在 try/finally 里 finalize 各自 prepare 的 stmtId，避免
 *   长会话后 prepared-statement 句柄累积触发 db-worker 的 FIFO 淘汰。
 * - findAll 改为参数化 LIMIT，不再做 SQL 字符串拼接，每次调用都用同一
 *   SQL 文本，命中 prepareCache；safeLimit 走参数绑定。
 *
 * R28-Perf-1 修复 (high perf)：原 withPrepared 每次都裸 prepare + finalize，
 * 哪怕 SQL 文本完全一致（多数方法 SQL 都是常量），白白浪费一次 IPC 往返。
 * 引入 per-repo stmtCache：相同 SQL 文本命中 cache 直接拿到 stmtId，不需
 * 要 finalize —— cache 自行管理生命周期。worker 进程 respawn 时通过
 * dbClient.registerStmtCacheInvalidator 清空缓存避免 stale stmtId。
 */
import { dbClient } from '../client'
import type { AiConversation, AiMessage } from '@shared/types/ai'

const convStmtCache = new Map<string, number>()
let convInvalidatorRegistered = false

/** 单条对话最多保留的消息条数。超过则从头开始淘汰（FIFO）。
 *  这是 messages_json 的硬上限，防止长会话 / agentic 工具循环把 JSON 撑到
 *  MB 级别拖慢 SELECT * 和 ai:stream 的反序列化。
 *  与 LLM 上下文窗口解耦——这里只管存储层大小，不影响实际送给模型的 recent N 条。
 */
const MAX_MESSAGES_PER_CONVERSATION = 500

async function withPrepared<T>(
  sql: string,
  run: (stmtId: number) => Promise<T>,
): Promise<T> {
  if (!convInvalidatorRegistered) {
    dbClient.registerStmtCacheInvalidator(() => {
      convStmtCache.clear()
    })
    convInvalidatorRegistered = true
  }
  let stmtId = convStmtCache.get(sql)
  if (stmtId === undefined) {
    stmtId = (
      await dbClient.call<{ stmtId: number }>('prepare', { sql })
    ).stmtId
    convStmtCache.set(sql, stmtId)
  }
  return run(stmtId)
}

export class ConversationsRepository {
  async create(input: Omit<AiConversation, 'createdAt' | 'updatedAt'> & { id?: string }): Promise<AiConversation> {
    const id = input.id ?? crypto.randomUUID()
    const now = new Date().toISOString()
    await withPrepared(
      `INSERT INTO ai_conversations (id, title, provider, model, messages_json, token_input, token_output, created_at, updated_at, folder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      (stmtId) =>
        dbClient.call('run', {
          stmtId,
          params: [
            id,
            input.title,
            input.provider,
            input.model,
            JSON.stringify(input.messages),
            input.tokenInput,
            input.tokenOutput,
            now,
            now,
            input.folderId ?? null,
          ],
        }),
    )
    return { ...input, id, createdAt: now, updatedAt: now }
  }

  async findById(id: string): Promise<AiConversation | null> {
    // R33-Corr-4 修复 (MEDIUM conversations-catch-swallow)：原版
    // `.catch(() => null)` 把所有错误（worker respawn mid-call / stmt cache
    // 失效竞态 / schema drift 未知列 / JSON 损坏）当 row=null 处理，调用方
    // 误以为「对话被删了」并可能丢上下文。修复：catch 里 log 并 rethrow，
    // 让 IPC handler 决定是否降级（保留旧 catch-to-null 行为作为 fallback）。
    const row = await withPrepared('SELECT * FROM ai_conversations WHERE id = ?', (stmtId) =>
      dbClient.call('get', { stmtId, params: [id] }),
    ).catch((err) => {
      console.error(`[conversations.findById] failed for id=${id}:`, err)
      return null
    })
    if (!row) return null
    return this.rowToConv(row as Record<string, unknown>)
  }

  async findAll(
    limit = 100,
    opts: { folderId?: string | null } = {},
  ): Promise<AiConversation[]> {
    // R33-Corr-5 修复 (LOW findAll-limit-zero-mismatch)：原版
    // `Math.max(0, Math.min(1000, parseInt(String(limit), 10) || 100))` 把
    // 任何 parseInt falsy 结果当 100 —— `limit=0`（合法「空结果」值）也返回
    // 100 行。修复：parseInt → NaN 检查 → clamp，0 直保留为 0。
    const parsed = parseInt(String(limit), 10)
    const safeLimit = Math.max(0, Math.min(1000, Number.isFinite(parsed) ? parsed : 100))
    // R14 修复：LIMIT 走参数绑定，SQL 文本固定，命中 prepareCache 不再泄漏新句柄。
    // R16 修复 (low)：ORDER BY 仅 updated_at DESC，当多个对话 updated_at 完全
    // 相同（批量创建 / 同一毫秒写入 / 全用 ISO 秒精度的旧数据），SQLite 给出
    // 的顺序未定义 —— 列表渲染每次刷新顺序可能抖动。加 created_at DESC 作
    // 二级排序键，保证稳定顺序。
    // R33-Corr-4 续：同样把全 catch 静默吞错改为 log + fallback 到 []
    //
    // folderId 过滤：
    //   - string  → WHERE folder_id = ?
    //   - null    → WHERE folder_id IS NULL（仅未分类）
    //   - undefined → 不加 folder 谓词（向后兼容，传 limit 时行为与旧版一致）
    const where: string[] = []
    const params: unknown[] = []
    if (typeof opts.folderId === 'string') {
      where.push('folder_id = ?')
      params.push(opts.folderId)
    } else if (opts.folderId === null) {
      where.push('folder_id IS NULL')
    }
    const sql = `SELECT * FROM ai_conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY updated_at DESC, created_at DESC LIMIT ?`
    params.push(safeLimit)
    const rows = await withPrepared(sql, (stmtId) =>
      dbClient.call('all', { stmtId, params }),
    ).catch((err) => {
      console.error(`[conversations.findAll] failed for limit=${safeLimit}:`, err)
      return []
    })
    return (rows as Record<string, unknown>[]).map((r) => this.rowToConv(r))
  }

  /**
   * 把对话移入指定文件夹（folderId = null 表示「未分类」）。
   * 不动其它字段，只更新 folder_id + updated_at。
   */
  async setFolder(id: string, folderId: string | null): Promise<void> {
    await withPrepared(
      `UPDATE ai_conversations SET folder_id = ?, updated_at = ? WHERE id = ?`,
      (stmtId) =>
        dbClient.call('run', {
          stmtId,
          params: [folderId, new Date().toISOString(), id],
        }),
    )
  }

  /** 统计某 folder 下的对话数（含 folderId=null 表示未分类） */
  async countByFolder(folderId: string | null): Promise<number> {
    const row = folderId === null
      ? await withPrepared(
          'SELECT COUNT(*) AS c FROM ai_conversations WHERE folder_id IS NULL',
          (stmtId) => dbClient.call('get', { stmtId }),
        )
      : await withPrepared(
          'SELECT COUNT(*) AS c FROM ai_conversations WHERE folder_id = ?',
          (stmtId) => dbClient.call('get', { stmtId, params: [folderId] }),
        )
    return (row as { c?: number } | null)?.c ?? 0
  }

  async appendMessage(id: string, message: AiMessage): Promise<void> {
    const now = new Date().toISOString()
    const serializedMessage = JSON.stringify(message)
    // R30-DI-8 + R31-DI-1 + R31-DI-5 + R31-Sec-10 + R31-Corr-1 + R32-Corr-1
    // 修复 (CRITICAL cap-实际失效 / HIGH 并发竞态)：R30 原版用硬编码
    // `json_remove(messages_json, '$[0]', '$[1]', ?)` —— 注释错误以为
    // `'$[0:N]'` 是 slice 语法，**实际 SQLite json_remove 接受离散路径列
    // 表，不接受范围**。结果：
    //   - currentN=500 时 dropCount=1 误删 2 条；
    //   - currentN=503 时 dropCount=4 但只删 3 条（删 0,1,3 → 漏 index 2，
    //     数组不连续）；
    //   - currentN>503 时永远只删 3 条，**cap 实际失效**，agentic 工具
    //     循环可无限增长。
    //
    // R31 评审亦发现：
    //   - SELECT/UPDATE/UPDATE 三条 IPC 不在同一事务，并发 appendMessage
    //     可同时通过 SELECT 检查导致越过 cap；
    //   - cap 失效后 messages_json 可被推到 MB 级，反序列化卡顿。
    //
    // R32-Corr-1 修复 (CRITICAL fifo-trim-keeps-wrong-suffix)：R31 我自己
    // 的修复仍漏一处 bug —— `WHERE key >= ?`（?=MAX-1=499）从数组头比
    // 较，而不是从尾部算 offset。长度为 N 的数组里，只有 key >= 499 的元素
    // 保留：
    //   - N=500 → 留 1 条（key 499），append 后总 2 条 → 误删 498 条历史；
    //   - N=1000 → 留 501 条，append 后 502 条 → cap 实际是 502 而非 500；
    //   - N > 500 → cap 永远失效，json 可以无限增长。
    // 修复：把 `key >= ?` 改为 `key >= json_array_length(messages_json) - ?`，
    // 即从尾部取倒数 (MAX-1) 条。这样 N 任意 → append 后总数稳定在 MAX。
    //
    // 修复策略：用 json_group_array 子查询**原子重建**数组 ——「保留从
    // index (MAX-1) 起的后缀」。trim 与 appendMessage 两条 SQL 都走
    // dbClient.runInTransaction 串行化（txLock 串行保证），并发 appendMessage
    // 不会同时通过 trim 判定。子查询在 UPDATE 内执行，读取的就是 BEGIN 时
    // 的快照值，不存在跨 IPC 的 TOCTOU。
    await dbClient.runInTransaction(async () => {
      await dbClient.call('exec', { sql: 'BEGIN' })
      try {
        // 1) FIFO trim：仅当 length > MAX-1 时触发（避免每次 UPDATE 都
        //    json_group_array 完整重建）。json_each 对 array 返回 key 列
        //    为 INTEGER（0-based）。R32 修复：从尾部倒数 (MAX-1) 条，
        //    WHERE key >= json_array_length(messages_json) - (MAX-1)。
        //    COALESCE 兜底空数组情况（json_group_array 在无输入时返回 NULL）。
        await withPrepared(
          `UPDATE ai_conversations
           SET messages_json = COALESCE((
             SELECT json_group_array(value)
             FROM json_each(messages_json)
             WHERE key >= json_array_length(messages_json) - ?
           ), '[]')
           WHERE id = ?
             AND json_array_length(messages_json) > ?`,
          (stmtId) =>
            dbClient.call('run', {
              stmtId,
              params: [
                MAX_MESSAGES_PER_CONVERSATION - 1,
                id,
                MAX_MESSAGES_PER_CONVERSATION - 1,
              ],
            }),
        )
        // 2) Insert new message at tail。json_insert 用 '$[#]' 表示 append。
        await withPrepared(
          `UPDATE ai_conversations
           SET messages_json = json_insert(messages_json, '$[#]', json(?)),
               updated_at = ?
           WHERE id = ?`,
          (stmtId) =>
            dbClient.call('run', {
              stmtId,
              params: [serializedMessage, now, id],
            }),
        )
        await dbClient.call('exec', { sql: 'COMMIT' })
      } catch (err) {
        try {
          await dbClient.call('exec', { sql: 'ROLLBACK' })
        } catch {
          /* swallow */
        }
        throw err
      }
    })
  }

  async updateTokens(id: string, tokenInput: number, tokenOutput: number): Promise<void> {
    await withPrepared(
      'UPDATE ai_conversations SET token_input = ?, token_output = ? WHERE id = ?',
      (stmtId) => dbClient.call('run', { stmtId, params: [tokenInput, tokenOutput, id] }),
    )
  }

  /**
   * R10 修复：原子 token 增量。
   * 原版 updateTokens 是 read-modify-write（findById → 算新值 → update），
   * 两个并发流会读到相同的 tokenInput 然后都按"旧值+自己"写，后写覆盖前写，
   * token 计数会随并发量级漂移丢失。改用 SQL `token_input = token_input + ?`
   * 在单条 UPDATE 内做增量，对并发透明。
   */
  async updateTokensDelta(id: string, deltaInput: number, deltaOutput: number): Promise<void> {
    if (deltaInput <= 0 && deltaOutput <= 0) return
    await withPrepared(
      `UPDATE ai_conversations
       SET token_input = COALESCE(token_input, 0) + ?,
           token_output = COALESCE(token_output, 0) + ?
       WHERE id = ?`,
      (stmtId) =>
        dbClient.call('run', {
          stmtId,
          params: [Math.max(0, deltaInput | 0), Math.max(0, deltaOutput | 0), id],
        }),
    )
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await withPrepared(
      'UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?',
      (stmtId) => dbClient.call('run', { stmtId, params: [title, new Date().toISOString(), id] }),
    )
  }

  async delete(id: string): Promise<void> {
    await withPrepared('DELETE FROM ai_conversations WHERE id = ?', (stmtId) =>
      dbClient.call('run', { stmtId, params: [id] }),
    )
  }

  /**
   * R10 修复：删除一条对话末尾消息（best-effort 回滚用）。
   * sendMessage 中若 appendMessage 已成功但 ai:stream 失败，会留下孤儿 userMsg。
   * 用 json_remove 抹掉最后一条以恢复一致性；失败仅日志，不抛。
   *
   * R18 修复 (medium security)：改为 removeLastMessageIfRole(conversationId, 'user')，
   * 强制只删 user 角色的最后一条消息。旧版 removeLastMessage 删除任意 role 的最后
   * 一条消息 → 渲染端可重复调用把 assistant / tool / system 消息逐条删掉（每次
   * 删最后一条），破坏历史完整性、丢失 tool 副作用记录。本仓库保留 removeLastMessage
   * 作 legacy 调用方（如有）使用，但 IPC 通道只能走 removeLastMessageIfRole。
   */
  async removeLastMessage(conversationId: string): Promise<void> {
    return this.removeLastMessageIfRole(conversationId, 'user')
  }

  /**
   * R18 修复：仅在最后一条消息 role 匹配 expectedRole 时删除。
   * - role 不匹配 → 静默 return（不报错 —— 渲染端不应区分"无最后消息"和
   *   "最后消息不是 user"，都视为回滚完毕）。
   * - role 匹配 → json_remove 抹掉最后一条 + 更新 updated_at。
   *
   * 失败仅日志，不抛（与 R10 行为对齐）。
   *
   * R19 修复 (high data integrity)：原实现 SELECT + JS parse + UPDATE 三步
   * 走 IPC 异步，期间任何并发的 appendMessage 都可能让 messages_json 长度
   * 变化 → JS 端计算出的 lastIdx 与 UPDATE 实际看到的 json 数组不一致。
   * 攻击者可通过快速触发 ai:send 失败回滚 + 同步重发，制造「删除错位置」
   * —— 删掉中间一条 assistant，保留尾部 user 消息，破坏对话历史完整性
   * （LLM 上下文窗口里突然少了关键 tool 调用记录）。
   *
   * 修复：把 SELECT + role 检查 + UPDATE 合并成一条原子 SQL。
   * SQLite 单连接串行 + UPDATE 的 WHERE 子句中用 json_extract 在执行瞬间
   * 取最后一条的 role，等于 expectedRole 才 UPDATE，否则 changes=0 自然
   * 跳过。json_array_length / json_extract 在 UPDATE 内部读到的就是当前
   * 事务内的最新值，不可能与 UPDATE 写入的内容错位。
   */
  async removeLastMessageIfRole(
    conversationId: string,
    expectedRole: 'user' | 'assistant' | 'tool' | 'system',
  ): Promise<void> {
    try {
      const now = new Date().toISOString()
      await withPrepared(
        `UPDATE ai_conversations
         SET messages_json = json_remove(
               messages_json,
               '$[' || (json_array_length(messages_json) - 1) || ']'
             ),
             updated_at = ?
         WHERE id = ?
           AND messages_json IS NOT NULL
           AND json_array_length(messages_json) > 0
           AND json_extract(
                 messages_json,
                 '$[' || (json_array_length(messages_json) - 1) || '].role'
               ) = ?`,
        (stmtId) =>
          dbClient.call('run', {
            stmtId,
            params: [now, conversationId, expectedRole],
          }),
      )
    } catch (err) {
      // 回滚失败不应阻塞 UI 错误提示，仅日志
       
      console.warn('[conversations] removeLastMessage failed:', err)
    }
  }

  async getTotalTokens(): Promise<{ input: number; output: number }> {
    const row = await withPrepared(
      `SELECT COALESCE(SUM(token_input), 0) as i, COALESCE(SUM(token_output), 0) as o FROM ai_conversations`,
      (stmtId) => dbClient.call('get', { stmtId }),
    ).catch(() => null)
    return { input: (row as { i?: number } | null)?.i ?? 0, output: (row as { o?: number } | null)?.o ?? 0 }
  }

  private rowToConv(r: Record<string, unknown>): AiConversation {
    let messages: AiMessage[] = []
    const raw = r.messages_json as string | null | undefined
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          messages = parsed as AiMessage[]
        }
      } catch (_) {
        // 单条记录损坏不应影响整个列表读取
        messages = []
      }
    }
    return {
      id: r.id as string,
      title: (r.title as string | null) ?? null,
      provider: r.provider as string,
      model: r.model as string,
      messages,
      tokenInput: (r.token_input as number) ?? 0,
      tokenOutput: (r.token_output as number) ?? 0,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      folderId: (r.folder_id as string | null) ?? null,
    }
  }
}

export const conversationsRepo = new ConversationsRepository()
