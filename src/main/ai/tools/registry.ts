/**
 * AI Function Calling 工具 — registry 聚合层
 *
 * 每个工具 = JSON Schema + 执行函数 execute()
 * 上层 router 会自动注入到 LLM 请求中。
 *
 * 工具执行结果会自动反序列化为字符串返回给 LLM，
 * 这里直接 JSON.stringify 即可。
 *
 * 工具列表（按 domain 拆分到 4 个子文件，本文件仅聚合）：
 *   sticky 域（tools/sticky.ts — 10 个）：
 *     1. createSticky        — 创建便签
 *     2. updateSticky        — 更新便签
 *     3. completeSticky      — 标记完成便签
 *     4. searchStickies      — 搜索便签
 *     5. planDay             — 今日便签执行顺序建议
 *     6. batchUpdateStickies — 批量修改便签（≤100 条）
 *     7. getSticky           — 取便签完整详情（含 tags / steps / starred 等）
 *     8. readStickySteps     — 只读便签步骤内容数组
 *     9. listStickyTags      — 只读便签已贴 tag 列表
 *    10. deleteSticky        — 删除便签（连带 completions + pomodoros）
 *
 *   note 域（tools/note.ts — 3 个）：
 *    11. createNote          — 创建笔记（pending confirmation）
 *    12. searchNotes         — 搜索笔记正文 / 文件名
 *    13. summarizeNote       — 读取指定 ID 笔记正文
 *
 *   tag 域（tools/tag.ts — 5 个）：
 *    14. addTag              — 创建标签
 *    15. listTags            — 列出全部已注册标签（只读）
 *    16. applyTagToNote      — 给笔记贴已有标签
 *    17. applyTagToSticky    — 给便签贴已有标签
 *    18. removeTagFromSticky — 从便签摘掉已有标签（幂等）
 *
 *   pomodoro / nav / stats 域（tools/pomodoro.ts — 6 个）：
 *    19. startPomodoro       — 启动番茄钟
 *    20. stopPomodoro        — 停止番茄钟
 *    21. pausePomodoro       — 暂停 / 恢复番茄钟（toggle）
 *    22. getPomodoroState    — 读取番茄钟实时状态（只读）
 *    23. navigate            — 切换应用路由（白名单）
 *    24. getPomodoroStats    — 番茄钟统计（今日 / 本周 / streak / 最佳时段）
 *
 * 历史：R32-1 修复删除过 5 个 stub 工具
 *   （breakdownSticky / suggestPriority / polishStickySteps / classifySticky /
 *   extractActions）—— execute 只回 `{ok:true, note:'由 LLM 在本轮回复中给出'}`
 *   让前端空转，LLM 看到 description 后真去调用会得到无内容的 ok:true 反而困惑。
 *   彻底从 ALL_TOOLS 删除，由 LLM 直接在 reply 里产出对应内容；旧 prompts.ts
 *   中 5 个 INSTRUCTIONS 常量随之删除（无外部消费者）。删除前曾有 23 个
 *   （22 + addTag），删除后落到 18 个。
 *
 *   R-listTags-discovery 修复新增 1 个 read-only 工具 listTags → 19 个。
 *   之后陆续新增 getPomodoroState / navigate / getPomodoroStats 等 read-only /
 *   导航类工具，ALL_TOOLS.length 推到 20。
 *
 *   R-fix-missing-sticky-tools (MEDIUM)：新增 getSticky / readStickySteps /
 *   listStickyTags / deleteSticky 四个 sticky 域工具补齐 searchStickies 描
 *   述里承认的「tags / starred / steps / 删除 等完整字段不可读 / 不可写」
 *   空缺，ALL_TOOLS.length = 24。
 *
 * 11-24 的实际副作用都委托给 ai/*Bridge.ts / repos，工具层只做参数校验 +
 * JSON 序列化，不直接依赖 pomodoro/ routes/ 等模块的内部实现。
 */
import type { ToolDefinition } from '../provider'
import { POMODORO_TOOLS } from './pomodoro'
import { NOTE_TOOLS } from './note'
import { STICKY_TOOLS } from './sticky'
import { TAG_TOOLS } from './tag'
import { isBridgeFailure, type BridgeFailure } from '../bridge/types'
import { getCallerAlsStore } from './context'
import log from '../../log'

/** 工具调用结果统一返回字符串 */
type ToolResult = string

/** 工具定义（继承 ToolDefinition 并附加 execute） */
export interface RunnableTool extends ToolDefinition {
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

/** 所有可执行工具列表（注册到 router 时使用）。按 domain 顺序拼接：
 *  sticky → note → tag → pomodoro/nav/stats；与上方 header 编号一致。 */
export const ALL_TOOLS: RunnableTool[] = [
  ...STICKY_TOOLS,
  ...NOTE_TOOLS,
  ...TAG_TOOLS,
  ...POMODORO_TOOLS,
]

/**
 * 仅返回可被 LLM 看到的工具定义（剥离 execute）
 */
export function getToolDefinitions(): ToolDefinition[] {
  return ALL_TOOLS.map(({ execute: _e, ...rest }) => rest)
}

/**
 * 执行工具：根据 name 找到对应的执行器
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // R-fix-caller-context-leak (medium correctness)：进入工具前校验 ALS
  // store —— stream.ts 走 runWithCallerContext() 包装 executeTool，store
  // 应当始终存在。若 store 缺失（caller webContents 在 runStream 入口
  // 到此处之间被销毁、模块被 import 后第一次进入、或测试旁路），短路返
  // 回 bridge failure 而不是继续 mutate aiContextByWebContents / 发 IPC
  // 到已死的 webContents。registerPendingCreateNote / setCurrentXxx 系列
  // 写入都是 idempotent 副作用，单次空跑无害；但 LLM 会拿到「假成功」
  // 误以为副作用发生，反而比显式失败更危险。
  if (!getCallerAlsStore()) {
    log.warn(`[ai/tools] executeTool ${name} called without caller ALS context; aborting`)
    return JSON.stringify({
      ok: false,
      error: 'caller webContents destroyed or no ALS context',
    })
  }
  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (!tool) {
    return JSON.stringify({ ok: false, error: `未知工具: ${name}` })
  }
  try {
    const result = await tool.execute(args)
    // R39-fix-bridge-guards-live (low structure)：工具结果是 JSON 字符串，
    // 形态符合 bridge/types.ts 的 BridgeResult<T> 联合（成功平铺字段 /
    // 失败 {ok:false, error:string}）。本轮把 isBridgeFailure 接到这里
    // 做统一出口 —— 失败时 warn 一行（与下方 catch 路径格式对齐），成功
    // 时透传。这样 bridge/types.ts 的类型守卫有了真实使用点，而不是只
    // 供文档查阅。createNote / searchNotes 等返回 `kind: 'confirm_create'`
    // 或 `<note_content_snippet>...</note_content_snippet>` 等特殊 shape
    // 时 ok 通常仍为 true，守卫不会误触发；非 JSON 字符串（极端工具
    // 实现）解析抛错则 catch 静默跳过，不影响透传。
    try {
      const parsed: unknown = JSON.parse(result)
      // isBridgeFailure 接受 `{ ok: unknown }` 形状；这里把 unknown 收窄成
      // 该形状以便通过类型校验（结构化 narrowing 而非 cast）。
      if (isBridgeFailure(parsed as { ok: unknown } | null | undefined)) {
        log.warn(`[ai/tools] ${name} returned failure: ${(parsed as BridgeFailure).error}`)
      }
    } catch {
      // 工具结果不是合法 JSON —— 视为非 BridgeResult 路径，透传即可
    }
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`[ai/tools] execute ${name} failed: ${msg}`, err)
    return JSON.stringify({ ok: false, error: msg })
  }
}