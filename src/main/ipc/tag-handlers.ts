/**
 * 标签相关 IPC 处理器
 */
import { handle } from './channels'
import { tagsRepo } from '../db/repositories/tags'
import type { Tag } from '@shared/types'

// R25-Sec-3 修复 (medium input validation / DoS)：原 tag:create / tag:update
// 对 input.name / input.color / patch 完全无校验。被 XSS 控制的渲染端可以
// 提交 1MB 任意字节的 name（DoS 写入 + tags_json 同步膨胀到每条 note 行）
// 或 100kB null 字节污染 notes 列表。这里在 IPC 层做白名单 + 字节封顶 + 控
// 制字符清洗；颜色按 NoteFolderColor palette 校验；patch 仅允许 {name?, color?}
// 两个字段（拒绝其他任意 key 通过）。
const TAG_NAME_MAX_BYTES = 64
const TAG_COLOR_PALETTE = new Set([
  'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose', null,
])

/** Strip 控制字符（除 \t）和超过 0x7e / 0x80-0xff 的非法字节，便于人类识别。 */
function sanitizeTagName(s: unknown): string {
  if (typeof s !== 'string') throw new Error('tag: name must be string')
  // 删 NUL / \x01-\x08 / \x0b-\x1f / \x7f 控制字符（保留 \t = 0x09 与 \n = 0x0a
  // 少见但合法，但 tag 名里不需要这俩——保守全删）
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!cleaned) throw new Error('tag: name is empty after stripping control chars')
  if (Buffer.byteLength(cleaned, 'utf8') > TAG_NAME_MAX_BYTES) {
    throw new Error(`tag: name exceeds ${TAG_NAME_MAX_BYTES} bytes after cleanup`)
  }
  return cleaned
}

function sanitizeTagColor(c: unknown): string | null {
  if (c === undefined || c === null) return null
  if (typeof c !== 'string') throw new Error('tag: color must be string or null')
  if (!TAG_COLOR_PALETTE.has(c as null | string)) {
    throw new Error(
      `tag: color '${c}' not in palette (allowed: ${[...TAG_COLOR_PALETTE].filter(Boolean).join(', ')})`,
    )
  }
  return c
}

export function registerTagHandlers(): void {
  handle('tag:list', async () => tagsRepo.findAllTree())
  handle('tag:get', async (_e, id: string) => tagsRepo.findById(id))
  handle('tag:create', async (_e, input: { name: string; parentId?: string | null; color?: string | null }) => {
    const name = sanitizeTagName(input?.name)
    const color = sanitizeTagColor(input?.color)
    const parentId = input?.parentId ?? null
    if (parentId !== null && typeof parentId !== 'string') {
      throw new Error('tag: parentId must be string or null')
    }
    return tagsRepo.create({
      name,
      parentId,
      color,
      order: 0,
    })
  })
  handle('tag:update', async (_e, args: { id: string; patch: Partial<Tag> }) => {
    if (typeof args?.id !== 'string' || !args.id) {
      throw new Error('tag:update: id must be non-empty string')
    }
    const raw = args.patch ?? {}
    // patch 仅允许 name / color 两个字段（拒绝其他任意 key 通过 —— 例如
    // 攻击者塞 order / parentId / id 进 patch 直接覆盖 row）
    const patch: Partial<Tag> = {}
    if ('name' in raw) patch.name = sanitizeTagName((raw as Record<string, unknown>).name)
    if ('color' in raw) patch.color = sanitizeTagColor((raw as Record<string, unknown>).color)
    return tagsRepo.update(args.id, patch)
  })
  handle('tag:delete', async (_e, id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('tag:delete: id must be non-empty string')
    return tagsRepo.delete(id)
  })
  // R17 修复 (medium correctness)：tag:find-by-name 必须按 (name, parent_id)
  // 复合作用域查。迁移 008 把 UNIQUE(name) 换成 UNIQUE(name, parent_id) 后，
  // 不同 parent 下同名 tag 可共存 —— 原 findByName 用 `WHERE name = ?` 不带
  // parent_id，SQLite 会在多行中任选一条返回（非确定性），调用方无法分辨拿到
  // 的是哪个 scope 的 tag。改用 findByNameInScope，parent_id 来自 caller，
  // null 表示根作用域。
  handle(
    'tag:find-by-name',
    async (_e, args: { name: string; parentId?: string | null }) => {
      const name = sanitizeTagName(args?.name)
      const parentId = args?.parentId ?? null
      if (parentId !== null && typeof parentId !== 'string') {
        throw new Error('tag:find-by-name: parentId must be string or null')
      }
      return tagsRepo.findByNameInScope(name, parentId)
    },
  )
}