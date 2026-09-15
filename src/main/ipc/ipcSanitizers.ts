/**
 * IPC 入参 sanitizers —— 主进程侧的共享白名单 / stripper
 *
 * 历史：R27-Sec-4 / R31-Sec-4 / R32-Corr-9 修复在 ai-handlers.ts 与
 * conversation-handlers.ts 各有一份近乎重复的 toolCallKeyRe +
 * helperKeyRe 正则 + 配套 strip / clone 逻辑。两份实现已轻微分叉：
 *   - ai-handlers 用 `delete cloned[k]`（保留其它键）
 *   - conversation-handlers 用 build-fresh-object（白名单保留）
 *
 * 表面行为等价，但下一次有人新增工具辅助字段（如 tool_calls_v2 /
 * function_name）时极易只改一边导致 prompt-injection 防护在另一边
 * 静默失效。把正则与 strip 提到本文件作为单一来源。
 *
 * 当前消费方：
 *   - src/main/ipc/ai-handlers.ts        (ai:stream)
 *   - src/main/ipc/conversation-handlers.ts (AI_APPEND_MESSAGE)
 */

/**
 * 工具调用相关字段（toolCalls / tool_calls / TOOL_CALLS / toolCallsList
 * 等所有大小写 + 连字符变体）。R29-Sec-1 加 regex 覆盖所有变体，
 * 修复 R27 仅删 camelCase 的 bypass。
 */
export const TOOL_CALL_KEY_RE = /^tool[_-]?calls?$/i

/**
 * 工具执行回执的辅助字段：function_call（OpenAI 历史 schema）/ tool_call_id
 * （tool 消息的关联键）/ name（旧 Anthropic 风格）。R31-Sec-4 / R32-Corr-9
 * 修复加进来，渲染端伪造这三条会让 LLM 误信工具已产生副作用。
 */
export const HELPER_KEY_RE = /^(function_call|tool_call_id|name)$/i

/**
 * 判断 obj 上是否含有需要 strip 的工具相关键。
 * 调用方应在 hot path 上先用本函数短路：没有匹配就跳过 clone，省一次
 * 浅拷贝。匹配上再走 stripToolCallFields 拿克隆。
 */
export function hasToolCallField(obj: Record<string, unknown>): boolean {
  for (const k of Object.keys(obj)) {
    if (TOOL_CALL_KEY_RE.test(k) || HELPER_KEY_RE.test(k)) {
      return true
    }
  }
  return false
}

/**
 * 返回 obj 的浅拷贝，移除所有匹配 TOOL_CALL_KEY_RE / HELPER_KEY_RE 的键。
 * 不 mutate 入参（与 R26-Corr-4 / R26-Sec-6 修复要求一致：原版直接
 * `delete obj.toolCalls` 会破坏 stream retry / renderer 引用 fidelity）。
 *
 * 调用方拿到结果后自行决定：
 *   - ai-handlers 替换 req.messages[i] = stripToolCallFields(obj)
 *   - conversation-handlers 把它当 AiMessage 写库
 */
export function stripToolCallFields<T extends Record<string, unknown>>(
  obj: T,
): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...obj }
  for (const k of Object.keys(cloned)) {
    if (TOOL_CALL_KEY_RE.test(k) || HELPER_KEY_RE.test(k)) {
      delete cloned[k]
    }
  }
  return cloned
}
