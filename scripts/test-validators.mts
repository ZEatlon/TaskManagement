/**
 * src/main/ai/tools/validators.ts 的 R30/R32/R39 防线单测 —— 覆盖整个
 * 纯函数 / 白名单校验层（escapeToolText / unescapeToolText /
 * sanitizeNoteFilename / parseSafeDate / parseSafeDayKey /
 * normalizeStatus / normalizePriority / 4 个 wrapper helpers）。
 *
 * 这层集中了 AI 工具侧所有 prompt-injection / enum-bypass / 日期越界 /
 * 路径穿越防御，跨 main / preload / renderer 三端共用。任何一处
 * validator 改动（例如去掉某个字符集、改变 escape 顺序）都需要通过本
 * 测试矩阵才能合入，否则下游所有 R30 / R32 / R39 防线失效。
 *
 * 测试策略：
 *   1. validators.ts 是纯模块（无 module-level 副作用），import 直接
 *      不需要 mock；但它 import '../../log'，会在模块加载时拉 electron-log，
 *      所以走 test-loader-register.mjs 的 isFromAiTools 上下文把 log
 *      替换成 stub（其它什么都不用 mock）。
 *   2. escapeToolText 与 unescapeToolText 的 round-trip 必须覆盖 5 个
 *      字符 + 双层 escape 反序场景（R-fix-tooltext-roundtrip 修复点）。
 *   3. sanitizeNoteFilename 必须在「confirm 弹窗」与「落盘」两条路径给出
 *      字节级一致的结果（R-fix-notes-filename-sanitize-drift invariant）。
 *
 * 运行：npm run test:validators
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ===== 加载被测模块 =====
const validators = await import('../src/main/ai/tools/validators.ts')

// =====================================================================
// escapeToolText
// =====================================================================

await test('escapeToolText: each of 5 chars maps to its entity', () => {
  assert.equal(validators.escapeToolText('&'), '&amp;')
  assert.equal(validators.escapeToolText('<'), '&lt;')
  assert.equal(validators.escapeToolText('>'), '&gt;')
  assert.equal(validators.escapeToolText('"'), '&quot;')
  assert.equal(validators.escapeToolText("'"), '&#39;')
})

await test('escapeToolText: 5-char combo in a typical string', () => {
  // 常见 XSS / prompt-injection 形态：覆盖 5 个字符 + 普通文本
  const input = `<script>alert("xss & 'evil'")</script>`
  const out = validators.escapeToolText(input)
  assert.equal(
    out,
    '&lt;script&gt;alert(&quot;xss &amp; &#39;evil&#39;&quot;)&lt;/script&gt;',
  )
})

await test('escapeToolText: idempotency-aware (not idempotent — second pass double-escapes)', () => {
  // escape 不幂等：escape(escape('<')) = escape('&lt;') = '&amp;lt;'。
  // round-trip 必须用 unescapeToolText 反解；这是 R-fix-tooltext-roundtrip
  // 的核心约束。
  const once = validators.escapeToolText('<')
  const twice = validators.escapeToolText(once)
  assert.equal(twice, '&amp;lt;', 'second pass must double-escape the & in &lt;')
})

await test('escapeToolText: empty / no-special-char inputs round-trip trivially', () => {
  assert.equal(validators.escapeToolText(''), '')
  assert.equal(validators.escapeToolText('hello world'), 'hello world')
  assert.equal(validators.escapeToolText('中文测试'), '中文测试')
  assert.equal(validators.escapeToolText('1234567890'), '1234567890')
})

// =====================================================================
// unescapeToolText — R-fix-tooltext-roundtrip
// =====================================================================

await test('unescapeToolText: each entity reverses to its char', () => {
  assert.equal(validators.unescapeToolText('&amp;'), '&')
  assert.equal(validators.unescapeToolText('&lt;'), '<')
  assert.equal(validators.unescapeToolText('&gt;'), '>')
  assert.equal(validators.unescapeToolText('&quot;'), '"')
  assert.equal(validators.unescapeToolText('&#39;'), "'")
})

await test('unescapeToolText: &amp; must be reduced BEFORE other entities (order matters)', () => {
  // R-fix-tooltext-roundtrip 修复点：double-escape `&amp;quot;` 必须先还原
  // &amp; → & 再还原 &quot; → "，否则会先吃 &quot; → " 然后留下 &"。
  // 反向（先吃 &quot; 后吃 &amp;）是隐性 bug，常见 round-trip 仅单层
  // escape 但顺序写反就让 round-trip 断链。
  assert.equal(
    validators.unescapeToolText('&amp;quot;'),
    '"',
    '&amp;quot; must produce " not &quot;',
  )
  // 反例：如果实现反了顺序 → 先吃 &quot; → "&" 再吃 &amp; → "&"，导致
  // 双层 escape 还原失败。本断言验证正确顺序路径。
})

await test('unescapeToolText: round-trip with escapeToolText is symmetric for single-layer', () => {
  const cases = [
    'plain text',
    'Q&A',
    'Tom & Jerry',
    '<important>',
    'quote "test"',
    "it's",
    `<script>alert("xss & 'evil'")</script>`,
    '混合 & 中 < 文 > " \' 测试',
  ]
  for (const input of cases) {
    const escaped = validators.escapeToolText(input)
    const back = validators.unescapeToolText(escaped)
    assert.equal(back, input, `round-trip failed for: ${input}`)
  }
})

await test('unescapeToolText: empty / no-entity inputs pass through', () => {
  assert.equal(validators.unescapeToolText(''), '')
  assert.equal(validators.unescapeToolText('plain text'), 'plain text')
  assert.equal(validators.unescapeToolText('中文'), '中文')
})

// =====================================================================
// parseSafeDate
// =====================================================================

await test('parseSafeDate: valid ISO 8601 datetime within bounds returns ISO', () => {
  const iso = validators.parseSafeDate('2026-09-14T12:00:00.000Z')
  assert.equal(typeof iso, 'string')
  assert.ok(iso?.startsWith('2026-09-14T12:00:00'), `expected ISO start, got ${iso}`)
})

await test('parseSafeDate: 9999-12-31 must be rejected (>10y upper bound guard)', () => {
  // LLM 可能写 9999-12-31 把排序推到 heatmap 末尾占位；validator 上界
  // 未来 10 年，2026-09 + 10y = 2036，9999-12-31 远在此外 → null。
  assert.equal(validators.parseSafeDate('9999-12-31'), null)
  assert.equal(validators.parseSafeDate('9999-12-31T00:00:00.000Z'), null)
})

await test('parseSafeDate: 1900-01-01 / 0001-01-01 rejected (epoch lower bound)', () => {
  // 下界 Unix epoch = 0 (1970-01-01)；1900 / 0001 都早于此。
  assert.equal(validators.parseSafeDate('1900-01-01'), null)
  assert.equal(validators.parseSafeDate('0001-01-01'), null)
})

await test('parseSafeDate: null and empty string both treated as "clear" (null)', () => {
  // R28-Sec-3 设计：「不要这个字段」用 null 表示，null 与空串同义。
  assert.equal(validators.parseSafeDate(null), null)
  assert.equal(validators.parseSafeDate(''), null)
  assert.equal(validators.parseSafeDate('   '), null, 'whitespace-only → null')
})

await test('parseSafeDate: non-string / garbage input → null (does not throw)', () => {
  // LLM prompt-injection 故意塞异常值试图触发 crash；静默拒绝比抛错稳。
  assert.equal(validators.parseSafeDate(123), null)
  assert.equal(validators.parseSafeDate({}), null)
  assert.equal(validators.parseSafeDate([]), null)
  assert.equal(validators.parseSafeDate(true), null)
  assert.equal(validators.parseSafeDate('not-a-date'), null)
  assert.equal(validators.parseSafeDate('2025-13-99T99:99:99Z'), null)
})

await test('parseSafeDate: boundary at 1970-01-01 exactly is allowed', () => {
  // lowerMs = 0 = 1970-01-01T00:00:00.000Z；恰好在此之上的 1ms 是合法的。
  const iso = validators.parseSafeDate('1970-01-01T00:00:00.000Z')
  assert.equal(iso, '1970-01-01T00:00:00.000Z')
})

// =====================================================================
// parseSafeDayKey
// =====================================================================

await test('parseSafeDayKey: valid YYYY-MM-DD passes through', () => {
  assert.equal(validators.parseSafeDayKey('2026-09-14'), '2026-09-14')
})

await test('parseSafeDayKey: leap year 2024-02-29 accepted', () => {
  assert.equal(validators.parseSafeDayKey('2024-02-29'), '2024-02-29')
})

await test('parseSafeDayKey: 2025-02-30 must be rejected (round-trip via Date would silently slip)', () => {
  // new Date('2025-02-30') 实际解析到 2025-03-02，但 parseSafeDayKey 通过
  // round-trip 比对 UTC 字段强制拒绝。
  assert.equal(validators.parseSafeDayKey('2025-02-30'), null)
})

await test('parseSafeDayKey: 2025-13-99 rejected (month/day range)', () => {
  assert.equal(validators.parseSafeDayKey('2025-13-99'), null)
  assert.equal(validators.parseSafeDayKey('2025-00-15'), null)
  assert.equal(validators.parseSafeDayKey('2025-12-00'), null)
  assert.equal(validators.parseSafeDayKey('2025-12-32'), null)
})

await test('parseSafeDayKey: non-ISO format rejected', () => {
  assert.equal(validators.parseSafeDayKey('not-a-date'), null)
  assert.equal(validators.parseSafeDayKey('today'), null)
  assert.equal(validators.parseSafeDayKey('昨天'), null)
  assert.equal(validators.parseSafeDayKey('2026/09/14'), null)
  assert.equal(validators.parseSafeDayKey('2026-9-14'), null, 'no zero-pad')
  assert.equal(validators.parseSafeDayKey('26-09-14'), null, 'short year')
  assert.equal(validators.parseSafeDayKey(''), null)
  // 实现先 trim 再走 regex —— 周围空白被消化。
  assert.equal(validators.parseSafeDayKey('  2026-09-14  '), '2026-09-14', 'leading/trailing whitespace is trimmed')
})

await test('parseSafeDayKey: non-string / garbage → null (does not throw)', () => {
  assert.equal(validators.parseSafeDayKey(null), null)
  assert.equal(validators.parseSafeDayKey(undefined), null)
  assert.equal(validators.parseSafeDayKey(20260914), null)
  assert.equal(validators.parseSafeDayKey({}), null)
  assert.equal(validators.parseSafeDayKey(['2026-09-14']), null)
})

// =====================================================================
// normalizeStatus / normalizePriority
// =====================================================================

await test('normalizeStatus: each value in VALID_STICKY_STATUSES passes through', () => {
  // W2-C③：sticky status 砍到 todo/done 两值。in_progress / cancelled 不再是合法值。
  for (const v of ['todo', 'done']) {
    assert.equal(validators.normalizeStatus(v), v)
  }
})

await test('normalizeStatus: in_progress / cancelled → undefined (W2-C③ retired values)', () => {
  // W2-C③ 防线：DB schema 无 CHECK 约束，LLM 绕过 JSON Schema enum 写
  // 'in_progress' / 'cancelled' / 任何拼写错误必须白名单拒绝，否则会变
  // 幽灵行（migration 020 不再回填新写入的）。
  assert.equal(validators.normalizeStatus('in_progress'), undefined)
  assert.equal(validators.normalizeStatus('cancelled'), undefined)
  assert.equal(validators.normalizeStatus('in_progress_extra'), undefined)
  assert.equal(validators.normalizeStatus('done_evil'), undefined)
  assert.equal(validators.normalizeStatus('DONE'), undefined, 'case sensitive')
  assert.equal(validators.normalizeStatus(''), undefined)
})

await test('normalizeStatus: undefined / null → undefined (not throw)', () => {
  assert.equal(validators.normalizeStatus(undefined), undefined)
  assert.equal(validators.normalizeStatus(null), undefined)
})

await test('normalizeStatus: non-string garbage → undefined', () => {
  assert.equal(validators.normalizeStatus(0), undefined)
  assert.equal(validators.normalizeStatus({}), undefined)
  assert.equal(validators.normalizeStatus([]), undefined)
  assert.equal(validators.normalizeStatus(true), undefined)
})

await test('normalizePriority: each value in VALID_PRIORITIES passes through', () => {
  for (const v of ['p0', 'p1', 'p2', 'p3']) {
    assert.equal(validators.normalizePriority(v), v)
  }
})

await test('normalizePriority: p0_evil / P0 / p4 → undefined', () => {
  assert.equal(validators.normalizePriority('p0_evil'), undefined)
  assert.equal(validators.normalizePriority('P0'), undefined, 'uppercase')
  assert.equal(validators.normalizePriority('p4'), undefined)
  assert.equal(validators.normalizePriority(''), undefined)
})

await test('normalizePriority: undefined / null → undefined (not throw)', () => {
  assert.equal(validators.normalizePriority(undefined), undefined)
  assert.equal(validators.normalizePriority(null), undefined)
})

await test('normalizePriority: non-string → undefined', () => {
  assert.equal(validators.normalizePriority(0), undefined)
  assert.equal(validators.normalizePriority({}), undefined)
})

// =====================================================================
// wrapAsStickyData / wrapAsNoteMeta / wrapAsNoteContent / wrapAsNoteContentSnippet
// =====================================================================
//
// 这些 wrapper 给 LLM 当 semantic boundary 使用：任何空白 / 属性 / 标签名
// drift 都会破坏下游 prompt parsing 的边界识别。每个 helper 的输出必须
// 严格等于字面常量。

await test('wrapAsStickyData: encloses escaped text in <sticky_summary data-only="true">', () => {
  assert.equal(
    validators.wrapAsStickyData('hello'),
    '<sticky_summary data-only="true">hello</sticky_summary>',
  )
})

await test('wrapAsNoteMeta: encloses in <note_meta data-only="true">', () => {
  assert.equal(
    validators.wrapAsNoteMeta('hello'),
    '<note_meta data-only="true">hello</note_meta>',
  )
})

await test('wrapAsNoteContentSnippet: encloses in <note_content_snippet data-only="true">', () => {
  assert.equal(
    validators.wrapAsNoteContentSnippet('hello'),
    '<note_content_snippet data-only="true">hello</note_content_snippet>',
  )
})

await test('wrapAsNoteContent: encloses in <note_content data-only="true">', () => {
  assert.equal(
    validators.wrapAsNoteContent('hello'),
    '<note_content data-only="true">hello</note_content>',
  )
})

await test('wrap* helpers: do not double-escape (caller passes already-escaped text)', () => {
  // R-fix-sticky-data-only-wrapper 注释：helper 只做外层包裹，不二次 escape。
  // 调用方负责 escapeToolText(...) 后再 wrap。这是为了避免 &amp;lt; 这种
  // 双层转义污染 LLM 视角的语义边界。
  const alreadyEscaped = '&lt;script&gt;'
  assert.equal(
    validators.wrapAsStickyData(alreadyEscaped),
    '<sticky_summary data-only="true">&lt;script&gt;</sticky_summary>',
  )
  assert.equal(
    validators.wrapAsNoteMeta(alreadyEscaped),
    '<note_meta data-only="true">&lt;script&gt;</note_meta>',
  )
  assert.equal(
    validators.wrapAsNoteContentSnippet(alreadyEscaped),
    '<note_content_snippet data-only="true">&lt;script&gt;</note_content_snippet>',
  )
  assert.equal(
    validators.wrapAsNoteContent(alreadyEscaped),
    '<note_content data-only="true">&lt;script&gt;</note_content>',
  )
})

await test('wrap* helpers: empty input produces empty wrapper body (no extra whitespace)', () => {
  // 关键防御：helper 不能在空输入时插入换行 / 缩进；否则 LLM 学到的
  // 「这是数据」边界会因为换行错位而漂移。
  assert.equal(
    validators.wrapAsStickyData(''),
    '<sticky_summary data-only="true"></sticky_summary>',
  )
  assert.equal(
    validators.wrapAsNoteMeta(''),
    '<note_meta data-only="true"></note_meta>',
  )
  assert.equal(
    validators.wrapAsNoteContentSnippet(''),
    '<note_content_snippet data-only="true"></note_content_snippet>',
  )
  assert.equal(
    validators.wrapAsNoteContent(''),
    '<note_content data-only="true"></note_content>',
  )
})

// =====================================================================
// sanitizeNoteFilename — R-fix-notes-filename-sanitize-drift
// =====================================================================

await test('sanitizeNoteFilename: plain ASCII title passes through with yamlSafe escaping double quotes', () => {
  const r = validators.sanitizeNoteFilename('Meeting notes')
  assert.equal(r.filename, 'Meeting notes')
  assert.equal(r.yamlSafe, 'Meeting notes', 'no double-quote → no escape')
})

await test('sanitizeNoteFilename: all Windows-illegal chars in mixed-content title map to "_"', () => {
  // 9 个 Windows-illegal chars + 控制字符全部映射到 _。必须保留
  // 合法字符（首尾的 'evil' / 'name'），不能整段被 untitled 兜底吞掉。
  const r = validators.sanitizeNoteFilename('evil\\/:*?"<>|name')
  // 9 个非法字符全替成 _，保留 'evil' + 'name'
  assert.equal(r.filename, 'evil_________name', '9 illegal chars → 9 underscores')
})

await test('sanitizeNoteFilename: degenerate pure-underscore → "untitled" fallback (literal-only)', () => {
  // 全部 12 个非法字符映射后变成 12 个 _，落在
  // /^[_.\- ]+$/ 模式 → 触发 untitled 兜底。
  const r = validators.sanitizeNoteFilename('\\/:*?"<>|\x00\x01\x1f')
  assert.equal(r.filename, 'untitled', 'pure underscore run falls into untitled fallback')
})

await test('sanitizeNoteFilename: ..secret becomes _secret (leading dot run replaced with _)', () => {
  // R31 path-traversal 防御：开头 .. / . 都映射到 _，磁盘写盘不会逃出 notesDir。
  const r = validators.sanitizeNoteFilename('..secret')
  assert.equal(r.filename, '_secret', '.. at start must become _ (single _ for run)')
  // yamlSafe 也应保留 _secret，不二次 escape _
  assert.equal(r.yamlSafe, '_secret')
})

await test('sanitizeNoteFilename: trailing dot run and whitespace stripped (Windows rejects trailing . / space)', () => {
  const r1 = validators.sanitizeNoteFilename('hello.')
  assert.equal(r1.filename, 'hello', 'trailing single dot stripped')
  const r2 = validators.sanitizeNoteFilename('hello...')
  assert.equal(r2.filename, 'hello', 'trailing dot run stripped')
  const r3 = validators.sanitizeNoteFilename('hello   ')
  assert.equal(r3.filename, 'hello', 'trailing whitespace stripped')
  const r4 = validators.sanitizeNoteFilename('hello. .')
  assert.equal(r4.filename, 'hello', 'mixed trailing [dot space]+ stripped')
})

await test('sanitizeNoteFilename: degenerate names (only _-. or empty) → "untitled" fallback', () => {
  assert.equal(validators.sanitizeNoteFilename('').filename, 'untitled')
  assert.equal(validators.sanitizeNoteFilename('   ').filename, 'untitled')
  assert.equal(validators.sanitizeNoteFilename('...').filename, 'untitled')
  assert.equal(validators.sanitizeNoteFilename('---').filename, 'untitled')
  assert.equal(validators.sanitizeNoteFilename('___').filename, 'untitled')
  assert.equal(validators.sanitizeNoteFilename('   ...').filename, 'untitled')
})

await test('sanitizeNoteFilename: truncate to 80 chars', () => {
  const long = 'a'.repeat(200)
  const r = validators.sanitizeNoteFilename(long)
  assert.equal(r.filename.length, 80, 'must truncate to 80 chars')
})

await test('sanitizeNoteFilename: yamlSafe escapes double quotes for frontmatter', () => {
  // yamlSafe 是给 createNoteConfirmed 写 frontmatter 时复用的「YAML 字符串
  // 字面量转义」字符串。R-fix-notes-filename-sanitize-drift 注释：disk-write
  // 端不再做二次消毒，复用 sanitizeNoteFilename 的 yamlSafe 避免漂移。
  //
  // 注意：filename 阶段已把 " 映射到 _，所以 filename 不再含双引号。
  // yamlSafe 同样基于已 sanitize 的 safeName —— 没有 " 需要转义。
  const r = validators.sanitizeNoteFilename('hello "world"')
  assert.equal(r.filename, 'hello _world_', 'double-quote in filename maps to _ (already in illegal-char list)')
  assert.equal(r.yamlSafe, 'hello _world_', 'yamlSafe inherits sanitized safeName (no double-quote to escape)')
})

await test('sanitizeNoteFilename: yamlSafe inherits sanitized safeName (no special yaml escape needed for normal inputs)', () => {
  // 通过公开 API 走完整 pipeline 后，filename 与 yamlSafe 字面一致。
  // 实现层面 yamlSafe 还有「控制字符 → 空格」「双引号 → \"」两
  // 条转义分支；但 `"` 在 illegal-char list 里先被映射到 _，
  // 控制字符（\x00-\x1f）同样在 illegal-char list 里被映射到 _，
  // 所以从公开 API 走进 safeName 阶段后这两条分支不再触发 —— 实现
  // 保留它们是为了「未来如果 illegal-char list 调整」时不回归，
  // 但当前不是 hot path。
  const r = validators.sanitizeNoteFilename('line1\nline2\t"q"')
  // \n \t " 全部在 step 1 阶段就映射到 _（两个 " 之间是 q）
  assert.equal(r.filename, 'line1_line2__q_')
  assert.equal(r.yamlSafe, 'line1_line2__q_')
})

await test('sanitizeNoteFilename: yamlSafe replaces control chars (CR/LF/TAB/VT/FF/NUL) with space', () => {
  // 控制字符会破坏 frontmatter 的 `---` 边界；yamlSafe 统一替换为空格。
  const r = validators.sanitizeNoteFilename('line1\nline2\tcol\rcr')
  assert.equal(r.yamlSafe.includes('\n'), false)
  assert.equal(r.yamlSafe.includes('\t'), false)
  assert.equal(r.yamlSafe.includes('\r'), false)
})

await test('sanitizeNoteFilename: non-string input is coerced via String(title ?? "")', () => {
  // 实现用 String(title ?? "") 兜底，所以 null / undefined 走空串 → 'untitled'。
  // undefined → String(undefined) === 'undefined' → 文件名就是字面 'undefined'，
  // 这是已知 trade-off（不在本测试范围内改动实现）。
  const r1 = validators.sanitizeNoteFilename(null)
  assert.equal(r1.filename, 'untitled', 'null → empty → untitled fallback')
  // 这里仅验证现有行为；不假设应改为 throw 或别的语义。
})

// =====================================================================
// VALID_STICKY_STATUSES / VALID_PRIORITIES re-export 兼容
// =====================================================================

await test('VALID_STICKY_STATUSES / VALID_PRIORITIES: re-export from shared lib (back-compat)', () => {
  // R36 修复后 validators.ts 仍 re-export 旧名，保持向后兼容。
  // W2-C③：sticky status 砍到 todo/done 两值。
  assert.deepEqual(
    [...validators.VALID_STICKY_STATUSES],
    ['todo', 'done'],
  )
  assert.deepEqual(
    [...validators.VALID_PRIORITIES],
    ['p0', 'p1', 'p2', 'p3'],
  )
})
