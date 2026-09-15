/**
 * AI Function Calling 工具 —— barrel
 *
 * 历史：从单文件 1952+ 行的 tools.ts 拆成 6 个 domain 文件：
 *   - tools/validators.ts   纯函数与白名单（escapeToolText / parseSafeDate /
 *                           parseSafeDayKey / normalizeStatus / normalizePriority /
 *                           VALID_STICKY_STATUSES / VALID_PRIORITIES）
 *   - tools/context.ts      3 个 module-level Map + AsyncLocalStorage caller
 *                           上下文 + setCurrentXxx / clear 系列 setter
 *   - tools/createNote.ts   pendingCreateNoteByWebContents FIFO + 落盘助手
 *   - tools/sticky.ts       6 个 sticky 域工具（createSticky / updateSticky /
 *                           completeSticky / searchStickies / planDay /
 *                           batchUpdateStickies）
 *   - tools/note.ts         3 个 note 域工具（createNote / searchNotes /
 *                           summarizeNote）
 *   - tools/tag.ts          4 个 tag 域工具（addTag / applyTagToNote /
 *                           applyTagToSticky / removeTagFromSticky）
 *   - tools/pomodoro.ts     5 个 pomodoro / nav / stats 域工具
 *                           （startPomodoro / stopPomodoro / pausePomodoro /
 *                           navigate / getPomodoroStats）
 *   - tools/registry.ts     RunnableTool 类型 + ALL_TOOLS 聚合 +
 *                           getToolDefinitions / executeTool
 *
 * R32-1 修复：曾有 breakdownSticky / suggestPriority / polishStickySteps /
 * classifySticky / extractActions 共 5 个「纯 LLM 推理」的 stub 工具，
 * execute 只回 `{ok:true, note:'由 LLM 在本轮回复中给出'}` 让前端空转。
 * 全部从 ALL_TOOLS 删除，由 LLM 在 reply 里直接产出对应内容。当前
 * RunnableTool 总数请以 ./tools/registry.ts 顶部枚举（同时也是 ALL_TOOLS.length）
 * 为准 —— 历史删过 5 个 stub、加过 listTags 等多个 read-only 工具，硬编
 * 总数极易漂移；本 barrel 不再维护硬编计数。
 *
 * 旧 API（外部 import 路径 `from '../ai/tools'`）保持完全兼容：所有原
 * 导出符号都在本 barrel 重新导出。后续新代码建议直接 import 各 domain
 * 子模块，按需加载 + 改一处不影响全部。
 */
import './tools/createNote' // 触发 createNote 内部对 context 的 pending 表访问桥绑定
export {
  VALID_STICKY_STATUSES,
  VALID_PRIORITIES,
  normalizeStatus,
  normalizePriority,
  parseSafeDate,
  parseSafeDayKey,
  escapeToolText,
} from './tools/validators'

export type { CallerAiContext } from './tools/context'
export {
  noteOpenedByWebContents,
  noteClosedByWebContents,
  setCurrentNoteId,
  clearWebContentsNoteState,
  setCurrentStickyId,
  clearStickyIdIfMatches,
  setCurrentPomodoroContext,
  getAiContextByWebContents,
  buildAiContextPrompt,
  getCurrentOpenNoteByWebContents,
  setCurrentCallerWebContentsId,
  getCurrentCallerWebContentsId,
  getCallerAlsStore,
  runWithCallerContext,
  __bindActiveStreamsAccessor,
} from './tools/context'

export {
  registerPendingCreateNote,
  consumePendingCreateNote,
  createNoteConfirmed,
} from './tools/createNote'

export type { RunnableTool } from './tools/registry'
export {
  ALL_TOOLS,
  getToolDefinitions,
  executeTool,
} from './tools/registry'
