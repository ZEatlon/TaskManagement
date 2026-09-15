/**
 * tagBridge.ts 的 R33 修复（MEDIUM tagBridge-applyTagToNote-prefix-bypass）
 * 防线单测 —— 覆盖 applyTagToNote / applyTagToSticky / removeTagFromSticky
 * 三条核心路径。
 *
 * 关键防线（见 src/main/ai/tagBridge.ts line 85-117）：
 *   1. needle.length < MIN_PREFIX_NEEDLE_LENGTH (4) 时拒绝前缀匹配，并
 *      报告当前库中 prefixMatches 数量（让 LLM 知道要给更完整的 filename）
 *   2. 多匹配时也走同一 disambiguation 错误（不静默贴第一篇）
 *   3. 「标签不存在」时绝不隐式创建（与 addTag 工具的关键语义区别）
 *
 * 设计：
 *   - scripts/test-loader.mjs 把 tagBridge.ts 的 3 个 repo（tagsRepo /
 *     notesRepo / stickyNotesRepo）和 log 替换成 in-memory 桩。
 *   - 测试通过 globalThis.__test_{tagsByName,notes,stickies} 注入 mock 数据，
 *     通过 globalThis.__test_*UpdateCalls 断言写入路径。
 *   - .mts 后缀让 Node 把测试文件当 ESM 处理（顶层 await + import()）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== 类型 =====

interface Note {
  id: string
  filename: string
  tags: string[]
}
interface Sticky {
  id: string
  tags: string[]
}
interface Tag {
  id: string
  name: string
}
interface TagUpdateCall {
  id: string
  patch: Partial<Tag>
}
interface NoteUpdateMetaCall {
  id: string
  patch: Partial<Note>
}
interface StickyUpdateCall {
  id: string
  patch: Partial<Sticky>
}

// ===== globalThis 注入 =====

;(globalThis as { __test_tagsByName?: Map<string, Tag> }).__test_tagsByName = new Map()
;(globalThis as { __test_tagsById?: Map<string, Tag> }).__test_tagsById = new Map()
;(globalThis as { __test_notes?: Note[] }).__test_notes = []
;(globalThis as { __test_stickies?: Sticky[] }).__test_stickies = []
;(globalThis as { __test_tagUpdateCalls?: TagUpdateCall[] }).__test_tagUpdateCalls = []
;(globalThis as { __test_noteUpdateMetaCalls?: NoteUpdateMetaCall[] }).__test_noteUpdateMetaCalls = []
;(globalThis as { __test_stickyUpdateCalls?: StickyUpdateCall[] }).__test_stickyUpdateCalls = []

function tagsByName(): Map<string, Tag> {
  return (globalThis as { __test_tagsByName?: Map<string, Tag> }).__test_tagsByName ?? new Map()
}
function tagsById(): Map<string, Tag> {
  return (globalThis as { __test_tagsById?: Map<string, Tag> }).__test_tagsById ?? new Map()
}
function notes(): Note[] {
  return (globalThis as { __test_notes?: Note[] }).__test_notes ?? []
}
function stickies(): Sticky[] {
  return (globalThis as { __test_stickies?: Sticky[] }).__test_stickies ?? []
}
function noteUpdateMetaCalls(): NoteUpdateMetaCall[] {
  return (globalThis as { __test_noteUpdateMetaCalls?: NoteUpdateMetaCall[] }).__test_noteUpdateMetaCalls ?? []
}
function stickyUpdateCalls(): StickyUpdateCall[] {
  return (globalThis as { __test_stickyUpdateCalls?: StickyUpdateCall[] }).__test_stickyUpdateCalls ?? []
}

function resetAll(): void {
  ;(globalThis as { __test_tagsByName?: Map<string, Tag> }).__test_tagsByName = new Map()
  ;(globalThis as { __test_tagsById?: Map<string, Tag> }).__test_tagsById = new Map()
  ;(globalThis as { __test_notes?: Note[] }).__test_notes = []
  ;(globalThis as { __test_stickies?: Sticky[] }).__test_stickies = []
  ;(globalThis as { __test_tagUpdateCalls?: TagUpdateCall[] }).__test_tagUpdateCalls = []
  ;(globalThis as { __test_noteUpdateMetaCalls?: NoteUpdateMetaCall[] }).__test_noteUpdateMetaCalls = []
  ;(globalThis as { __test_stickyUpdateCalls?: StickyUpdateCall[] }).__test_stickyUpdateCalls = []
}

/** seed 一个已注册标签 */
function seedTag(name: string, id = `tag-${name}`): Tag {
  const tag: Tag = { id, name }
  tagsByName().set(name, tag)
  tagsById().set(id, tag)
  return tag
}

// ===== 加载被测模块 =====
const tagBridge = await import('../src/main/ai/tagBridge.ts')

// ===== Tests: applyTagToNote =====

await test('R33 fix: needle.length < 4 (1 char) → refuse prefix match + report prefixMatches count', async () => {
  resetAll()
  seedTag('重要', 'tag-1')
  notes().push(
    { id: 'n1', filename: '重大会纪要-2026-01.md', tags: [] },
    { id: 'n2', filename: '重写设计文档.md', tags: [] },
    { id: 'n3', filename: '重启计划.md', tags: [] },
  )

  const result = await tagBridge.applyTagToNote('重要', '重')
  assert.equal(result.ok, false, '1-char needle must NOT auto-apply to first match')
  assert.match(result.error ?? '', /长度低于 4/)
  assert.match(result.error ?? '', /3 篇/, 'must report actual prefixMatches count (3)')
  // 关键：必须没写到任何 note 的 tags 上
  assert.equal(noteUpdateMetaCalls().length, 0, 'no note may be mutated on short-needle refuse')
  for (const n of notes()) assert.deepEqual(n.tags, [])
})

await test('R33 fix: needle.length = 2 (2 chars) → refuse prefix match even when only 1 note matches', async () => {
  resetAll()
  seedTag('重要', 'tag-1')
  notes().push({ id: 'n1', filename: '会议纪要-2026-01.md', tags: [] })

  const result = await tagBridge.applyTagToNote('重要', '会议')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /长度低于 4/)
  assert.equal(noteUpdateMetaCalls().length, 0)
})

await test('R33 fix: long needle with 0 exact + multiple prefix matches → disambiguation', async () => {
  resetAll()
  seedTag('important', 'tag-1')
  notes().push(
    { id: 'n1', filename: 'meeting-2026-01.md', tags: [] },
    { id: 'n2', filename: 'meeting-2026-02.md', tags: [] },
  )

  const result = await tagBridge.applyTagToNote('important', 'meeting-2026')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /匹配到 2 篇/)
  assert.equal(noteUpdateMetaCalls().length, 0, 'multi-match must not silently pick one')
})

await test('applyTagToNote: long needle with 0 exact + 1 prefix match → apply with matchKind="prefix"', async () => {
  resetAll()
  seedTag('important', 'tag-1')
  notes().push(
    { id: 'n1', filename: 'meeting-2026-01.md', tags: [] },
    { id: 'n2', filename: '其他.md', tags: [] },
  )

  const result = await tagBridge.applyTagToNote('important', 'meeting-2026')
  assert.equal(result.ok, true)
  assert.equal(result.matchKind, 'prefix')
  assert.equal(result.target, 'meeting-2026-01.md')
  assert.equal(result.alreadyTagged, false)
  // 写入调用：notesRepo.updateMeta(n1, { tags: ['important'] })
  const calls = noteUpdateMetaCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.id, 'n1')
  assert.deepEqual(calls[0]?.patch, { tags: ['important'] })
  // 实际数据被改写
  const updated = notes().find((n) => n.id === 'n1')
  assert.deepEqual(updated?.tags, ['important'])
})

await test('applyTagToNote: exact filename match → apply with matchKind="exact"', async () => {
  resetAll()
  seedTag('work', 'tag-work')
  notes().push({ id: 'n1', filename: 'meeting-2026-01.md', tags: [] })

  const result = await tagBridge.applyTagToNote('work', 'meeting-2026-01.md')
  assert.equal(result.ok, true)
  assert.equal(result.matchKind, 'exact')
  assert.equal(result.target, 'meeting-2026-01.md')
  assert.equal(noteUpdateMetaCalls().length, 1)
})

await test('applyTagToNote: short needle but exact filename match (R39-fix-tag-exact-length) → apply', async () => {
  resetAll()
  seedTag('work', 'tag-work')
  notes().push(
    { id: 'n1', filename: '重.md', tags: [] },
    { id: 'n2', filename: '重启计划.md', tags: [] },
  )

  // needle='重.md' 长度 4 (>= 4 threshold), exact match on '重.md' → apply
  const result = await tagBridge.applyTagToNote('work', '重.md')
  assert.equal(result.ok, true, 'exact match on a short-name file should apply')
  assert.equal(result.matchKind, 'exact')
})

await test('applyTagToNote: tag not registered → ok:false "tag not found", no mutation', async () => {
  resetAll()
  notes().push({ id: 'n1', filename: 'meeting.md', tags: [] })

  const result = await tagBridge.applyTagToNote('never-created', 'meeting.md')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /tag not found/)
  assert.equal(noteUpdateMetaCalls().length, 0, 'must NOT auto-create the tag')
})

await test('applyTagToNote: empty tagName / empty noteFilename → ok:false, no mutation', async () => {
  resetAll()
  seedTag('work', 'tag-work')
  notes().push({ id: 'n1', filename: 'meeting.md', tags: [] })

  const r1 = await tagBridge.applyTagToNote('', 'meeting.md')
  assert.equal(r1.ok, false)
  assert.match(r1.error ?? '', /tagName/)

  const r2 = await tagBridge.applyTagToNote('work', '')
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /noteFilename/)

  const r3 = await tagBridge.applyTagToNote('work', '   ')
  assert.equal(r3.ok, false)
  assert.match(r3.error ?? '', /noteFilename/)
})

await test('applyTagToNote: already tagged (idempotent) → ok:true alreadyTagged:true, no re-write', async () => {
  resetAll()
  seedTag('work', 'tag-work')
  notes().push({ id: 'n1', filename: 'meeting.md', tags: ['work'] })

  const result = await tagBridge.applyTagToNote('work', 'meeting.md')
  assert.equal(result.ok, true)
  assert.equal(result.alreadyTagged, true)
  assert.deepEqual(result.tags, ['work'])
  assert.equal(noteUpdateMetaCalls().length, 0, 'idempotent call must not re-write')
})

// ===== Tests: applyTagToSticky =====

await test('applyTagToSticky: sticky exists + tag exists → write tag.id to sticky.tags', async () => {
  resetAll()
  seedTag('urgent', 'tag-urgent')
  stickies().push({ id: 'sticky-1', tags: [] })

  const result = await tagBridge.applyTagToSticky('urgent', 'sticky-1')
  assert.equal(result.ok, true)
  assert.equal(result.target, 'sticky-1')
  assert.equal(result.alreadyTagged, false)
  // sticky.tags 存的是 tag ID，不是 name
  const calls = stickyUpdateCalls()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.patch, { tags: ['tag-urgent'] })
})

await test('applyTagToSticky: already tagged → ok:true alreadyTagged:true, no re-write', async () => {
  resetAll()
  seedTag('urgent', 'tag-urgent')
  stickies().push({ id: 'sticky-1', tags: ['tag-urgent'] })

  const result = await tagBridge.applyTagToSticky('urgent', 'sticky-1')
  assert.equal(result.ok, true)
  assert.equal(result.alreadyTagged, true)
  assert.equal(stickyUpdateCalls().length, 0)
})

await test('applyTagToSticky: tag not registered → ok:false "tag not found", no write', async () => {
  resetAll()
  stickies().push({ id: 'sticky-1', tags: [] })

  const result = await tagBridge.applyTagToSticky('never-created', 'sticky-1')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /tag not found/)
  assert.equal(stickyUpdateCalls().length, 0)
})

await test('applyTagToSticky: sticky not found → ok:false "便签不存在"', async () => {
  resetAll()
  seedTag('urgent', 'tag-urgent')

  const result = await tagBridge.applyTagToSticky('urgent', 'no-such-sticky')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /便签不存在/)
})

// ===== Tests: removeTagFromSticky =====

await test('removeTagFromSticky: tag present → ok:true removed:true, tag.id removed from sticky.tags', async () => {
  resetAll()
  seedTag('urgent', 'tag-urgent')
  seedTag('work', 'tag-work')
  stickies().push({ id: 'sticky-1', tags: ['tag-urgent', 'tag-work'] })

  const result = await tagBridge.removeTagFromSticky('urgent', 'sticky-1')
  assert.equal(result.ok, true)
  assert.equal(result.removed, true)
  assert.equal(result.alreadyTagged, true, 'was tagged before remove')
  // 剩下 tag-work
  assert.deepEqual(result.tags, ['tag-work'])
  // 实际写入只 patch tags
  const calls = stickyUpdateCalls()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.patch, { tags: ['tag-work'] })
})

await test('removeTagFromSticky: tag NOT present → ok:true removed:false (idempotent)', async () => {
  resetAll()
  seedTag('urgent', 'tag-urgent')
  seedTag('work', 'tag-work')
  stickies().push({ id: 'sticky-1', tags: ['tag-work'] })

  const result = await tagBridge.removeTagFromSticky('urgent', 'sticky-1')
  assert.equal(result.ok, true, 'must not fail when tag is absent — avoids LLM retry loops')
  assert.equal(result.removed, false)
  assert.equal(result.alreadyTagged, false)
  assert.equal(stickyUpdateCalls().length, 0, 'idempotent remove must not touch DB')
})

await test('removeTagFromSticky: tag not registered → ok:false "tag not found", no mutation', async () => {
  resetAll()
  stickies().push({ id: 'sticky-1', tags: ['tag-x'] })

  const result = await tagBridge.removeTagFromSticky('never-typoed', 'sticky-1')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /tag not found/)
  assert.equal(stickyUpdateCalls().length, 0)
})
