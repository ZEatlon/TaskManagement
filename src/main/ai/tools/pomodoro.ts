/**
 * AI 工具层 — pomodoro / nav / stats 域工具定义
 *
 * 包含 6 个 RunnableTool：
 *   - startPomodoro      启动番茄钟（可绑定便签 / 自定义时长）
 *   - stopPomodoro       停止番茄钟
 *   - pausePomodoro      暂停 / 恢复番茄钟（toggle）
 *   - getPomodoroState   读取番茄钟实时状态（只读）
 *   - navigate           切换应用路由（白名单）
 *   - getPomodoroStats   番茄钟统计（今日 / 本周 / streak / 最佳时段）
 *
 * 历史来源：从 src/main/ai/tools/registry.ts 抽离。
 *
 * 设计：把 navigate / getPomodoroStats 与 4 个 pomodoro 工具放到同一个
 * domain 文件 —— 它们都通过 ai/*Bridge.ts（pomodoroBridge / navigateBridge）
 * 间接写 IPC，副作用链路相似；review 时一眼看全「时间 / 路由 / 统计」
 * 三类工具，比单文件 18 个混在一起更易维护。
 *
 * 共用：ALLOWED_ROUTES 静态 import 自 ../navigateBridge（schema enum 阶
 * 段与运行时白名单共用单一权威源，避免循环 import 时未就绪）。
 */
import type { RunnableTool } from './registry'
import { UUID_SCHEMA_PATTERN } from '@shared/lib/uuid'
import { DAY_KEY_SCHEMA_PATTERN } from '@shared/lib/dayKey'
import { ALLOWED_ROUTES } from '../navigateBridge'

/** ============================================================
 *  startPomodoro - 启动番茄钟
 *  ============================================================ */
const startPomodoroTool: RunnableTool = {
  name: 'startPomodoro',
  description:
    '启动番茄钟；可绑定到指定便签，绑定后完成自动勾选该便签。可选 minutes 自定义时长（默认 25，必须 1-180，越界值会在 schema 校验阶段直接被拒）。⚠ 注意：传 minutes 会同时把默认专注时长**持久化**改成这个值，不会跑完自动恢复 —— 之后所有未指定 minutes 的番茄钟都会沿用新值；如只想本次生效、保留旧默认，**不要**用工具链改回去（LLM 工具集不暴露 focusMin 写入通道），请在回复里明确告诉用户去「设置 → 番茄钟」把默认专注时长手动改回原值。\n' +
    '**返回字段（ok=true 时）**：\n' +
    '  - ok: true\n' +
    '  - kind: "start"\n' +
    '  - state：与 getPomodoroState 返回结构相同（mode / running / remainingSec / totalSec / elapsedSec / cycleIndex / stickyNoteId / startedAt 共 8 字段）\n' +
    '  - stickyNoteId: string | null（绑定的便签 ID；未传为 null）\n' +
    '  - focusMinChanged: boolean（**仅当本次传了 minutes 且实际生效**才为 true；旧默认专注时长与新值不同时为 true，相同时仍为 false —— LLM 据此判断「默认专注时长是否真的被改了」）\n' +
    '  - focusMin: number（**当前默认专注时长**分钟；用户问「改成多少了 / 现在默认多久」时直接读这个字段）\n' +
    '回答"默认专注时长改了吗 / 改成多少了 / 跑的是几分钟"这类问题请以返回字段为准；ok=false 时不携带 focusMinChanged / focusMin，请在回复里如实告诉用户启动失败原因（不要拿 focusMinChanged=false 误归类为「值未变」）。',
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {
      stickyNoteId: {
        type: 'string',
        minLength: 32,
        // R44-fix-startPomodoro-sticky-id-permissive-schema (MEDIUM ai-quality)：
        // 与 6 处 sibling sticky-id schema（updateSticky.id / completeSticky.id /
        // batchUpdateStickies.ids.items / applyTagToSticky.stickyNoteId /
        // removeTagFromSticky.stickyNoteId / navigate.focusStickyId）在 R43 同一
        // 批次对齐时漏掉本字段。原 schema 只声明 minLength 缺失，LLM 拼出 32+ 字
        // 符非 UUID 串（"this-is-a-fake-sticky-note-id"）能混过 schema 校验 →
        // pomodoroBridge.applyStart → stickyNotesRepo.findById → null → 返回
        // {ok:false, error:'便签不存在，无法绑定番茄钟', kind:'start'}。补 pattern
        // 收口为标准 UUID，与 sibling 严格一致，避免浪费 round-trip。
        // pattern 复用 @shared/lib/uuid.UUID_SCHEMA_PATTERN 字面量，与 R40~R43
        // 修复节奏保持单一权威源。
        pattern: UUID_SCHEMA_PATTERN,
        description:
          '便签 ID（UUID 格式，36 字符）；调用前请先用 searchStickies 取 id 字段，' +
          '**不要凭印象拼写**（如 "first"、"sticky-123" 等会被 schema 校验阶段直接拒掉）。',
      },
      minutes: {
        type: 'number',
        // R35 修复 (MEDIUM startPomodoro-minutes-schema-unbounded)：原 schema
        // 只在 description 里写"1-180"，没有 minimum/maximum，LLM 传 9999 会被
        // schema 接受、bridge 静默 clamp 到 180 并把 180 回填给 LLM，LLM 据此
        // 在回复里告诉用户"已按 9999 分钟设置"——与实际不符并悄悄持久化到配置。
        // 加 minimum/maximum 后 schema 校验阶段就拒掉越界值，避免 round-trip 浪费
        // 与回复/现实错位。
        // R32-Corr-3：min/max 由 channels.ts 的 POMODORO_FOCUS_MIN_LIMITS 提供
        // 单一权威源（schema + bridge clamp 共享），这里直接复用同一对数值。
        minimum: 1,
        maximum: 180,
        description:
          '自定义专注时长（分钟，必须 1-180；越界值会在 schema 校验阶段被拒）。⚠ 这个值会持久修改全局默认专注时长，不会跑完自动恢复。',
      },
    },
  },
  async execute(args) {
    // R32-Corr-2：走 canonical 命名 applyPomodoroAction({ action: 'start', ... })
    const { applyPomodoroAction } = await import('../pomodoroBridge')
    const stickyNoteId =
      typeof args['stickyNoteId'] === 'string' ? args['stickyNoteId'] : null
    const minutes =
      typeof args['minutes'] === 'number' && Number.isFinite(args['minutes'])
        ? args['minutes']
        : null
    return JSON.stringify(
      await applyPomodoroAction({ action: 'start', stickyNoteId, minutes }),
    )
  },
}

/** ============================================================
 *  stopPomodoro - 停止番茄钟
 *  ============================================================ */
const stopPomodoroTool: RunnableTool = {
  name: 'stopPomodoro',
  // R-fix-stopPomodoro-force-clarification：原描述「force=true 时不弹确认直接停」
  // 与实际权限模型冲突——本工具 risk='side-effect'，stream.ts 会对所有 risk !== 'none'
  // 的工具走 awaitToolConfirmation（流级确认弹窗，由 IPC ai:confirm-tool 通道回执），
  // 与 force 无关。force 只透传到 pomodoroBridge.stop 的 returned.forced 字段，
  // 渲染端据此决定是否跳过自身的「确定要放弃本次专注吗」二级确认。
  // R-fix-stopPomodoro-success-schema-missing (MEDIUM ai-quality)：原描述只文档化
  // 了 ok:false 失败分支，ok:true 成功分支的 kind/state/forced 字段完全没列；LLM 据
  // 描述只知「失败时 kind 是 'stop'」，不知成功时 kind 也叫 'stop'（同名易混），不知
  // 有 state 字段可读剩余时间，不知 forced 字段怎么用来回显「本轮是否跳过二次确认」。
  // 在末尾补一段「ok=true 时返回」与 sibling startPomodoro / getPomodoroState 风格对齐。
  description:
    '停止当前番茄钟。force=true 表示用户在自然语言里已经明确说过「直接停，别再问我」，' +
    '用于跳过渲染端「确定要放弃本次专注吗」的二级确认；**流级确认（risk=side-effect ' +
    '触发的那次）仍按正常流程执行，不会被 force 跳过**——也就是说 force=true 也仍然' +
    '会被用户看到一次流级确认弹窗，区别只是用户点同意后渲染端不再弹二次确认。\n' +
    '**无进行中的番茄钟时返回 ok:false + error=\'当前没有进行中的番茄钟\' + kind:\'stop\'** ' +
    '（pomodoroBridge.applyStop 在 !running && elapsedSec===0 时直接 fail，' +
    'force=true 也救不了 —— 没有运行的番茄钟不会因为 force 而被「停掉」）。' +
    '请在回复里如实告诉用户「当前没有番茄钟」，不要据 force=true 推断已停止，' +
    '也不要接着在同回合调 startPomodoro 试图「补一次启动」——用户可能根本没要启。\n' +
    '**ok=true 时返回字段**：\n' +
    '  - ok: true\n' +
    '  - kind: \'stop\'（与失败分支同名易混，**仅在 ok=true 时该字段才表示本次确实停掉了一节番茄钟**）\n' +
    '  - state：与 getPomodoroState 返回结构相同（mode / running / remainingSec / totalSec / ' +
    'elapsedSec / cycleIndex / stickyNoteId / startedAt 共 8 字段；停完后 running=false、' +
    'startedAt=null，可用于告诉用户「本次专注了多少秒 / 跑到了哪一节」）\n' +
    '  - forced: boolean（用户入参 force 的回显 —— true 表示本轮已跳过渲染端二次确认，' +
    'LLM 据此在回复里告诉用户「这次直接停了，没有再问你一次」；false 表示用户没明确跳过，' +
    '渲染端正常弹过二次确认）\n' +
    '回答「番茄钟停了吗 / 跑了多久 / 本次有没有跳过确认」等问题以 ok=true 时返回的 kind/state/forced 为准。',
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: '用户已明确表示「直接停」时传 true，渲染端会跳过二次确认',
      },
    },
  },
  async execute(args) {
    // R32-Corr-2：走 canonical 命名 applyPomodoroAction({ action: 'stop', force })
    const { applyPomodoroAction } = await import('../pomodoroBridge')
    return JSON.stringify(
      await applyPomodoroAction({ action: 'stop', force: args['force'] === true }),
    )
  },
}

/** ============================================================
 *  pausePomodoro - 暂停 / 恢复番茄钟
 *  ============================================================ */
const pausePomodoroTool: RunnableTool = {
  name: 'pausePomodoro',
  // R-fix-pausePomodoro-description-thin (HIGH ai-quality)：原描述只有
  // "暂停 / 恢复番茄钟（toggle）。" 12 个字符，LLM 完全感知不到两个关键事实：
  //   1) 没有进行中或已暂停的番茄钟时本工具返回 ok:false + error='当前没有进行中
  //      或已暂停的番茄钟'（pomodoroBridge.applyTogglePause 失败分支，第 284-288 行），
  //      不是「停了一个已暂停的番茄钟」这种静默成功 —— 不告诉用户失败原因就会让 LLM
  //      在回复里误称「已暂停」；
  //   2) 成功时返回 kind: 'paused' | 'resumed' 字段，是 toggle 行为下唯一能让
  //      LLM 区分「本次到底是按了暂停还是恢复」的依据，必须让 LLM 拿到。
  // 显式把这两个契约写进 description，让 LLM 在不读源码的情况下也能正确处置。
  // R32-Corr-2 修复后响应字段从老的 action 重命名为 kind（避免与入参
  // action: 'pause' 同名造成概念混淆），本工具 description 此前没跟上 —
  // LLM 据工具描述在回复文本里写"系统告诉我本次 action 是 resumed"或尝试
  // `result.action === 'resumed'` 来判定分支，但 JSON 拿到的是 undefined /
  // kind 是 'resumed' → 在 fallback 分支给出与实际相反的描述（暂停说成恢复、
  // 或反之），触发用户误导。改成 kind。
  description:
    '暂停 / 恢复番茄钟（toggle；按当前 running 自动判定 pause/resume）。' +
    '**无进行中或已暂停的番茄钟时返回 ok:false + error=\'当前没有进行中或已暂停的番茄钟\'（' +
    '此时响应里没有 kind 字段）**，请在回复里如实告诉用户「现在没有番茄钟可以暂停/恢复」，' +
    '不要把任何 kind 当作可信；成功时（ok=true）返回 kind: \'paused\' | \'resumed\' 字段，' +
    '仅在 ok=true 时该字段才表示本次实际执行的是哪个动作。',
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    // R32-Corr-2：走 canonical 命名 applyPomodoroAction({ action: 'pause' })
    const { applyPomodoroAction } = await import('../pomodoroBridge')
    return JSON.stringify(await applyPomodoroAction({ action: 'pause' }))
  },
}

/** ============================================================
 *  getPomodoroState - 番茄钟实时状态查询（只读）
 *  ============================================================ */
const getPomodoroStateTool: RunnableTool = {
  name: 'getPomodoroState',
  // R-fix-getPomodoroState-not-registered (HIGH ai-quality)：canonical
  // getPomodoroState() 在 pomodoroBridge.ts 第 294 行已 export，
  // 但 POMODORO_TOOLS 里没有注册对应 RunnableTool，LLLM 没法问
  // "我这节番茄钟还剩多久" / "现在是不是处在休息阶段"。context.ts
  // 的 buildAiContextPrompt 只注入 pomodoroRunning + pomodoroMode，
  // 不含 remainingSec / elapsedSec，缺口完全没补。
  // 注册为 risk='none' 的只读工具，schema 为空对象。
  description:
    '读取番茄钟当前状态。返回字段：\n' +
    '  - mode: "focus" | "shortBreak" | "longBreak"（当前节次类型）\n' +
    '  - running: boolean（是否正在计时）\n' +
    '  - remainingSec: number（本节剩余秒数）\n' +
    '  - totalSec: number（本节总时长秒数）\n' +
    '  - elapsedSec: number（本节已过秒数）\n' +
    '  - cycleIndex: number（当前番茄序号，从 1 开始）\n' +
    '  - stickyNoteId: string | null（绑定便签 ID；未绑为 null）\n' +
    '  - startedAt: string | null（本节起始 ISO 时间戳；空闲时 null；同时是 idle / paused 判别器 —— 见下方）\n' +
    '⚠️ **mode 没有 "idle" 值** —— 任何状态下 mode 都只能是 focus/shortBreak/longBreak 之一。' +
    '判断「番茄钟是否在跑 / 是否处于空闲」请用 running 字段（running=false 即为空闲/已暂停），' +
    '不要用 mode === "idle" 做分支 —— 该表达式永远为 false。' +
    '**判别 idle vs paused 的唯一可靠字段是 startedAt**：' +
    'startedAt === null 表示从未开始（idle 状态，不能 resume，只能 start）；' +
    'startedAt !== null 且 running=false 表示已暂停（可被 resume / stop）；' +
    'running=false 本身不能区分这两种状态 —— 用户问"番茄钟是暂停了还是没开始"时必须看 startedAt。' +
    '三者关系：totalSec = remainingSec + elapsedSec。' +
    '用于回答"还剩多久""原本设了多久""现在是什么阶段""绑的是哪张便签"等实时问题；' +
    '不修改任何状态，risk=none，可放心反复调用。',
  risk: 'none',
  oneShot: false,
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const { getPomodoroState } = await import('../pomodoroBridge')
    return JSON.stringify(getPomodoroState())
  },
}

/** ============================================================
 *  navigate - 切换应用路由
 *  ============================================================ */
const navigateTool: RunnableTool = {
  name: 'navigate',
  // R34 修复 (MEDIUM ai:navigate-description-schema-mismatch)：原描述
  // 把 `/today?date=YYYY-MM-DD` 列为 route 的可选值，但 schema.route.enum
  // 只接受 ALLOWED_ROUTES 里的 5 个简单路径，复合字符串在 schema 校验阶段
  // 直接拒，浪费 round-trip。描述与 schema 严格一致：route 只接受枚举值；
  // 日期通过独立的 `date` 字段（`/today` 时生效）传入，execute 内部再拼回
  // `?date=YYYY-MM-DD` 形式给 navigateBridge，保持 navigateTo() 契约不变。
  description:
    '切换应用路由。`route` 字段只接受枚举值之一：`/`（clock / 番茄钟首页）、' +
    '`/today`、`/notes`、`/ai`、`/settings`。**严禁**传 `/today?date=...` ' +
    '之类的复合字符串 —— schema 校验阶段会拒。若要跳到具体日期，把 `date` ' +
    '作为独立字段传入（仅在 `route="/today"` 时生效，其它 route 下被忽略）。' +
    '可选 `focusStickyId` 让跳转后高亮指定便签 2.5s；结果里 `focusApplied` 反映是否命中。',
  risk: 'side-effect',
  oneShot: true,
  parameters: {
    type: 'object',
    properties: {
      route: {
        // 修复 (ai-quality / medium)：schema enum 与运行时白名单共用
        // navigateBridge.ALLOWED_ROUTES 单一权威源（静态 import 而非动态
        // import()，避免 tools.ts 在循环 import 时未就绪）。带 ?date= 的
        // 复合形式被拆成独立可选 date 字段，schema 校验期就挡掉 `/home` /
        // `/dashboard` 之类的口语化变体，省 1 轮 tool round-trip。
        type: 'string',
        enum: ALLOWED_ROUTES,
        description:
          '目标路由；只接受枚举值之一："/"（clock / 番茄钟首页）、"/today"（带可选 date 参数）、"/notes"、"/ai"、"/settings"。其它任何字符串都会在 schema 校验阶段被拒。',
      },
      date: {
        type: 'string',
        // R-fix-daykey-dedup (MEDIUM)：复用 @shared/lib/dayKey.DAY_KEY_SCHEMA_PATTERN
        // 与 5 处其它 YYYY-MM-DD schema 共享同一权威源，避免规则微调时漂移。
        pattern: DAY_KEY_SCHEMA_PATTERN,
        description:
          '可选；当 route="/today" 时附带日期（YYYY-MM-DD）。例如 route="/today", date="2026-01-15" 跳到 1 月 15 日的今日视图。其它 route 下此字段被忽略。',
      },
      focusStickyId: {
        type: 'string',
        minLength: 32,
        // R43-fix-focus-sticky-id-permissive-schema (MEDIUM schema-description-mismatch)：
        // 原 schema 只声明 minLength:32 但 description 承诺「UUID 格式，36 字符」。
        // LLM 拼写错的 32+ 字符非 UUID 串（如 "this-is-a-fake-but-long-id-12345678"）
        // 能混过 schema 校验走到 StickyTimeline querySelector 找不到 → focusApplied=false，
        // LLM 据 description 把 false 误归类为「便签不在当前可见 ±7 天窗口」，正确诊断
        // 应该是「ID 格式非法，便签根本不存在」。补 pattern 收口为标准 UUID，与
        // description 契约严格一致，与 sticky.ts / tag.ts sibling sticky-id 字段
        // 对齐。pattern 复用 @shared/lib/uuid.UUID_SCHEMA_PATTERN 的字面量（避免循环依赖；
        // 该正则历史上就是 RFC 4122 8-4-4-4-12 hex，与 crypto.randomUUID() 兼容）。
        // R-fix-uuid-schema-dedup：6 处 schema 全部从 @shared/lib/uuid 共享单一权威源，
        // 规则微调（version/variant 校验、大小写策略、nanoid-style 替代等）一处改全栈同步。
        pattern: UUID_SCHEMA_PATTERN,
        // R-fix-focus-sticky-feedback：原描述只说"跳转后高亮"，没提持续时间、
        // 窗口限制、反馈通道。LLM 因此不知道便签若不在当前可见 ±7 天窗口
        // 时高亮会静默 no-op，也不知道结果里 focusApplied=false 是什么意思。
        // R39-fix-focus-route：补「仅在 /today 生效」的限制。StickyTimeline
        // 只在 routes/today.tsx 挂载并监听 `taskpilot:focus-sticky` 事件，
        // 其它路由(/)//notes///ai///settings)连监听器都没有，焦点查找代码
        // 根本不会跑——focusApplied 永远 false，等同静默 no-op。LLM 据
        // description 推断"便签不在窗口"是误归类，正确诊断应是"路由错误"。
        // R40-fix-focus-sticky-uuid：与 sibling sticky tools (applyTagToSticky /
        // removeTagFromSticky in tag.ts) 对齐——便签 ID 是 UUID 32+ 字符，
        // LLM 不应凭印象拼"first"/"todo"等短串，否则 schema 校验阶段就拒。
        description:
          '便签 ID（UUID 格式，36 字符）；调用前请先用 searchStickies 取 id 字段，' +
          '**不要凭印象拼写**（如 "first"、"sticky-123" 等会被 schema 校验阶段直接拒掉）。' +
          '仅在 route="/today" 时生效（其它路由 /、/notes、/ai、/settings 没有挂载便签时间线监听器，' +
          'focusApplied 永远 false，等同静默 no-op）——LLM 想要高亮便签请确保 route="/today"，' +
          '跳到其它路由不要传 focusStickyId。' +
          '跳转后尝试滚动并高亮 2.5s（仅在目标便签存在于当前可见的 ±7 天窗口时才生效）。' +
          '返回值 focusApplied 反映结果（三态）：\n' +
          '  - true = 命中（便签在窗口内且时间线已挂载）\n' +
          '  - false = 未命中（路由错误 / 窗口外 / 便签已删除 / 时间线未挂载等任意一种）\n' +
          '  - null = 未传 focusStickyId\n' +
          '示例：调 navigate({route:"/today", focusStickyId}) 后 focusApplied=false，' +
          '请如实告诉用户"已跳转到 /today 但便签不在当前可见范围，需要手动展开对应日期"——' +
          '不要声称高亮成功，也不要把 false 误判为 null。',
      },
    },
    required: ['route'],
  },
  async execute(args) {
    // R32-Corr-2：走 canonical 命名 navigateTo(route, focusStickyId?)。
    // 把 schema 阶段的 enum + 独立的 date 字段拼回 navigateBridge 接受的
    // 单一字符串形式（含 ?date=YYYY-MM-DD 后缀），保持 parseRoute 既有契约。
    const { navigateTo } = await import('../navigateBridge')
    const focus =
      typeof args['focusStickyId'] === 'string' ? args['focusStickyId'] : null
    const rawRoute = String(args['route'] ?? '')
    const date =
      typeof args['date'] === 'string' && args['date'].trim()
        ? args['date'].trim()
        : null
    const composed =
      date && rawRoute === '/today' ? `${rawRoute}?date=${date}` : rawRoute
    return JSON.stringify(await navigateTo(composed, focus))
  },
}

/** ============================================================
 *  getPomodoroStats - 番茄钟统计
 *  ============================================================ */
const getPomodoroStatsTool: RunnableTool = {
  name: 'getPomodoroStats',
  // R33-fix：原 description 只列了 5 个字段，statsBridge 实际返回 11 个；
  // LLM 不知道 byDay / withStickyCount 等可被引用 → 用户问"上周每天专注
  // 时长分布"或"绑定 vs 自由番茄比例"时只能瞎猜或编造。这里把全字段名
  // 列出，便于 LLM 在不读 tools.ts 源码的情况下也能正确引用。
  //
  // 后续字段扩展：已加入 withoutStickyCount 等，当前 description 完整列出
  // statsBridge 当前返回的全部字段（含 withStickyCount / withoutStickyCount /
  // byDay / bestHour / bestHourCount / streakDays 等）。**新增字段时请同步
  // 更新此处 description**，否则 LLM 无法引用新字段。
  description:
    // R-fix-getPomodoroStats-readonly-prefix (MEDIUM ai-quality)：原 description
    // 第一句直接写「返回番茄钟统计。」，没有「只读，不会修改任何数据」开头标识。
    // 同 domain getPomodoroState（pomodoro.ts:189-208）与 searchStickies /
    // listTags / searchNotes / listStickyTags / planDay 等所有 risk='none'
    // 工具 description 都明确写「**只读，不会修改任何数据**」——LLM 不能 grep
    // 「只读」一键判断是不是 read-only，schema 又不暴露 risk 字段，description
    // 是 LLM 唯一入口。补齐开头标识。
    //
    // R-fix-getPomodoroStats-ok-false-doc (MEDIUM ai-quality)：原 description
    // 只列 ok:true 的 12 个字段，未文档化 ok:false 分支。statsBridge.ts:281-285
    // 失败时返回 { ok:false, error }，LLM 不知道失败 shape（无 range / todayCount
    // 等字段）。与 startPomodoro / stopPomodoro / pausePomodoro 的 description
    // 风格（明确分「ok=true 时返回 X / ok=false 时返回 Y」）不一致。末尾补
    // 失败分支文档。
    '**只读，不会修改任何数据**。返回番茄钟统计。' +
    '返回字段（key → 含义）：\n' +
    '  - range: "today" | "week" | "month" | "all"（请求区间）\n' +
    '  - todayCount: number（今日完成数，与 range 无关）\n' +
    '  - weekCount: number（最近 7 个本地日完成数，含今日）\n' +
    '  - rangeCount: number（所选 range 内完成数）\n' +
    '  - rangeTotalMinutes: number（所选 range 内总专注分钟）\n' +
    '  - averageMinutes: number（平均单次时长，分钟，一位小数；无数据 0）\n' +
    '  - streakDays: number（连续完成天数，从今日或昨日往前数）\n' +
    '  - bestHour: string | null（最佳时段 "HH:00-HH+1:00"，本地小时；无数据 null）\n' +
    '  - bestHourCount: number（最佳时段完成数）\n' +
    '  - byDay: Array<{ date: "YYYY-MM-DD", count: number, totalMinutes: number }>（按本地日聚合，date 升序；range="all" 时仅返回**最近 90 天**——若用户有更早的历史会被静默截断不报错，如需全部按日明细请说明并考虑分批查询）\n' +
    '  - withStickyCount: number（绑定便签的番茄数）\n' +
    '  - withoutStickyCount: number（未绑定的番茄数）\n' +
    '回答"我上周番茄为什么减少""周二做了几节""绑定 vs 自由比例"这类细粒度问题。\n' +
    '**失败时**（DB 异常等）返回 `{ ok: false, error: string }`，此时不携带上述 12 个统计字段。',
  risk: 'none',
  oneShot: false,
  parameters: {
    type: 'object',
    properties: {
      range: {
        type: 'string',
        enum: ['today', 'week', 'month', 'all'],
        // R36-fix (MEDIUM ai:getPomodoroStats-range-silent-fallback)：原描述
        // 只说"默认 week"，没提非枚举值会被静默替换为 week。LLM 拼写错（"weekly"
        // / "weeks" / "周"）→ schema enum 校验通过宽松路径 → execute 把 raw 硬
        // 替换成 'week' → LLM 拿着 week 数据回复"最近 7 天你完成了 12 节"而用户
        // 问的是"本月 30 天"。明示 fallback 语义 + 让 LLM 通过返回值 range 字段
        // 二次确认实际区间。
        description:
          '统计区间，默认 week（最近 7 个本地日）。' +
          '**仅接受 today / week / month / all 四个枚举值；传入其它任何字符串（含拼写错、' +
          '大小写错、中文别名）都会被静默替换为 week**，不会报错。' +
          '请以返回结果的 `range` 字段为准判断实际查询区间，不要按入参字面值在回复里向用户承诺。',
      },
    },
  },
  async execute(args) {
    // R32-Corr-2：canonical 入口收敛到 pomodoroBridge（statsBridge 仍 export
    // 同名函数以保留向后兼容，但 tools 层从此只走 pomodoroBridge）。
    const { getPomodoroStats } = await import('../pomodoroBridge')
    const raw = args['range']
    const range =
      raw === 'today' || raw === 'week' || raw === 'month' || raw === 'all' ? raw : 'week'
    return JSON.stringify(await getPomodoroStats(range))
  },
}

/** pomodoro / nav / stats 域工具数组（registry.ts ALL_TOOLS 拼接用） */
export const POMODORO_TOOLS: RunnableTool[] = [
  startPomodoroTool,
  stopPomodoroTool,
  pausePomodoroTool,
  getPomodoroStateTool,
  navigateTool,
  getPomodoroStatsTool,
]