/**
 * AI 工具层 — createNote 落盘助手 + 待确认 FIFO 表
 *
 * 历史来源：从原 src/main/ai/tools.ts 抽离，包括：
 *   - pendingCreateNoteByWebContents Map（R33 修复 bypass 用）
 *   - registerPendingCreateNote / consumePendingCreateNote
 *   - createNoteConfirmed（IPC handler 在用户同意后真正调用的写盘 helper）
 *
 * 设计要点：
 *   - 键含 webContentsId：禁止跨窗口 replay 别人的 toolCallId。
 *   - title 必须等于登记值：禁止渲染端在弹窗中改了 LLM 提出的标题
 *     （用户以为同意的是 "会议纪要"，实际写盘是 "evil..."）。
 *   - 容量上限：长会话下 pending 项可能堆积（用户连续拒绝多轮），但每
 *     项都很小。这里用 FIFO 截断保持有界内存。
 *   - createNoteConfirmed 是**有副作用的写操作**，只能由 IPC 处理器在用户
 *     明确同意后调用；不要在工具循环（被 LLM 直接触发）里调用它。
 */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCurrentLibrary } from '../../lib/libraryManager'
import { __bindPendingCreateNoteAccessor } from './context'
import { sanitizeNoteFilename, escapeYamlScalar } from './validators'

interface PendingCreateNote {
  title: string
  content: string
  /**
   * R34 修复 (HIGH ai:createNote-tags-silently-dropped)：schema 声明的
   * tags 字段在 execute 阶段被静默丢弃——LLM 照 schema 调用
   * createNote({tags:['work','urgent']}) 后落地笔记的 frontmatter
   * 完全不带 tags。把 tags 透传到 pending 表 + 落盘 helper，落盘时
   * 写进 YAML frontmatter。空数组 / undefined 不写字段，避免污染空笔记。
   */
  tags?: string[]
  registeredAt: number
}
const pendingCreateNoteByWebContents = new Map<string, PendingCreateNote>()
const PENDING_CREATE_NOTE_MAX = 200

function pendingCreateNoteKey(
  webContentsId: number | null,
  toolCallId: string,
): string {
  return `${webContentsId ?? 'null'}::${toolCallId}`
}

// 把 pending 表的访问桥挂到 context.ts —— context.clearWebContentsNoteState
// 销毁 webContents 时需要连带清理对应 pending 项，这里用延迟绑定避免循环
// import（createNote 不需要反向依赖 context）。
__bindPendingCreateNoteAccessor(
  () => pendingCreateNoteByWebContents.keys(),
  (k) => pendingCreateNoteByWebContents.delete(k),
)

/**
 * createNote 工具的 execute 调用本函数登记一项待确认请求。允许在没找到
 * caller context（webContentsId 为 null）的情况下也登记——保守起见用
 * 'null' 作 key，handler 会要求显式 sender.id 匹配，因此 null caller 永远
 * 无法被任意 sender 消费。
 */
export function registerPendingCreateNote(
  webContentsId: number | null,
  toolCallId: string,
  payload: { title: string; content: string; tags?: string[] },
): void {
  if (!toolCallId) return
  const key = pendingCreateNoteKey(webContentsId, toolCallId)
  pendingCreateNoteByWebContents.set(key, {
    title: payload.title,
    content: payload.content,
    // 仅持久化非空标签数组；undefined / 空数组都不进表，落盘 helper 据此
    // 决定是否向 frontmatter 写 `tags:` 字段。
    ...(Array.isArray(payload.tags) && payload.tags.length > 0
      ? { tags: payload.tags.map((t) => String(t)).filter((s) => s.length > 0) }
      : {}),
    registeredAt: Date.now(),
  })
  // FIFO 上界：超过 MAX 时按插入顺序逐条淘汰
  while (pendingCreateNoteByWebContents.size > PENDING_CREATE_NOTE_MAX) {
    const oldest = pendingCreateNoteByWebContents.keys().next().value
    if (typeof oldest !== 'string') break
    pendingCreateNoteByWebContents.delete(oldest)
  }
}

/**
 * AI_CONFIRM_CREATE_NOTE handler 在写盘前调用：仅当
 *   - (senderId, toolCallId) 在 pending 表里
 *   - 提交的 title 与登记的 title 完全相等（防 LLM 流式标题被渲染端改写）
 * 才返回 ok:true；命中后立即从表里移除（一次性消费）。任何条件不满足都
 * 返回 ok:false + error，handler 直接把 error 回给渲染端。
 */
export function consumePendingCreateNote(
  webContentsId: number,
  toolCallId: string,
  submittedTitle: string,
):
  | { ok: true; title: string; content: string; tags?: string[] }
  | { ok: false; error: string } {
  const key = pendingCreateNoteKey(webContentsId, toolCallId)
  const entry = pendingCreateNoteByWebContents.get(key)
  if (!entry) {
    return {
      ok: false,
      error:
        'no pending createNote for this toolCallId/sender — bypass attempt?',
    }
  }
  if (entry.title !== submittedTitle) {
    return {
      ok: false,
      error: 'submitted title does not match LLM-streamed proposal',
    }
  }
  pendingCreateNoteByWebContents.delete(key)
  return {
    ok: true,
    title: entry.title,
    content: entry.content,
    tags: entry.tags,
  }
}

/**
 * createNote 实际写入磁盘时使用的固定助手
 *
 * 注意：这是一个**有副作用的写操作**，只能由 IPC 处理器在用户明确同意后调用。
 * 不要在工具循环（被 LLM 直接触发）里调用它。
 */
export async function createNoteConfirmed(payload: {
  title: string
  content: string
  /**
   * R34 修复：tags 是 createNote 工具 schema 声明但 execute 静默丢弃的
   * 字段。落盘时把它写到 frontmatter 的 `tags:` 列表 —— 与 notesRepo
   * 解析 notes.tags_json 的数据契约一致（tagBridge.ts 注释：「notes.
   * tags_json 存的是 tag 名称列表（来自 markdown frontmatter）」）。
   * 空数组 / undefined 不写字段。
   */
  tags?: string[]
}): Promise<
  | { ok: true; id: string; filename: string; title: string; tags?: string[] }
  | { ok: false; error: string }
> {
  const title = String(payload.title ?? '').trim()
  const content = String(payload.content ?? '')
  if (!title) return { ok: false, error: 'title 不能为空' }

  const library = await getCurrentLibrary()
  if (!library) return { ok: false, error: '库目录未配置' }

  // R-fix-notes-filename-sanitize-drift (MEDIUM correctness): collapse the
  // full sanitize pipeline into the shared helpers.sanitizeNoteFilename().
  // note.ts and this function now derive the filename from the same source,
  // so the filename shown in the confirm dialog is byte-identical to the one
  // written to disk.
  //
  // Previously the disk-write side had a stricter sanitize (filter control
  // chars, strip trailing [.\s], replace ^\.+ with _, fallback to "untitled"
  // for degenerate names) while note.ts only filtered 9 Windows-illegal chars
  // + truncated to 80, causing titles like "..secret" to display
  // "..secret-abcd.md" in the confirm dialog but write "_secret-abcd.md" to
  // disk. R22 / R32-Corr-11 path-traversal / Windows-EPERM defenses are now
  // folded into sanitizeNoteFilename (single source of truth).
  const { filename: safeName, yamlSafe: yamlSafeName } =
    sanitizeNoteFilename(title)
  const id = randomUUID()
  const notesDir = join(library, '.taskpilot', 'notes')
  const filePath = join(notesDir, `${safeName}-${id.slice(0, 8)}.md`)
  // R31-Sec-5 修复 (MEDIUM lexical-vs-realpath-bypass)：原版只做词法
  // resolve().startsWith() containment，没 realpath。lib:set-current 接受
  // 任意可 stat 的绝对路径，没拦截 symlink —— 攻击者把 libraryPath 设
  // 为 `<somewhere>/.taskpilot -> /Users/victim/important` 的 symlink，
  // 词法 `notesDir = libraryPath/.taskpilot/notes` 落在 `/Users/victim/
  // important/.taskpilot/notes`（或更糟的：symlink 跟随后跨目录）。LLM
  // tool call 走到 createNoteConfirmed 后写文件直接污染 victim 的目录。
  //
  // R32-Corr-2 + R32-Corr-3 修复 (CRITICAL realpath-on-ENOENT + reversed-args)：
  // R31 我自己的修复踩了两个 bug：
  //   (a) filePath 是**即将创建的新文件**，路径还没存在；
  //       `await realpath(filePath)` 抛 ENOENT → createNoteConfirmed 永远失败，
  //       「AI 笔记」功能彻底坏掉。
  //   (b) `isRealPathInside(realFilePath, realNotesDir)` 参数顺序颠倒。
  //       函数签名是 `isRealPathInside(rootDir, target)`（判断 target 是否
  //       在 rootDir 内），传成 (file, dir) 等于「问 file 是否包含 dir」，
  //       永远 false → 即便 (a) 修了也会被 (b) 二次拦截。
  // 修复：用 shared helper isRealPathInside(notesDir, filePath) —— 内部
  // 对 rootDir 做 realpath，对 target 是已存在路径 realpath、对不存在路径
  // 退化为词法 isPathInside（与 notesManager.ts:isPathInside 完全对齐）。
  const { isRealPathInside } = await import('../../notes/pathSafety')
  if (!(await isRealPathInside(notesDir, filePath))) {
    return {
      ok: false,
      error: 'title 解析后的路径逃出 notesDir（symlink 跟随 / 路径穿越），拒绝写入',
    }
  }

  try {
    // R10 修复：safeName 只过滤了文件系统非法字符，但 LLM 给的 title 可能含
    // 换行 / 控制字符 / YAML 边界标记，污染 frontmatter 结构（注入额外字段、
    // 提前关闭 `---` 边界）。R-fix-notes-filename-sanitize-drift: 这个
    // yamlSafeName 直接复用 sanitizeNoteFilename 返回的预转义字符串，避免
    // 在两个阶段分别消毒产生漂移。YAML 解析时仍视为字面量字符串（双引号包裹）。
    const createdAt = new Date().toISOString()
    // R34 修复：把 tags 写到 frontmatter。每个 tag 单独过 yamlSafe
    // （去控制字符、转义双引号 / 反斜杠），并过滤空字符串 + 长度 ≤ 80
    // （避免异常长字符串污染 frontmatter）。空数组 / undefined 不写
    // `tags:` 字段，保持与旧笔记（无 tags 字段）字节级一致。
    const rawTags = Array.isArray(payload.tags) ? payload.tags : []
    // R-fix-yaml-escape-dedup (HIGH duplication-drift)：tag 的 YAML 转义
    // 走 validators.escapeYamlScalar，与 title（sanitizeNoteFilename.yamlSafe）
    // 走同一份权威源；之前这里 inline 复制了同样的 replace 序列，未来扩规则
    // 改一处即可全栈同步（避免 title 走新规则 / tags 走老规则的解析漂移）。
    const yamlSafeTags = rawTags
      .map((t) => escapeYamlScalar(String(t).trim()))
      .filter((t) => t.length > 0 && t.length <= 80)
    const tagsBlock =
      yamlSafeTags.length > 0
        ? `\ntags:\n${yamlSafeTags.map((t) => `  - "${t}"`).join('\n')}\n`
        : ''
    const front = `---\nid: ${id}\ntitle: "${yamlSafeName}"\ncreated: ${createdAt}${tagsBlock}---\n\n`
    await writeFile(filePath, front + content, 'utf-8')
    return {
      ok: true,
      id,
      filename: `${safeName}-${id.slice(0, 8)}.md`,
      title: safeName,
      ...(yamlSafeTags.length > 0 ? { tags: yamlSafeTags } : {}),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}
