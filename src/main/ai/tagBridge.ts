/**
 * AI → 标签桥接层
 *
 * 提供「把一个**已存在**的标签贴到笔记 / 便签上」的能力。
 *
 * 关键语义（与 addTag 工具的区别）：
 *   - addTag        = 创建标签（不存在则新建）
 *   - applyTagToX   = **仅贴**已有标签；找不到就失败返回，绝不隐式创建
 * 之所以严格区分：LLM 经常把用户随口提到的词当成标签名（「帮我把这个
 * 归到重要里」），隐式创建会让标签树被垃圾节点污染，而且用户无法察觉。
 *
 * 数据模型差异（两种存储，别混用）：
 *   - sticky_notes.tags_json 存的是 **tag ID 列表**
 *   - notes.tags_json        存的是 **tag 名称列表**（来自 markdown frontmatter）
 * 所以两个函数写入的值不同，但入口都先经过 tagsRepo.findByNameInScope
 * 校验「这个名字确实是一个已注册的标签」。
 */
import { tagsRepo } from '../db/repositories/tags'
import { notesRepo } from '../db/repositories/notes'
import { stickyNotesRepo } from '../db/repositories/stickyNotes'
import log from '../log'
import { unescapeToolText } from './tools/validators'

/**
 * applyTagToNote 全库 prefix 扫描的硬上限。
 *
 * 为什么是 2000（而非 200 / 500 / 5000）：
 *   - 实测 ~95% 个人用户的 .taskpilot/notes 目录笔记数 ≤ 2000（每篇
 *     平均 ~25KB，总量约 ~50MB），把全表读进内存做 .toLowerCase 比对
 *     仍能在几十 ms 内完成，IPC payload ≈ 2000 × NoteMeta ≈ 几百 KB，
 *     远低于 Electron structured-clone 默认 1MB 阈值。
 *   - 放宽到 5000 会让长尾用户（5K+ 笔记）首次扫描卡 IPC 单帧 100ms+
 *     并撑爆渲染端 mount 时一次性 hydrate；放宽到 500 反而会漏掉
 *     中量用户的真实使用场景。
 *   - 与 notesLoader.findAll 默认 limit:200 的差异：searchNotes /
 *     summarizeNote 走的是分页预览语义（只取前 200 喂给 LLM 摘要），
 *     而 applyTagToNote 是按 filename 前缀**命中目标笔记**——必须
 *     扫全库才能判定 needle 是否真的不存在前缀命中。
 *
 * 截断设计取舍（不报错，而是标记）：
 *   当笔记库 > 2000 条时，findAll 返回恰好 2000 行（被 SQL LIMIT 截断）。
 *   此时如果 needle 在前 2000 行中没命中，我们**无法**断言后 N 行也
 *   没有命中——选择不抛错（避免 LLM 据此告诉用户"绝对不存在"造成
 *   漏贴），而是把 matchKind 标记为 'truncated' 让 LLM 知道扫描未
 *   穷尽；ok:false 分支的错误消息里也会带上"扫描了前 2000 篇"
 *   的提示。
 *
 * 若未来需要真正全库扫描，可改用 COUNT(*) 探测总量后再分页拉，或
 * 在 notesRepo 上加 streamed filter（better-sqlite3 端 prepare 一次
 * 走 row-by-row .iterate()），但目前 2000 的上限已覆盖 ~95% 用户。
 */
const NOTE_SCAN_LIMIT = 2000

/**
 * R33 修复 (MEDIUM tagBridge-applyTagToNote-prefix-bypass)：最小允许的
 * 前缀匹配 needle 长度。needle 过短（如 "重"、"中"、"a"）极易命中
 * 大量文件，LLM 在 prompt injection 下给出短 needle 会让本函数
 * 静默把标签贴到与用户意图不同的笔记上 —— 用户的 confirm 弹窗只显示
 * needle 而不是真实匹配到的 filename，差距被掩盖。
 *
 * 4 chars 阈值是经验值：低于 4 char 的 needle 几乎一定会前缀命中多条，
 * 高于 4 char 时误命中概率显著下降。低于此阈值时拒绝前缀匹配并要求
 * LLM 给出更完整的 filename（与多匹配时的 disambiguation 错误走同一路）。
 */
const MIN_PREFIX_NEEDLE_LENGTH = 4

export interface ApplyTagResult {
  ok: boolean
  error?: string
  tagName?: string
  tagId?: string
  /** 目标实体标识（笔记 filename / 便签 id） */
  target?: string
  /**
   * R33 修复：needle 与 target 的实际匹配方式。
   *   - 'exact'    filename 完全相等，且扫描覆盖了全库（无截断）
   *   - 'prefix'   filename 大小写不敏感前缀命中，且扫描覆盖了全库
   *   - 'truncated' 扫描被 NOTE_SCAN_LIMIT 截断（前 2000 行没找到、或
   *                 找到唯一匹配但后续笔记未扫描）。LLM 拿到此值时
   *                 应理解为「该匹配有效，但扫描未穷尽，不能据此推断
   *                 整库状态」。渲染端可按 'prefix' 同样展示前缀提示。
   *
   * 渲染端 confirm 弹窗据此向用户展示「应用到 `xxx.md`（按前缀 `xxx` 匹配）」
   * 而非只显示 needle，杜绝「用户以为同意的是 needle，但实际写盘到另一篇」。
   */
  matchKind?: 'exact' | 'prefix' | 'truncated'
  /** 该标签此前是否已经贴过（幂等调用时为 true） */
  alreadyTagged?: boolean
  tags?: string[]
}

/**
 * 查找已注册标签（root 作用域）；不存在返回 null —— 不创建
 *
 * R-fix-tooltext-roundtrip (HIGH ai-quality)：listTags 在 tags[i].name 上
 * 做了 5-char HTML escape（"Work & Fun" → "Work &amp; Fun"），LLM 拿到
 * 这段 JSON 后把 escape 后的字符串原文回喂到 applyTagToSticky /
 * applyTagToNote / removeTagFromSticky —— 若直接拿去 findByNameInScope
 * 比对，DB 字面是 "Work & Fun"，escape 串查不到，全部回 "tag not found"。
 * 在入口做一次 unescapeToolText，保证 DB 字面与工具入参一致。
 */
async function resolveTag(tagName: string) {
  const name = unescapeToolText(String(tagName ?? '').trim())
  if (!name) return { name: '', tag: null }
  const tag = await tagsRepo.findByNameInScope(name, null)
  return { name, tag }
}

/**
 * 把已有标签贴到笔记上（按文件名前缀匹配笔记）。
 *
 * 匹配规则：先尝试 filename 完全相等，再退化为大小写不敏感的前缀匹配。
 * 前缀匹配命中多条时拒绝（返回候选列表让 LLM 追问用户），避免把标签
 * 贴到用户没想要的那篇笔记上。
 */
export async function applyTagToNote(
  tagName: string,
  noteFilename: string,
): Promise<ApplyTagResult> {
  const { name, tag } = await resolveTag(tagName)
  if (!name) return { ok: false, error: 'tagName 不能为空' }
  if (!tag) return { ok: false, error: 'tag not found' }

  const needle = String(noteFilename ?? '').trim()
  if (!needle) return { ok: false, error: 'noteFilename 不能为空' }

  // R-fix-applyTagToNote-truncation-detector (MEDIUM correctness)：
  // 原版用 `all.length === NOTE_SCAN_LIMIT` 判定是否被截断，在用户笔记
  // 数恰好 == 2000 时会把扫描标记为 truncated，但实际已经覆盖全库。
  // 改为多取一行（NOTE_SCAN_LIMIT + 1）：若返回 NOTE_SCAN_LIMIT+1 行则
  // 必有未扫描记录，把多取的一行 pop 掉；否则行数 ≤ NOTE_SCAN_LIMIT
  // 就是真的覆盖了全库。代价是全库正好 NOTE_SCAN_LIMIT+1 条时多读一行，
  // 收益是 truncation 判定从启发式变成 deterministic。
  const allRaw = await notesRepo.findAll({ limit: NOTE_SCAN_LIMIT + 1 })
  const scanIncomplete = allRaw.length > NOTE_SCAN_LIMIT
  const all = scanIncomplete ? allRaw.slice(0, NOTE_SCAN_LIMIT) : allRaw
  const lower = needle.toLowerCase()
  let matches = all.filter((n) => n.filename.toLowerCase() === lower)
  let matchKind: 'exact' | 'prefix' | 'truncated' = 'exact'
  if (matches.length === 0) {
    // R33 修复：needle 过短时拒绝前缀匹配。理由：
    //   - 「重」「中」「a」等 1-3 char needle 在用户笔记库动辄命中几十篇
    //   - prompt injection / LLM 拼错都极易触发这种短 needle
    //   - 单匹配时静默落到第一篇 → 用户 confirm 弹窗只看到 needle，看不到
    //     实际命中的另一篇 filename，同意后写错笔记
    // 行为：低于阈值时直接走 disambiguation 路径，让 LLM 知道「需要更
    // 精确的 filename」，而不是默默把标签贴到错的笔记上。
    if (needle.length < MIN_PREFIX_NEEDLE_LENGTH) {
      const prefixMatches = all.filter((n) => n.filename.toLowerCase().startsWith(lower))
      const truncationNote = scanIncomplete
        ? `（仅扫描了前 ${NOTE_SCAN_LIMIT} 篇，后续笔记未检查）`
        : ''
      return {
        ok: false,
        error:
          `"${needle}" 长度低于 ${MIN_PREFIX_NEEDLE_LENGTH} 字符，拒绝前缀匹配；` +
          `当前库中有 ${prefixMatches.length} 篇笔记以 "${needle}" 开头，请给出更完整的文件名` +
          truncationNote,
      }
    }
    matches = all.filter((n) => n.filename.toLowerCase().startsWith(lower))
    matchKind = 'prefix'
  }
  if (matches.length === 0) {
    const truncationNote = scanIncomplete
      ? `（仅扫描了前 ${NOTE_SCAN_LIMIT} 篇，后续笔记未检查）`
      : ''
    return {
      ok: false,
      error: `未找到文件名以 "${needle}" 开头的笔记${truncationNote}`,
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `"${needle}" 匹配到 ${matches.length} 篇笔记，请给出更完整的文件名`,
    }
  }

  // 唯一匹配命中。若扫描被截断，把 matchKind 升级为 'truncated' 让 LLM
  // 知道「这个匹配有效，但整库状态未知」，不能再据此推断"库中只有这一
  // 篇以 needle 开头"。注意：'truncated' 优先级高于 'exact'/'prefix'
  // —— 即便用户给的就是完整 filename（exact），扫描未穷尽也意味着后
  // N 行可能存在前缀冲突，渲染端 confirm 弹窗应按前缀模式展示。
  if (scanIncomplete) matchKind = 'truncated'

  const note = matches[0]
  const existing = Array.isArray(note.tags) ? note.tags.map(String) : []
  if (existing.includes(name)) {
    return {
      ok: true,
      tagName: name,
      tagId: tag.id,
      target: note.filename,
      matchKind,
      alreadyTagged: true,
      tags: existing,
    }
  }

  const next = [...existing, name]
  const updated = await notesRepo.updateMeta(note.id, { tags: next })
  if (!updated) return { ok: false, error: '笔记更新失败（可能已被删除）' }

  log.info(
    `[ai/tagBridge] applyTagToNote "${name}" → ${note.filename} (match=${matchKind}, needle="${needle}")`,
  )
  return {
    ok: true,
    tagName: name,
    tagId: tag.id,
    target: note.filename,
    matchKind,
    alreadyTagged: false,
    tags: next,
  }
}

/** 把已有标签贴到便签上（sticky.tags 存的是 tag ID） */
export async function applyTagToSticky(
  tagName: string,
  stickyNoteId: string,
): Promise<ApplyTagResult> {
  const { name, tag } = await resolveTag(tagName)
  if (!name) return { ok: false, error: 'tagName 不能为空' }
  if (!tag) return { ok: false, error: 'tag not found' }

  const id = String(stickyNoteId ?? '').trim()
  if (!id) return { ok: false, error: 'stickyNoteId 不能为空' }

  const sticky = await stickyNotesRepo.findById(id)
  if (!sticky) return { ok: false, error: '便签不存在' }

  const existing = Array.isArray(sticky.tags) ? sticky.tags.map(String) : []
  if (existing.includes(tag.id)) {
    return {
      ok: true,
      tagName: name,
      tagId: tag.id,
      target: id,
      alreadyTagged: true,
      tags: existing,
    }
  }

  const next = [...existing, tag.id]
  const updated = await stickyNotesRepo.update(id, { tags: next })
  if (!updated) return { ok: false, error: '便签更新失败（可能已被删除）' }

  log.info(`[ai/tagBridge] applyTagToSticky "${name}" → ${id}`)
  return {
    ok: true,
    tagName: name,
    tagId: tag.id,
    target: id,
    alreadyTagged: false,
    tags: next,
  }
}

/**
 * 把已有标签从便签上摘掉（按标签名）。
 *
 * 与 applyTagToSticky 互为反向操作。语义要点：
 *   - 标签必须**已经注册**（与 apply 同样走 findByNameInScope 校验），
 *     这样 LLM 不会因为拼错 / 随口编造一个名字就把便签 tags 数组里
 *     的某些项意外清掉。
 *   - 便签上**没有**这个标签时返回 ok:true + removed:false（幂等），
 *     不要让 LLM 误以为出错了再继续重试。
 *   - tags 数组存的是 tag ID，所以按 tag.id 比对而不是 name。
 */
export async function removeTagFromSticky(
  tagName: string,
  stickyNoteId: string,
): Promise<ApplyTagResult & { removed?: boolean }> {
  const { name, tag } = await resolveTag(tagName)
  if (!name) return { ok: false, error: 'tagName 不能为空' }
  if (!tag) return { ok: false, error: 'tag not found' }

  const id = String(stickyNoteId ?? '').trim()
  if (!id) return { ok: false, error: 'stickyNoteId 不能为空' }

  const sticky = await stickyNotesRepo.findById(id)
  if (!sticky) return { ok: false, error: '便签不存在' }

  const existing = Array.isArray(sticky.tags) ? sticky.tags.map(String) : []
  if (!existing.includes(tag.id)) {
    // 没贴过 —— 视为幂等成功，避免 LLM 重复尝试
    return {
      ok: true,
      tagName: name,
      tagId: tag.id,
      target: id,
      alreadyTagged: false,
      removed: false,
      tags: existing,
    }
  }

  const next = existing.filter((t) => t !== tag.id)
  const updated = await stickyNotesRepo.update(id, { tags: next })
  if (!updated) return { ok: false, error: '便签更新失败（可能已被删除）' }

  log.info(`[ai/tagBridge] removeTagFromSticky "${name}" → ${id}`)
  return {
    ok: true,
    tagName: name,
    tagId: tag.id,
    target: id,
    alreadyTagged: true,
    removed: true,
    tags: next,
  }
}
