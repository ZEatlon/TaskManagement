/**
 * Anthropic 兼容层共享工具
 *
 * Anthropic 官方 SDK 和 MiniMax（Anthropic 兼容协议）共用同一份
 * 消息/工具转换逻辑。本文件把 anthropic.ts 里原本内置的 toAnthropicMessages /
 * toAnthropicTools 抽出来，供 AnthropicProvider 和 MinimaxProvider 共用。
 *
 * 关键差异（与 OpenAI 对比）：
 *   - system prompt 单独字段（不进 messages）
 *   - 工具调用：input 是 JSON 对象（不序列化为字符串）
 *   - 工具结果：tool_use_id + content
 *   - 助手消息中包含 tool_use 块时要原样传回去
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { Message, ToolDefinition } from './provider'

/** 把 Message[] 转成 Anthropic 期望的 messages 格式（system 单独抽取） */
export function toAnthropicMessages(messages: Message[]): {
  system: string
  messages: Anthropic.Messages.MessageParam[]
} {
  let system = ''
  const msgs: Anthropic.Messages.MessageParam[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + m.content
    } else if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      // 如果有 tool_calls，需要把 tool_use 块合并到 content
      if (m.toolCalls && m.toolCalls.length > 0) {
        const blocks: Anthropic.Messages.MessageParam['content'] = []
        if (m.content) {
          blocks.push({ type: 'text', text: m.content } as Anthropic.Messages.TextBlockParam)
        }
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          } as Anthropic.Messages.ToolUseBlockParam)
        }
        msgs.push({ role: 'assistant', content: blocks })
      } else {
        msgs.push({ role: 'assistant', content: m.content })
      }
    } else if (m.role === 'tool' && m.toolCallId) {
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          } as Anthropic.Messages.ToolResultBlockParam,
        ],
      })
    }
  }

  return { system, messages: msgs }
}

/** 工具定义 -> Anthropic 格式 */
export function toAnthropicTools(
  tools: ToolDefinition[] | undefined,
): Anthropic.Messages.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as Anthropic.Messages.Tool.InputSchema,
  }))
}
