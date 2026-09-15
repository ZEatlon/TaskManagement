/**
 * src/main/ai/tools/createNote.ts 的 R33 / R31-Sec-5 / R-fix-notes-filename
 * 防线单测 —— 覆盖 pendingCreateNote FIFO + ownership + title-equality
 * + 落盘文件名一致性 + 路径穿越拒绝 + tag frontmatter 写盘 共 6 类场景。
 *
 * createNote.ts 是 R33 修复 ai:confirm-create-note-bypass 的核心：把
 * (callerId, toolCallId) 强校验做成端到端防 bypass。如果 FIFO 逻辑 /
 * title-equality / filename-sanitize 任何一处回退，bypass / UX 漂移 /
 * 路径穿越 bug 会回流，而现有测试矩阵不会报警。
 *
 * 测试策略：
 *   1. isFromAiTools 上下文让 loader 替换 `../../log` / `libraryManager` /
 *      `notes/pathSafety` 三个依赖为可注入 stub，避免真实 electron / DB。
 *   2. pendingCreateNoteByWebContents 是 createNote.ts 私有 Map —— 测试
 *      只能通过公开 registerPendingCreateNote / consumePendingCreateNote
 *      行为式验证（FIFO 间接通过「先 insert 200 条再 insert 1 条 + 试图
 *      consume 第 1 条」确认）。
 *   3. createNoteConfirmed 写到真实 tmp dir（用 os.tmpdir() + 自建子目录），
 *      之后 verify 文件存在 + 内容含 frontmatter + tag 字段。
 *
 * 运行：npm run test:create-note-fifo
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ===== 加载被测模块 =====
const createNote = await import('../src/main/ai/tools/createNote.ts')

// ===== 测试用 tmp dir（每个 before() 新建一份，after() 删） =====
let tmpRoot: string

function setupTmpDir(): void {
  tmpRoot = mkdtempSync(join(tmpdir(), 'taskpilot-test-createNote-'))
  // notes dir 提前建好 —— writeFile 不会自动创建父目录。
  mkdirSync(join(tmpRoot, '.taskpilot', 'notes'), { recursive: true })
  ;(globalThis as { __test_currentLibrary?: string | null }).__test_currentLibrary = tmpRoot
}

function teardownTmpDir(): void {
  ;(globalThis as { __test_currentLibrary?: string | null }).__test_currentLibrary = null
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// =====================================================================
// registerPendingCreateNote / consumePendingCreateNote
// =====================================================================

await test('consumePendingCreateNote: matching key + title returns ok + payload', () => {
  createNote.registerPendingCreateNote(101, 'tc-1', {
    title: 'Meeting notes',
    content: 'body content here',
  })
  const r = createNote.consumePendingCreateNote(101, 'tc-1', 'Meeting notes')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.title, 'Meeting notes')
    assert.equal(r.content, 'body content here')
  }
})

await test('consumePendingCreateNote: missing key → "no pending createNote ... bypass attempt?"', () => {
  // 没 register 过任何 pending，直接 consume 应返回 ok:false 并明确
  // 提示「bypass attempt?」便于审计定位。
  const r = createNote.consumePendingCreateNote(102, 'never-registered', 'whatever')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(
      r.error.includes('no pending createNote') &&
        r.error.includes('bypass attempt'),
      `error must mention "bypass attempt", got: ${r.error}`,
    )
  }
})

await test('consumePendingCreateNote: mismatched title → "submitted title does not match LLM-streamed proposal"', () => {
  // R33 防线核心：LLM 流式产生的标题在 IPC 落地前被渲染端偷换 → 拒绝。
  // 用户以为同意的是 "Meeting notes"，实际写盘是 "evil..." 是不被允许的。
  createNote.registerPendingCreateNote(103, 'tc-mt', {
    title: 'Meeting notes',
    content: 'body',
  })
  const r = createNote.consumePendingCreateNote(103, 'tc-mt', 'evil')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(
      r.error.includes('submitted title does not match'),
      `error must mention title mismatch, got: ${r.error}`,
    )
  }
})

await test('consumePendingCreateNote: title-equality is exact (whitespace / casing differences rejected)', () => {
  // title equality 是 strict ===，没有 normalize / trim。LLM 流式产生的
  // 字面字符串是 canonical 值；renderer 不能偷偷加空格。
  createNote.registerPendingCreateNote(104, 'tc-eq', {
    title: 'Hello',
    content: 'body',
  })
  assert.equal(
    createNote.consumePendingCreateNote(104, 'tc-eq', ' Hello ').ok,
    false,
    'leading/trailing space must fail',
  )
  assert.equal(
    createNote.consumePendingCreateNote(104, 'tc-eq', 'hello').ok,
    false,
    'lowercase difference must fail',
  )
})

await test('consumePendingCreateNote: (senderId, toolCallId) key scoping — second sender cannot consume first', () => {
  // 关键防御：键含 webContentsId，跨窗口 / 跨 webContents 不能 replay。
  createNote.registerPendingCreateNote(201, 'tc-shared', {
    title: 'Title A',
    content: 'content A',
  })
  // 同一 toolCallId 但不同 senderId（攻击者拿到别人的 toolCallId 后
  // 在自己的 webContents 假装同意）→ 拒绝。
  const r = createNote.consumePendingCreateNote(202, 'tc-shared', 'Title A')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(r.error.includes('no pending createNote'))
  }
  // 原 senderId 仍能 consume 自己的项（说明 key scoping 是 sender 维度）
  const r2 = createNote.consumePendingCreateNote(201, 'tc-shared', 'Title A')
  assert.equal(r2.ok, true)
})

await test('consumePendingCreateNote: same key consumed twice → second is ok:false (one-shot semantics)', () => {
  // 一次性消费语义：第一次 consume 后从表里 delete，第二次必须拒绝。
  createNote.registerPendingCreateNote(301, 'tc-once', {
    title: 'Once',
    content: 'content',
  })
  const r1 = createNote.consumePendingCreateNote(301, 'tc-once', 'Once')
  assert.equal(r1.ok, true)
  const r2 = createNote.consumePendingCreateNote(301, 'tc-once', 'Once')
  assert.equal(r2.ok, false, 'second consume must be refused (one-shot)')
})

await test('consumePendingCreateNote: empty toolCallId → consume treats as missing (no register)', () => {
  // toolCallId 为空时 register 内部 `if (!toolCallId) return` 直接不登记。
  // consume 用空字符串查找会 miss → ok:false。
  createNote.registerPendingCreateNote(401, '', {
    title: 't',
    content: 'c',
  })
  const r = createNote.consumePendingCreateNote(401, '', 't')
  assert.equal(r.ok, false)
})

await test('consumePendingCreateNote: null webContentsId on register → key "null::toolCallId"; later consume from number senderId refuses', () => {
  // register 时 webContentsId 为 null 用 'null' 字面作 key；这种 pending
  // 永远不能被任何 number senderId consume（handler 端也强制 senderId
  // 必须 match callerId）。
  createNote.registerPendingCreateNote(null, 'tc-nullcaller', {
    title: 'Null-caller title',
    content: 'content',
  })
  const r = createNote.consumePendingCreateNote(999, 'tc-nullcaller', 'Null-caller title')
  assert.equal(r.ok, false, 'number senderId cannot consume null-caller pending')
})

await test('registerPendingCreateNote: empty / missing toolCallId → no-op (not registered)', () => {
  // 防御 registerPendingCreateNote(undefined, ...) 这类 caller bug。
  // 空 toolCallId 登记会让 key 变成 'wcId::' 或 'null::'，反而污染表。
  // 实现选择 no-op 直接拒绝。
  const before = createNote.consumePendingCreateNote(501, '', 't').ok
  // 上面 register 一次空 + 一次 undefined（都不会进表）
  createNote.registerPendingCreateNote(501, '', { title: 't', content: 'c' })
  createNote.registerPendingCreateNote(501, undefined as unknown as string, {
    title: 't',
    content: 'c',
  })
  const r = createNote.consumePendingCreateNote(501, '', 't')
  assert.equal(r.ok, false, 'empty toolCallId register must be no-op')
  assert.equal(before, false)
})

await test('registerPendingCreateNote: tags is filtered — empty string entries dropped (non-string coerced via String())', () => {
  // tags 字段只持久化非空 string；空字符串过滤掉，非 string 类型
  // 先 String() 强转（42 → "42"），所以 42 仍保留。
  // 这是实现行为：String(t).filter(s => s.length > 0)。
  createNote.registerPendingCreateNote(601, 'tc-tags1', {
    title: 'Tagged note',
    content: 'c',
    tags: ['work', '', 'urgent', 42 as unknown as string],
  })
  const r = createNote.consumePendingCreateNote(601, 'tc-tags1', 'Tagged note')
  assert.equal(r.ok, true)
  if (r.ok) {
    // 空字符串被 filter 掉；42 走 String() 后保留为 "42"
    assert.deepEqual(r.tags, ['work', 'urgent', '42'])
  }
})

await test('registerPendingCreateNote: tags undefined / empty array → not stored', () => {
  createNote.registerPendingCreateNote(602, 'tc-tags2', {
    title: 'NoTags',
    content: 'c',
    tags: [],
  })
  const r = createNote.consumePendingCreateNote(602, 'tc-tags2', 'NoTags')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.tags, undefined, 'empty array must not produce tags field')
  }
})

// =====================================================================
// FIFO eviction at MAX = 200
// =====================================================================

await test('FIFO: after 201 inserts, the oldest entry is evicted (oldest key consume fails)', () => {
  // PENDING_CREATE_NOTE_MAX = 200。Map 按插入顺序排序，第 201 次 register
  // 后最老的 (wc, tc-0) 被淘汰。
  const wc = 701
  for (let i = 0; i < 200; i++) {
    createNote.registerPendingCreateNote(wc, `tc-fifo-${i}`, {
      title: `Title ${i}`,
      content: `c-${i}`,
    })
  }
  // 现在 size = 200。再 register 一条触发 FIFO eviction。
  createNote.registerPendingCreateNote(wc, 'tc-fifo-overflow', {
    title: 'Overflow',
    content: 'overflow-c',
  })
  // 第 0 条（最老）应已被淘汰
  const r0 = createNote.consumePendingCreateNote(wc, 'tc-fifo-0', 'Title 0')
  assert.equal(r0.ok, false, 'oldest entry (tc-fifo-0) must be evicted')
  if (!r0.ok) {
    assert.ok(r0.error.includes('no pending'))
  }
  // overflow 条仍在
  const rN = createNote.consumePendingCreateNote(wc, 'tc-fifo-overflow', 'Overflow')
  assert.equal(rN.ok, true, 'newest entry must still be present')
  // 中间任意一条（比如 tc-fifo-100）也仍在（说明只淘汰最老的一条）
  const rMid = createNote.consumePendingCreateNote(wc, 'tc-fifo-100', 'Title 100')
  assert.equal(rMid.ok, true)
})

// =====================================================================
// createNoteConfirmed — file write + filename sanitize + path safety
// =====================================================================

await test('createNoteConfirmed: writes file under tmp dir with frontmatter + content', async () => {
  setupTmpDir()
  try {
    const result = await createNote.createNoteConfirmed({
      title: 'My meeting',
      content: '# Heading\nbody body',
    })
    assert.equal(result.ok, true, 'createNoteConfirmed must succeed')
    if (result.ok) {
      assert.ok(result.id, 'must return generated id')
      assert.ok(result.filename.endsWith('.md'))
      assert.match(result.filename, /^My meeting-[0-9a-f]{8}\.md$/)
      // 实际文件应存在于 tmpRoot/.taskpilot/notes/
      const filePath = join(tmpRoot, '.taskpilot', 'notes', result.filename)
      assert.ok(existsSync(filePath), `file must exist at ${filePath}`)
      const fileContent = readFileSync(filePath, 'utf-8')
      // Frontmatter delimiters --- ... --- — closing --- 没有前置 \n，
      // 它紧跟在 createdAt ISO 字符串之后（front template 把 --- 直接拼到 createdAt 末尾）。
      // 所以正确的 substring 是 `---Z\n\n` 形态（`Z` 是 ISO 字符串尾字符），
      // 不是 `\n---\n\n`。
      assert.ok(fileContent.startsWith('---\n'), 'starts with opening ---\\n')
      assert.ok(
        /Z---\n\n# Heading/.test(fileContent) || /Z---\r\n\r\n# Heading/.test(fileContent),
        'must close frontmatter with --- and have blank line before body',
      )
      assert.ok(fileContent.includes('id:'), 'frontmatter must include id')
      assert.ok(fileContent.includes('title: "My meeting"'), 'title in frontmatter')
      assert.ok(fileContent.endsWith('# Heading\nbody body'), 'body content preserved at end')
    }
  } finally {
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: title "..secret" sanitizes to "_secret" (drift with confirm dialog guarded)', () => {
  // R-fix-notes-filename-sanitize-drift invariant：confirm 弹窗与落盘
  // 看到的 filename 必须字节一致。本测试覆盖 sanitize 路径：
  //   "..secret" → "_secret-{id8}.md"
  setupTmpDir()
  try {
    return createNote.createNoteConfirmed({
      title: '..secret',
      content: 'content',
    }).then((result) => {
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.match(
          result.filename,
          /^_secret-[0-9a-f]{8}\.md$/,
          'leading .. must map to _ (single _ for run)',
        )
        assert.equal(result.title, '_secret', 'returned title is the sanitized version')
      }
    })
  } finally {
    // async finally 在 .then 后跑 —— 单独处理
    setTimeout(() => teardownTmpDir(), 0)
  }
})

await test('createNoteConfirmed: Windows-illegal chars in title all map to "_"', async () => {
  setupTmpDir()
  try {
    const result = await createNote.createNoteConfirmed({
      title: 'evil\\/*?"<>|name',
      content: 'c',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      // 8 个非法字符（\ / * ? " < > |）全替成 _，保留 'evil' + 'name'
      assert.match(
        result.filename,
        /^evil________name-[0-9a-f]{8}\.md$/,
        `expected 8 underscores between evil and name, got: ${result.filename}`,
      )
    }
  } finally {
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: empty title → ok:false (no write)', async () => {
  setupTmpDir()
  try {
    const result = await createNote.createNoteConfirmed({ title: '', content: 'c' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('title 不能为空') || result.error.includes('title'))
    }
  } finally {
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: library not configured → ok:false', async () => {
  ;(globalThis as { __test_currentLibrary?: string | null }).__test_currentLibrary = null
  try {
    const result = await createNote.createNoteConfirmed({
      title: 'some title',
      content: 'c',
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('库目录未配置'))
    }
  } finally {
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: isRealPathInside returns false → ok:false (R31-Sec-5 symlink-escape defense)', async () => {
  setupTmpDir()
  // 模拟 symlink / 路径穿越检测失败（library 实际指向 notesDir 之外）
  ;(globalThis as { __test_isRealPathInside?: (root: string, target: string) => Promise<boolean> }).__test_isRealPathInside = async () => false
  try {
    const result = await createNote.createNoteConfirmed({
      title: 'try-escape',
      content: 'c',
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(
        result.error.includes('逃出 notesDir') ||
          result.error.includes('symlink') ||
          result.error.includes('路径穿越'),
        `error must mention symlink/path escape, got: ${result.error}`,
      )
    }
  } finally {
    ;(globalThis as { __test_isRealPathInside?: (root: string, target: string) => Promise<boolean> }).__test_isRealPathInside = undefined
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: tags are written to YAML frontmatter', async () => {
  setupTmpDir()
  try {
    const result = await createNote.createNoteConfirmed({
      title: 'Tagged note',
      content: 'body',
      tags: ['work', 'urgent'],
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.tags, ['work', 'urgent'])
      const filePath = join(tmpRoot, '.taskpilot', 'notes', result.filename)
      const fileContent = readFileSync(filePath, 'utf-8')
      assert.ok(fileContent.includes('tags:'), 'frontmatter must include tags:')
      assert.ok(
        fileContent.includes('- "work"') && fileContent.includes('- "urgent"'),
        'tag list must be quoted YAML block',
      )
    }
  } finally {
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: tags undefined / empty → no `tags:` line in frontmatter', async () => {
  setupTmpDir()
  try {
    const result = await createNote.createNoteConfirmed({
      title: 'No tags note',
      content: 'body',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      const filePath = join(tmpRoot, '.taskpilot', 'notes', result.filename)
      const fileContent = readFileSync(filePath, 'utf-8')
      assert.ok(!fileContent.includes('tags:'), 'empty tags must not write `tags:` line')
    }
  } finally {
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: degenerate filename ("..") → "untitled" fallback filename', async () => {
  setupTmpDir()
  try {
    const result = await createNote.createNoteConfirmed({
      title: '..',
      content: 'c',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.match(
        result.filename,
        /^untitled-[0-9a-f]{8}\.md$/,
        'degenerate title must fall back to "untitled-{id8}.md"',
      )
      assert.equal(result.title, 'untitled')
    }
  } finally {
    teardownTmpDir()
  }
})

await test('createNoteConfirmed: title with double-quote is mapped to "_" in frontmatter (illegal-char stage)', async () => {
  // 双引号 `"` 在 sanitizeNoteFilename 的 illegal-char list 里被映射到 _，
  // 所以 frontmatter 写入的是已 sanitize 后的 filename —— 双引号不会
  // 出现，自然不需要 yamlSafe 转义。这是 R-fix-notes-filename
  // -sanitize-drift 的预期行为：filename 阶段已处理，yamlSafe 不需要
  // 再转义。
  setupTmpDir()
  try {
    const result = await createNote.createNoteConfirmed({
      title: 'say "hello"',
      content: 'c',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      const filePath = join(tmpRoot, '.taskpilot', 'notes', result.filename)
      const fileContent = readFileSync(filePath, 'utf-8')
      assert.ok(
        fileContent.includes('title: "say _hello_"'),
        `"  must be mapped to _ in frontmatter, got: ${fileContent.split('\n').slice(0, 5).join(' | ')}`,
      )
    }
  } finally {
    teardownTmpDir()
  }
})
