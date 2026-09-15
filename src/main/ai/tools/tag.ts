/**
 * AI 工具层 — tag 域工具定义
 *
 * 包含 5 个 RunnableTool：
 *   - addTag              创建 / 幂等命中标签（按 name + parent 作用域）
 *   - listTags            列出全部已注册标签（树状 / 扁平，仅供查询，无副作用）
 *   - applyTagToNote      把已有标签贴到笔记（按文件名前缀匹配）
 *   - applyTagToSticky    把已有标签贴到便签
 *   - removeTagFromSticky 从便签摘掉已有标签（幂等）
 *
 * 历史来源：从 src/main/ai/tools/registry.ts 抽离。
 *
 * 共用 helper：escapeToolText / 三个 tag 工具的 execute 都走
 * bridge/sanitize.sanitizeAndStringifyBridgeResult 共享统一 escape 语义，
 * 避免 addTag 与 apply 类 / remove 类各自独立 escape 时漂移。
 */
import type { RunnableTool } from './registry'
import { tagsRepo } from '../../db/repositories/tags'
import { UUID_SCHEMA_PATTERN } from '@shared/lib/uuid'
import { escapeToolText, unescapeToolText } from './validators'

/** ============================================================
 *  addTag - 创建标签
 *  ============================================================ */
const addTagTool: RunnableTool = {
  name: 'addTag',
  description:
    '创建一个标签，可选指定父标签（parentName）和颜色。' +
    '注意：parentName 必须是已存在的标签名，找不到时返回 ok:false，不会自动 fallback 到根作用域。' +
    '若需新建嵌套结构，先 addTag(name="父标签")，再 addTag(name="子标签", parentName="父标签")。',
  // R-fix-addTag-missing-risk (HIGH ai-quality)：addTag 会向 DB INSERT 一行
  // tags —— 但 tool definition 此前漏标 risk / oneShot，stream.ts:554 读不到
  // risk 时回退 'none' → awaitToolConfirmation 不会触发 → LLM 一次调用直接
  // 写入 DB。其它 3 个 tag 工具都正确标注 risk: 'side-effect', oneShot: true。
  // 标签是树状命名空间，被 prompt-injection 驱动批量造垃圾节点的攻击面比
  // 单条便签更隐蔽，副作用等级必须对齐同域。
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description:
          '标签名；会自动 trim 前后空白，空字符串返回 ok:false。' +
          '长度上限 80 字符（UI 渲染时显示完整名称，超长会被前端截断/溢出）。' +
          '若与已存在标签同名（同 parentId 作用域下）则返回 existed:true 而不新建 ——' +
          '这是幂等保证，不是错误。建议避免特殊控制字符与 emoji（标签名会出现在 ' +
          'UI 标题、便签贴标签弹窗、tag bridge 报错信息里）。',
      },
      parentName: { type: 'string', description: '父标签的名称' },
      color: { type: 'string', description: 'HEX 颜色，例如 #58a6ff' },
    },
    required: ['name'],
  },
  async execute(args) {
    // R-fix-tooltext-roundtrip (HIGH ai-quality)：listTags 在 name 上做了
    // escapeToolText，LLM 回流给本工具时拿到的是 escape 后字符串（如
    // "Work &amp; Fun"），而 DB 字面存的是 "Work & Fun"。在入口 unescape
    // 一次，保证 dedupe 命中与 DB 字面一致；不 unescape 时 LLM 会把
    // "Work &amp; Fun" 当全新名字 INSERT，导致同一概念出现两行。
    const name = unescapeToolText(String(args['name'] ?? '').trim())
    const color = (args['color'] as string | undefined) ?? null
    if (!name) return JSON.stringify({ ok: false, error: 'name 不能为空' })

    let parentId: string | null = null
    if (args['parentName']) {
      // R16 修复 (high)：parent 也按 (name, null) 作用域查 —— 父 tag 本身也是
      // 命名空间根下的节点（嵌套通过 parentName 链串起来）。
      // 同 R-fix-tooltext-roundtrip：parentName 同样来自 LLM，可能携带 escape。
      const parentName = unescapeToolText(String(args['parentName']).trim())
      if (parentName) {
        const p = await tagsRepo.findByNameInScope(parentName, null)
        if (!p) {
          // 修复 (ai-quality / medium)：LLM 显式传 parentName 但父标签找不到时
          // 不能默默 fallback 到根作用域 —— 标签树会被污染（嵌套意图丢失，
          // 用户/调用方无从感知）。直接报错并提示先建父标签。
          return JSON.stringify({
            ok: false,
            error: `parentName "${parentName}" 未找到。请先用 addTag(name="${parentName}") 创建父标签，再创建子标签。`,
          })
        }
        parentId = p.id
      }
    }

    // R16 修复 (high)：原 findByName 仅按 name 查，迁移 008 后不同 parent 下同名 tag
    // 可以共存，导致"我要在 project-1 下新建 work 但命中已有 root 的 work"这类歧义。
    // 改用 findByNameInScope，按 (name, parentId) 复合作用域查。
    const existing = await tagsRepo.findByNameInScope(name, parentId)
    if (existing) return JSON.stringify({ ok: true, tagId: existing.id, existed: true })

    const tag = await tagsRepo.create({ name, parentId, color, order: 0 })
    return JSON.stringify({ ok: true, tagId: tag.id })
  },
}

/** ============================================================
 *  listTags - 列出全部已注册标签（树状 + 扁平）
 *
 *  R-listTags-discovery 修复 (MEDIUM ai-quality)：此前 4 个 tag 工具
 *  （addTag / applyTagToNote / applyTagToSticky / removeTagFromSticky）
 *  都要求「标签必须已存在」或「按名称精确命中」，但工具链里没有
 *  任何 read-only 通道把当前 tag 树 dump 给 LLM。失败场景：用户问
 *  「我有哪些标签？把 work 子树下的便签列一下」→ LLM 拿不到完整
 *  列表只能瞎猜；用户说「把这条便签上的 project-1 改成 project-2」
 *  → LLM 不知道目标标签是否存在。listTags 把整棵树以扁平数组
 *  （含 parentId）形式回灌，LLM 可在调用前 / 之后引用 id 与 name。
 *  ============================================================ */
const listTagsTool: RunnableTool = {
  name: 'listTags',
  description:
    // R-fix-listTags-tree-promise (HIGH ai-quality)：原 description 第一句写
    // 「树状结构 + 扁平数组」，但 execute 只回扁平 tags[]（含 parentId），
    // 从未产出 children / descendants 等嵌套字段。LLM 据 description 找嵌套
    // 树找不到只能基于 parentId 自助重构——description 与 schema 漂移。
    // 修法 (a)：删掉「树状结构」承诺，只承诺扁平数组形态，与 searchStickies /
    // getPomodoroState 等 sibling read-only 工具「description 列全字段」风格
    // 对齐。
    '列出所有已注册的标签（扁平数组）。返回字段：tags: Array<{ id, name, parentId, color, order }> ' +
    '—— 扁平数组而非深嵌套树，方便 LLM 在思考时按 parentId 自助重构嵌套；parentId === null 表示根级标签。' +
    '**用于**：在调用 addTag 之前确认同名标签是否已存在（避免产生重复节点）；' +
    '在调用 applyTagToNote / applyTagToSticky / removeTagFromSticky 之前确认目标标签名是否精确命中。' +
    '**只读无副作用**。**数据量较大时建议在回复里只引用必要子树**——完整 dump 可能很长。',
  risk: 'none',
  oneShot: false,
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const rows = await tagsRepo.findAllTree()
    // R30-Sec-1 / R32-02 风格：tag name 是用户写入字符串，同样做 5-char
    // HTML escape 防御 prompt injection（虽然 tag 树被注入的攻击面比便签
    // 标题小，但保持防御一致性）。
    return JSON.stringify({
      ok: true,
      count: rows.length,
      tags: rows.map((t) => ({
        id: t.id,
        name: escapeToolText(t.name),
        parentId: t.parentId,
        color: t.color,
        order: t.order,
      })),
    })
  },
}

/** ============================================================
 *  applyTagToNote - 给笔记贴已有标签
 *  ============================================================ */
const applyTagToNoteTool: RunnableTool = {
  name: 'applyTagToNote',
  description:
    '把已有标签按名称贴到指定笔记（按文件名前缀匹配笔记）。' +
    '标签必须已经存在；不存在时返回 ok:false（需要新建请改用 addTag）。' +
    // R-fix-applyTag-root-scope-only：tagsRepo.findByNameInScope(tagName, null)
    // 把 parentId 硬编码为 null —— 嵌套作用域下的标签（用 addTag(name="x",
    // parentName="y") 创建的）不会被命中，工具返回 "tag not found"。LLM
    // 据此容易误以为工具链整体不支持嵌套作用域，实际只是查找路径被锁死
    // 在根作用域。明示限制让 LLM 知道：要给便签贴嵌套标签的根名（如
    // "work"）得先 addTag(name="work")（root），再 addTag(name="project-1",
    // parentName="work") 嵌一层；如果只想贴根名同名标签，调 addTag / listTags
    // 确认根作用域下存在同名标签即可。Option (b) 改用 tagId 可关闭功能差距，
    // 但需要桥接层一并改 schema —— 当前轮仅补文档。
    '**作用域限制**：本工具仅匹配根作用域（parentId=null）下的标签。' +
    '嵌套作用域下的标签（即通过 addTag(name="x", parentName="y") 创建的）' +
    '**无法用本工具命中**，会返回 ok:false + "tag not found"。' +
    '如要贴的标签仅存在于某个 parentName 下，请先用 addTag 在根作用域下建一个同名标签，' +
    '或者改用 listTags 取 id 后再走桥接调用（当前 schema 未暴露 tagId 参数）。',
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {
      tagName: { type: 'string', description: '已存在的标签名称' },
      noteFilename: {
        type: 'string',
        // R32-AI-2 修复：原 description 只说"可只给前缀"，未告知 LLM
        // tagBridge.MIN_PREFIX_NEEDLE_LENGTH = 4 的硬约束。LLM 传 1-3 字符
        // needle 时会被 tagBridge.ts 拒绝并返回 "长度低于 4 字符" 错误，
        // 浪费多轮 round-trip。
        // R39-fix-tag-exact-length 修正：上一版把 4 字符限制说成"全局约束"，
        // 但 tagBridge.ts:101-122 实际是先做精确匹配（n.filename === lower），
        // 命中就直接走精确路径不受长度限制；只有精确零命中退化为前缀匹配时，
        // 才检查 MIN_PREFIX_NEEDLE_LENGTH=4。也就是说 needle="重" 能命中
        // "重.md"，needle="周报" 能命中 "周报.md"——LLM 据 schema 描述却以为
        // 必拒，被迫把 needle 拼长引入歧义。现描述区分两条路径并补大小写说明。
        description:
          '笔记文件名（**前缀匹配 needle 必须 ≥ 4 字符**——短 needle 极易命中多篇；' +
          '**完全等于文件名的精确匹配不受长度限制**，例如 needle="重" 能命中 "重.md"，' +
          'needle="todo" 能命中 "todo.md"，needle="周报" 能命中 "周报.md"。' +
          '**匹配大小写不敏感**）。' +
          '例：needle="meeting" 匹配 "meeting-2026-01-15.md"（前缀）；' +
          'needle="周"（1 字符）若没有 "周.md" 则被拒，需给更完整前缀如 "周报-2026-W36"。',
      },
    },
    required: ['tagName', 'noteFilename'],
  },
  async execute(args) {
    const { applyTagToNote } = await import('../tagBridge')
    // R32-Corr-2：字段透传 + escape 走共享 sanitizeAndStringifyBridgeResult，
    // 新增 escape 字段（如 tagId）只需在 bridge/sanitize.ts 白名单加一项，
    // 三个 tag 工具自动跟随，无需逐工具改 execute。
    const { sanitizeAndStringifyBridgeResult } = await import('../bridge/sanitize')
    const res = await applyTagToNote(
      String(args['tagName'] ?? ''),
      String(args['noteFilename'] ?? ''),
    )
    return sanitizeAndStringifyBridgeResult(res)
  },
}

/** ============================================================
 *  applyTagToSticky - 给便签贴已有标签
 *  ============================================================ */
const applyTagToStickyTool: RunnableTool = {
  name: 'applyTagToSticky',
  description:
    '把已有标签贴到指定便签。标签必须已经存在；不存在时返回 ok:false（需要新建请改用 addTag）。' +
    // R-fix-applyTag-root-scope-only：与 applyTagToNote 同因 —— resolveTag
    // 走 findByNameInScope(tagName, null)，把查找范围锁死根作用域。LLM 在
    // 用户贴 "urgent"（实际挂在 work/project-1 下）时收 "tag not found"，
    // 不得不靠失败 round-trip 摸索到「需要 root 同名标签」这条规则。直接
    // 在 description 里把限制写明，省去多轮试错。
    '**作用域限制**：本工具仅匹配根作用域（parentId=null）下的标签。' +
    '嵌套作用域下的标签（即通过 addTag(name="x", parentName="y") 创建的）' +
    '**无法用本工具命中**，会返回 ok:false + "tag not found"。' +
    '如要贴的标签仅存在于某个 parentName 下，请先用 addTag 在根作用域下建一个同名标签，' +
    '或者改用 listTags 取 id 后再走桥接调用（当前 schema 未暴露 tagId 参数）。',
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {
      tagName: { type: 'string', description: '已存在的标签名称' },
      stickyNoteId: {
        type: 'string',
        minLength: 32,
        // R43-fix-sticky-id-permissive-schema (MEDIUM)：与 sibling
        // sticky.ts updateSticky.id / completeSticky.id /
        // batchUpdateStickies.ids.items / pomodoro.ts:focusStickyId 对齐
        // —— description 承诺 UUID，schema 只声明 minLength:32 不能挡 LLM
        // 凭印象拼的非 UUID 串。补 pattern 收口为标准 UUID，让 schema 校验
        // 阶段直接拒掉拼写错误的 ID。
        // R-fix-uuid-schema-dedup：复用 @shared/lib/uuid.UUID_SCHEMA_PATTERN
        // 与 6 处其它 sticky-id schema 共享同一权威源，避免规则微调时漂移。
        pattern: UUID_SCHEMA_PATTERN,
        description:
          '便签 ID（UUID 格式，36 字符）；调用前请先用 searchStickies 取 id 字段，' +
          '**不要凭印象拼写**（如 "first"、"sticky-123" 等会被 schema 校验阶段直接拒掉）。',
      },
    },
    required: ['tagName', 'stickyNoteId'],
  },
  async execute(args) {
    const { applyTagToSticky } = await import('../tagBridge')
    // R32-Corr-2：共享 sanitize helper
    const { sanitizeAndStringifyBridgeResult } = await import('../bridge/sanitize')
    const res = await applyTagToSticky(
      String(args['tagName'] ?? ''),
      String(args['stickyNoteId'] ?? ''),
    )
    return sanitizeAndStringifyBridgeResult(res)
  },
}

/** ============================================================
 *  removeTagFromSticky - 从便签摘掉已有标签
 *
 *  R-remove-tag-tool 修复：searchStickies 描述里曾引用这个工具但实现缺失，
 *  LLM 跟描述调用会拿到 "未知工具"。现在补上真正的实现 + 注册。
 *  ============================================================ */
const removeTagFromStickyTool: RunnableTool = {
  name: 'removeTagFromSticky',
  description:
    '按标签名把已有标签从指定便签上摘掉。标签必须已经注册；便签上没贴这个' +
    '标签时返回 ok:true + removed:false（幂等，不会让 LLM 误以为出错）。' +
    '注意：当前工具链无法回读便签上已有哪些标签——调用前请确认该便签确实贴了这个标签。' +
    // R-fix-removeTag-root-scope-only (LOW schema-description-mismatch)：
    // 与 applyTagToNote / applyTagToSticky 同源 —— tagBridge.ts:102-107
    // resolveTag 走 `tagsRepo.findByNameInScope(name, null)`，parentId
    // 硬编码为 null，三个工具（applyTagToNote / applyTagToSticky /
    // removeTagFromSticky）的 tagName 入参都只能命中根作用域标签。LLM
    // 据「标签必须已注册」推测传任意已存在标签名，但 (name, work_id)
    // 不会被命中 → "tag not found"，误以为工具链整体不支持嵌套标签。
    // 与 applyTagToNote / applyTagToSticky 的描述完全对齐告知根作用域限制。
    '**作用域限制**：本工具仅匹配根作用域（parentId=null）下的标签。' +
    '嵌套作用域下的标签（即通过 addTag(name="x", parentName="y") 创建的）' +
    '**无法用本工具命中**，会返回 ok:false + "tag not found"。' +
    '如要摘的标签仅存在于某个 parentName 下，请先用 addTag 在根作用域下建一个同名标签，' +
    '或者改用 listTags 取 id 后再走桥接调用（当前 schema 未暴露 tagId 参数）。',
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {
      tagName: { type: 'string', description: '要摘掉的已注册标签名称' },
      stickyNoteId: {
        type: 'string',
        minLength: 32,
        // R43-fix-sticky-id-permissive-schema (MEDIUM)：与 applyTagToSticky.
        // stickyNoteId 同根问题 —— description 承诺 UUID，schema 只声明
        // minLength:32 不能挡 LLM 凭印象拼的非 UUID 串。补 pattern 收口。
        // R-fix-uuid-schema-dedup：复用 @shared/lib/uuid.UUID_SCHEMA_PATTERN
        // 与 6 处其它 sticky-id schema 共享同一权威源，避免规则微调时漂移。
        pattern: UUID_SCHEMA_PATTERN,
        description:
          '便签 ID（UUID 格式，36 字符）；调用前请先用 searchStickies 取 id 字段，' +
          '**不要凭印象拼写**（如 "first"、"sticky-123" 等会被 schema 校验阶段直接拒掉）。',
      },
    },
    required: ['tagName', 'stickyNoteId'],
  },
  async execute(args) {
    const { removeTagFromSticky } = await import('../tagBridge')
    // R32-Corr-2：共享 sanitize helper
    const { sanitizeAndStringifyBridgeResult } = await import('../bridge/sanitize')
    const res = await removeTagFromSticky(
      String(args['tagName'] ?? ''),
      String(args['stickyNoteId'] ?? ''),
    )
    return sanitizeAndStringifyBridgeResult(res)
  },
}

// R39-fix-tag-dead-reexport (low structure)：删除 `export { escapeToolText }`
// —— 历史 R32 拆分时留下的临时桥接，整仓 grep 后无任何模块从 tools/tag.ts
// 直接 import escapeToolText。sticky.ts / note.ts / context.ts / sanitize.ts
// 全部直接 `from './validators'`，registry.ts 也完全不依赖这条 re-export。
// 让 tag 域 public surface 与 sticky/note 域对齐，不留假暴露。

/** tag 域工具数组（registry.ts ALL_TOOLS 拼接用） */
export const TAG_TOOLS: RunnableTool[] = [
  addTagTool,
  listTagsTool,
  applyTagToNoteTool,
  applyTagToStickyTool,
  removeTagFromStickyTool,
]