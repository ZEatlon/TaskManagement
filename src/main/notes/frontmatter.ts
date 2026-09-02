/**
 * YAML frontmatter 解析
 *
 * 使用 gray-matter 解析 Markdown 文件头部的 YAML 元数据块。
 * 支持字段：id, title, tags (array), created, modified, starred, archived
 */
import matter from 'gray-matter'
import type { ID, ISODateTime } from '@shared/types'

/**
 * 笔记 frontmatter 的标准结构
 */
export interface NoteFrontmatter {
  id?: ID
  title?: string
  tags?: string[]
  created?: ISODateTime
  modified?: ISODateTime
  starred?: boolean
  archived?: boolean
  [key: string]: unknown
}

/**
 * frontmatter 解析结果
 */
export interface ParsedNote {
  /** 解析后的元数据（已剥离多余字段） */
  data: NoteFrontmatter
  /** 纯正文（不含 frontmatter 块） */
  content: string
  /** 原始文本（含 frontmatter） */
  original: string
}

/** 字段值的长度上限，避免异常 YAML（超长字符串 / 超大数组）撑爆内存与 UI */
const MAX_ID_LENGTH = 200
const MAX_TITLE_LENGTH = 500
const MAX_TAG_LENGTH = 100
const MAX_TAGS = 100

/**
 * 仅接受标量值并转成字符串；对象 / 数组 / 函数等一律丢弃。
 * YAML 时间戳会被解析成 Date，这里统一转为 ISO 字符串。
 */
function toSafeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).slice(0, maxLength)
  }
  if (typeof value === 'boolean') {
    return String(value)
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }
  return undefined
}

/** 日期字段：Date 归一化为 ISO；字符串需可被解析，否则丢弃 */
function toSafeDateTime(value: unknown): ISODateTime | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return undefined
    return Number.isNaN(new Date(trimmed).getTime()) ? undefined : trimmed
  }
  return undefined
}

/** 标签字段：只保留字符串元素，并限制数量与长度 */
function toSafeTags(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const single = toSafeString(value, MAX_TAG_LENGTH)
    return single ? [single] : []
  }
  if (!Array.isArray(value)) return undefined
  const tags: string[] = []
  for (const item of value) {
    if (tags.length >= MAX_TAGS) break
    // 嵌套对象 / 数组会在这里被丢弃，不会泄漏进 data
    if (typeof item !== 'string') continue
    const tag = toSafeString(item, MAX_TAG_LENGTH)
    if (tag) tags.push(tag)
  }
  return tags
}

/** 布尔字段：只接受真正的布尔值与常见布尔字符串 */
function toSafeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === 'no') return false
  }
  return undefined
}

/**
 * 已知字段白名单：键名 + 值类型双重校验。
 * frontmatter 可能来自不可信来源（如克隆的仓库），因此不能直接透传 YAML 解析结果，
 * 必须逐字段做类型收敛，杜绝嵌套对象 / 原型污染键混入 data。
 */
const FIELD_SANITIZERS: Record<string, (value: unknown) => unknown> = {
  id: (value) => toSafeString(value, MAX_ID_LENGTH),
  title: (value) => toSafeString(value, MAX_TITLE_LENGTH),
  tags: toSafeTags,
  created: toSafeDateTime,
  modified: toSafeDateTime,
  starred: toSafeBoolean,
  archived: toSafeBoolean,
}

/** 已知字段白名单（与 FIELD_SANITIZERS 保持单一数据源） */
const KNOWN_FIELDS = new Set(Object.keys(FIELD_SANITIZERS))

/** 上次解析失败的 frontmatter 错误（用于 IPC 上抛给 UI） */
let lastFrontmatterError: string | null = null

/** R14 修复 (medium)：保留最近一次解析时被白名单丢弃的未知 key，
 *  让调用方能在保存前提示用户「这些字段会被移除」，避免静默丢失
 *  从 git 同步下来 / 手写的扩展字段。最多保留 50 个以防失控。 */
let lastDroppedKeys: string[] = []

/** 读取最近一次 frontmatter 解析错误，UI 可在保存前提示用户 */
export function getLastFrontmatterError(): string | null {
  const err = lastFrontmatterError
  return err
}

/** 清空错误状态（例如重新解析成功后） */
export function clearLastFrontmatterError(): void {
  lastFrontmatterError = null
  lastDroppedKeys = []
}

/** 读取最近一次解析时被丢弃的未知 frontmatter 键 */
export function getLastDroppedFrontmatterKeys(): readonly string[] {
  return lastDroppedKeys
}

/**
 * 解析 Markdown 文本中的 frontmatter。
 * - 若没有 frontmatter 则 data 为空对象
 * - 异常字段（未知键、类型不符、嵌套结构）会被剥离以保证输出稳定与安全
 */
export function parseFrontmatter(content: string): ParsedNote {
  try {
    const parsed = matter(content)
    // R13 修复 (low)：解析成功时清空错误；解析失败时记录到
    // lastFrontmatterError，调用方（notesManager / note-handlers）可以
    // 把诊断信息返回给 UI 而不是静默吞掉。
    lastFrontmatterError = null
    const data: NoteFrontmatter = {}
    const dropped: string[] = []
    const raw: unknown = parsed.data
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const source = raw as Record<string, unknown>
      for (const key of Object.keys(source)) {
        // 键白名单（天然排除 __proto__ / constructor 等原型污染键）
        if (!KNOWN_FIELDS.has(key)) {
          // R14 修复 (medium)：记录被丢弃的 key，让上层在保存前提示用户，
          // 而不是等到 stringify 写回磁盘才发现「自定义字段没了」。
          dropped.push(key)
          continue
        }
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue
        // 值类型白名单
        const value = FIELD_SANITIZERS[key](source[key])
        if (value !== undefined) {
          ;(data as Record<string, unknown>)[key] = value
        }
      }
    }
    lastDroppedKeys = dropped.slice(0, 50)
    return {
      data,
      content: parsed.content,
      original: content,
    }
  } catch (err) {
    // R13 修复 (low)：解析失败时记录错误信息，调用方可在保存前用
    // getLastFrontmatterError() 提示用户「frontmatter 解析失败，
    // 下次保存将丢失 tags/title」。原先静默吞掉导致用户没有任何信号。
    lastFrontmatterError = (err as Error).message ?? String(err)
    lastDroppedKeys = []
    // 解析失败时返回原文与空 data
    return {
      data: {},
      content,
      original: content,
    }
  }
}

/**
 * 将正文与 frontmatter 序列化为完整 Markdown 文本。
 * - data 为空对象则不输出 frontmatter 块
 * - 自动保证 title/tags/created/modified 等关键字段的格式稳定
 */
export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  // 过滤掉 undefined / null 字段，保持输出干净
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    cleaned[k] = v
  }
  try {
    return matter.stringify(content, cleaned)
  } catch (err) {
    // 序列化失败则退化为仅正文
    return content
  }
}

/**
 * 从 frontmatter 与内容生成最小可用的默认值。
 * - 自动填充 id（若不存在）
 * - 自动填充 created（若不存在）
 * - 自动维护 modified（若未传入则取 now）
 */
export function normalizeFrontmatter(
  data: NoteFrontmatter,
  fallback: { id?: ID; title?: string; content: string; now?: ISODateTime },
): NoteFrontmatter {
  const now = fallback.now ?? new Date().toISOString()
  const normalized: NoteFrontmatter = { ...data }

  if (!normalized.id) {
    normalized.id = fallback.id ?? crypto.randomUUID()
  }
  if (!normalized.title) {
    // 取首行非空文本作为默认标题
    const firstLine =
      fallback.content
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? ''
    normalized.title = (fallback.title ?? firstLine.slice(0, 80)) || '未命名笔记'
  } else if (fallback.title) {
    normalized.title = fallback.title
  }
  // 确保无 undefined title
  if (!normalized.created) {
    normalized.created = now
  }
  normalized.modified = now

  if (!Array.isArray(normalized.tags)) {
    normalized.tags = []
  }
  normalized.starred = !!normalized.starred
  normalized.archived = !!normalized.archived

  return normalized
}
