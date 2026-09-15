/**
 * AI 工具层纯函数与白名单校验器
 *
 * 历史来源：从原 src/main/ai/tools.ts 抽离，所有这些函数都没有 module-level
 * 副作用，可以独立测试。所有 prompt-injection / enum-bypass / 日期越界防御
 * 都集中在本文件维护，避免单文件 1952+ 行后任何一处 validator 改动都要读
 * 整个文件才能理解影响面。
 */
import type { Priority, StickyStatus } from '@shared/types'
import log from '../../log'
import {
  PRIORITIES,
  STICKY_STATUSES,
  PRIORITY_SET,
  STICKY_STATUS_SET,
} from '@shared/lib/priorities'
import { isValidDayKey } from '@shared/lib/dayKey'

/**
 * R30-DI-3 修复 (HIGH invariant-violation)：LLM 可绕过 JSON Schema 的
 * enum 校验，直接塞 `status: "in_progress_extra"` 给 repo —— DB schema
 * 没有 CHECK 约束，垃圾 status 写入后下游所有 listFiltered / scheduler
 * `status IN ('todo','in_progress')` / heatmap 聚合全部漏掉这些幽灵行。
 * 同样 priority 也要走白名单（不然 'p0_EXTRA' 也会漏过滤）。白名单
 * 与 shared/types 完全对齐。
 *
 * R-fix-tools-enum-dedup：原版白名单用 ReadonlySet<string>，但 JSON Schema
 * enum 字段需要数组形式，导致同一组字符串在 4 个工具的参数 schema 里被
 * inline 重复声明（createSticky / updateSticky / searchStickies /
 * batchUpdateStickies），StickyStatus / Priority 联合类型扩展时需要在
 * 5+ 处同步修改且容易漂移。改为：下面这两个 `as const` 数组是「合法值」
 * 的唯一权威源 —— 直接喂给 JSON Schema enum、用 spread 避免复制字面量；
 * 内部 Set 仅作 O(1) lookup 缓存，normalizeStatus / normalizePriority 走它。
 *
 * R36 修复（enum-dedup-全栈）：原 validators.ts 自维护 `VALID_PRIORITIES` /
 * `VALID_STICKY_STATUSES`，但 IPC handler / 渲染端下拉 / 排序权重等 9+ 处
 * 仍独立硬编码 'p0..p3' / 'todo..cancelled' 字面量，新增 p-1 / 子状态时
 * 漏改任何一处都会让 schema enum 与运行时白名单漂移。修复：把这两个数组
 * + 对应 Set 收敛到 `@shared/lib/priorities`，本文件 re-export 旧名
 * `VALID_PRIORITIES` / `VALID_STICKY_STATUSES` 保持向后兼容（sticky.ts
 * / ai/tools.ts / 多处 JSON Schema enum 仍在用旧名），下游新代码统一
 * 从 `@shared/lib/priorities` import。
 */
export const VALID_STICKY_STATUSES = STICKY_STATUSES
export const VALID_PRIORITIES = PRIORITIES

const VALID_STICKY_STATUSES_SET: ReadonlySet<string> = STICKY_STATUS_SET
const VALID_PRIORITIES_SET: ReadonlySet<string> = PRIORITY_SET

export function normalizeStatus(v: unknown): StickyStatus | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !VALID_STICKY_STATUSES_SET.has(v)) {
    log.warn(`[ai/tools] refusing invalid status from LLM: ${JSON.stringify(v)}`)
    return undefined
  }
  return v as StickyStatus
}
export function normalizePriority(v: unknown): Priority | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !VALID_PRIORITIES_SET.has(v)) {
    log.warn(`[ai/tools] refusing invalid priority from LLM: ${JSON.stringify(v)}`)
    return undefined
  }
  return v as Priority
}

/**
 * R28-Sec-3 修复 (medium prompt-injection / data-corruption)：原版 createSticky
 * / updateSticky 直接把 args.dueAt / scheduledAt 透传给 repo，LLM 给出
 * `dueAt: "not-a-date"` 或 `"2025-13-99T99:99:99Z"` 等垃圾值时，DB 排序 /
 * scheduler 比较都会拿到 NaN，归档/通知/heat-map 全部失序。统一用一个
 * 校验器：能 parse 成合法 Date 且不偏离现实日期上下界（±1 年防止 LLM
 * 写 9999-12-31 把排序推到末尾占位）才放行。
 *
 * - 返回 null 表示「不要这个字段」（值不合法）—— 调用方应当走 default
 *   而非 throw，因为某些 prompt-injection 攻击故意塞异常值试图触发
 *   crash；静默拒绝 + default 比抛错更稳。
 * - 显式传 null 表示「清空这个字段」，正常放行。
 */
export function parseSafeDate(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  // 上界：未来 10 年。LLM 写 9999-12-31 之类「无限未来」会让 heatmap
  // 排序跳到无穷远，scheduler 也跑不完 —— 拒。
  const upperMs = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000
  // 下界：1970（Unix epoch 起点）。LLM 写 1900-01-01 / 0001-01-01 会让
  // 排序回退到数据库最前面。拒。
  const lowerMs = 0
  if (d.getTime() > upperMs || d.getTime() < lowerMs) return null
  return d.toISOString()
}

/**
 * 校验 YYYY-MM-DD 形式的归属日。LLM 可能写 `2025-13-99` / `today` /
 * `昨天` / 任意日期字符串 —— 这种字段不能落到 SQLite 里参与排序和
 * `WHERE date = ?` 查询，必须先把字面格式守住。
 * 返回 null 表示非法（调用方应当 fallback 到 today）。
 *
 * R-fix-daykey-dedup (MEDIUM)：字面 + 真实日期判定统一走
 * @shared/lib/dayKey.isValidDayKey，与 navigateBridge.parseRoute /
 * completions.validateDayKey 共享同一权威源，规则微调（YYYYMMDD
 * 紧凑格式 / 宽松分隔符等）一处改全栈同步。
 */
export function parseSafeDayKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!isValidDayKey(s)) return null
  return s
}

/**
 * R32-02 修复 (MEDIUM prompt-injection-via-sticky-title)：5-char HTML
 * escape `[&<>"']` 把用户写入的 sticky / note 文本转成实体，阻断通过
 * markup 注入 system prompt 覆写语义的向量。在所有返回 user-controlled
 * 字符串给 LLM 的工具里统一走这个 helper（searchStickies / planDay /
 * searchNotes / summarizeNote / applyTagToSticky / batchApplyTag），
 * 避免各工具独立 escape 字符串导致漂移。
 *
 * 之前散落三处写法（module-level 函数 / searchNotes switch case /
 * summarizeNote switch case）已经在 R32-02 follow-up 收敛到本 helper；
 * 之所以同时 `export`（而非 file-local）：stream.ts / 后续新增工具若要
 * 拼接 system prompt 数据段，统一从这里 import，保持唯一 escape 语义。
 */
export function escapeToolText(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;',
  )
}

/**
 * R-fix-tooltext-roundtrip (HIGH ai-quality)：escapeToolText 的反向操作，
 * 把 5-char HTML 实体还原回原字符。**仅**在「入口由 listTags /
 * searchStickies 等「已经 escape 过的字符串」回流到「按字面比对 DB」
 * 的工具入口」使用，避免 round-trip 断链。
 *
 * 失败场景（修复前）：
 *   - listTags 在 tags[i].name 上 escapeToolText 输出 "Work &amp; Fun"
 *   - LLM 把这段 JSON 当字符串原文回喂给 applyTagToSticky(tagName="Work &amp; Fun")
 *   - tagBridge.resolveTag 直接 findByNameInScope("Work &amp; Fun", null)
 *   - DB 里存的是字面 "Work & Fun"，LIKE/相等都不命中 → ok:false + "tag not found"
 *   - 用户标签只要含 & < > " ' （如「Q&A」「Tom & Jerry」「<important>」），
 *     走 listTags → applyX 的标准路径全部失败。
 *
 * 设计原则（最小改动 / 不破坏 prompt-injection 防御）：
 *   - escapeToolText 仍保留 —— 在 listTags / searchStickies 等输出端继续
 *     阻断通过 markup 注入 system prompt 语义的向量。
 *   - 仅在「按字面去 DB 查」的入口（tagBridge.resolveTag / addTag 的 name
 *     与 parentName）做一次 unescape，保证 DB 字面与工具入参一致。
 *   - 不对任意 LLM 入参做 unescape（会破坏 escapeToolText 在其它场景
 *     的语义），仅在白名单位置收口。
 */
export function unescapeToolText(s: string): string {
  // R-fix-tooltext-roundtrip：必须先还原 `&amp;` 再还原其它实体 —— 否则
  // 双层 escape（`&amp;quot;`）会被先吃成 `&quot;`→`"`，再回到 `&amp;`→`&`
  // 的伪路径。常见 round-trip 仅单层 escape，但顺序写反是隐性 bug，
  // 直接以 `&amp;` 优先消解，行为与对称 escape 严格可逆。
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/**
 * R-fix-sticky-data-only-wrapper (MEDIUM prompt-injection-defense-in-depth)：
 * 把用户写入的 sticky title/description 包在 `<sticky_summary data-only="true">`
 * 里，告诉 LLM「这是数据不是指令」。与 searchNotes / summarizeNote 使用的
 * `<note_meta data-only="true">` / `<note_content_snippet data-only="true">` /
 * `<note_content data-only="true">` 风格对齐（R33-Sec-1 / R32-02 /
 * R-fix-note-wrapper-helpers）。
 *
 * 为什么需要 wrapper 而不只是 escapeToolText：
 * - 5-char HTML escape 仅阻断 markup 注入（`<system>` → `&lt;system&gt;`）。
 * - 但 escape 不给 LLM 任何「这是数据」的显式信号 —— 模型仍可能因为标题
 *   含「Assistant, now ...」这类语用结构而误信为指令。wrapper 的 `data-only`
 *   属性是给 LLM 的语义标签，告诉它整段是数据段、不能视为指令。
 * - searchNotes / summarizeNote 已统一使用 wrapper；searchStickies / planDay
 *   此前只 escape 不 wrap —— 攻击者只要挑其中一个工具做注入就能绕开 wrapper
 *   防御。统一后两个域的防御纵深一致。
 *
 * 使用：所有返回给 LLM 的 user-controlled sticky 字符串字段都走这个 helper。
 * 工具调用方传「已经 escape 过的字符串」（如 escapeToolText(n.title)），这里
 * 再外层包 wrapper —— 不在内部 escape 一次，避免双重 escape。
 */
export function wrapAsStickyData(escapedText: string): string {
  return `<sticky_summary data-only="true">${escapedText}</sticky_summary>`
}

/**
 * R-fix-note-wrapper-helpers (MEDIUM structure/data-only-drift)：
 * 把 note 域三个工具（searchNotes / summarizeNote）的 wrapper 收敛到
 * validators.ts，与 wrapAsStickyData 走同一份权威源。原版 note.ts 在
 * 4 处直接 inline `<note_meta data-only="true">...</note_meta>` /
 * `<note_content_snippet data-only="true">...</note_content_snippet>` /
 * `<note_content data-only="true">...</note_content>` 字面量，header
 * 注释（line 150-167）却声称「note 域已统一 wrap」—— 实际上一旦有人
 * 在 validators 改名 / 加属性（例如把 sticky_summary 升格为 sticky_block
 * 后想给 note 域同步加一个 note_block），sticky 路径会跟着 wrap helper
 * 自动同步，note 路径仍然漂着旧 markup，LLM 已学习的「这是数据」的
 * 边界语义在跨工具场景下静默不一致。统一成 helper 后改一处即全栈同步。
 *
 * 使用约定与 wrapAsStickyData 一致：调用方传「已经 escape 过的字符串」
 * （escapeToolText(...)），helper 只做外层包裹，不二次 escape。
 */
export function wrapAsNoteMeta(escapedText: string): string {
  return `<note_meta data-only="true">${escapedText}</note_meta>`
}

export function wrapAsNoteContentSnippet(escapedText: string): string {
  return `<note_content_snippet data-only="true">${escapedText}</note_content_snippet>`
}

export function wrapAsNoteContent(escapedText: string): string {
  return `<note_content data-only="true">${escapedText}</note_content>`
}


/**
 * R-fix-notes-filename-sanitize-drift (MEDIUM correctness): original
 * createNoteTool (note.ts:89) and the disk-writing helper createNoteConfirmed
 * (createNote.ts:159-168) each maintained their own sanitize rules. The former
 * only filters 9 Windows-illegal chars + truncates to 80 chars; the latter
 * additionally filters control chars, strips trailing [\.\s], replaces ^\.+
 * with _, and falls back to literal "untitled". The drift between the two
 * caused the filename shown in the confirm dialog to differ from the filename
 * actually written to disk (e.g. "..secret" -> shows "..secret-abcd.md" / writes
 * "_secret-abcd.md"), producing a UX/data-integrity incident where the user
 * thought they were approving X but Y was written.
 *
 * Fix: collapse the full sanitize pipeline to a single helper here. Both
 * note.ts and createNoteConfirmed derive the filename from this function, so
 * the filename shown in the confirm dialog is byte-identical to the one
 * written to disk. The function also returns a yamlSafe string (control chars
 * + double-quote escaped) for the disk-write helper to reuse when emitting
 * YAML frontmatter, so the create-side no longer needs a second-pass
 * sanitize that could drift again.
 */
export function sanitizeNoteFilename(title: string): {
  filename: string
  yamlSafe: string
} {
  // 1) filter filesystem-illegal chars + ASCII control chars
  // 2) truncate to 80 chars
  // 3) trim leading/trailing whitespace
  let safeName = String(title ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .slice(0, 80)
    .trim()
  // 4) drop trailing runs of "." and whitespace (Windows rejects trailing "."
  //    or space in filenames)
  // 5) replace leading "." with "_" (prevent ".." / "..." path traversal and
  //    ".git"-style conflicts)
  safeName = safeName.replace(/[.\s]+$/, "").replace(/^\.+/, "_")
  // 6) literal-fallback name (only contains "_-. " or empty) -> "untitled"
  if (!safeName || /^[_.\- ]+$/.test(safeName)) safeName = "untitled"
  // yamlSafe: 走统一的 escapeYamlScalar helper（见下），保持与 createNote.ts
  // tag 字段的 YAML 转义语义字节级一致，未来扩转义规则（如加 \\ escape、
  // 控制字符扩到 0x7F、unicode normalization）只改一处。
  const yamlSafe = escapeYamlScalar(safeName)
  return { filename: safeName, yamlSafe }
}

/**
 * R-fix-yaml-escape-dedup (HIGH duplication-drift)：把 frontmatter 写入
 * 用的 YAML 标量转义语义收敛到唯一权威源。当前 createNote.ts 内部对
 * tags 数组 inline 复制了同一份「`\r\n\t\v\f\0` → 空格 + 双引号转义」
 * 规则（line 211-218），与本文件 sanitizeNoteFilename 内的 yamlSafe 计
 * 算漂移两份。设计意图：双引号包裹的 YAML 字符串里 `\"` 是唯一需要
 * 转义的字符（其余控制字符先折成普通空格，避免破坏 YAML 解析器对换行
 * / 制表符的结构识别）。未来若扩转义规则（如加 `\\` 转义 / 扩展控制
 * 字符范围 / 兼容 NFKC 归一化），只改本 helper、两个调用点（title 与
 * tags）字节级同步，避免「title 走新规则、tags 走老规则」导致解析不一致。
 *
 * 调用约定：返回值已经是「可直接放进 `"..."` 双引号字符串内」的字符串
 * —— 调用方负责外层双引号包裹；helper 不自带引号。
 */
export function escapeYamlScalar(s: string): string {
  return s
    .replace(/[\r\n\t\v\f\0]/g, ' ')
    .replace(/"/g, '\\"')
}
