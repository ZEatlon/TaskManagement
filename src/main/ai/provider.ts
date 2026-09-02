/**
 * AI Provider 抽象接口
 *
 * 不同的 LLM 服务商（OpenAI、Anthropic）实现统一的 chat 接口，
 * 上层 router/render 不需要关心具体厂商差异。
 *
 * 数据流：
 *   UI -> IPC -> router -> provider.chat(messages) -> AsyncIterable<ChatChunk>
 *   provider 流式地把文本片段 / 工具调用推回到前端。
 */

/** 消息的通用形态（覆盖 system/user/assistant/tool） */
export interface Message {
  /** 角色 */
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 文本内容 */
  content: string
  /** 工具调用列表（仅 assistant） */
  toolCalls?: ToolCall[]
  /** 工具调用 ID（仅 tool，用于匹配 assistant 的 toolCall） */
  toolCallId?: string
  /** 工具名称（仅 tool） */
  name?: string
}

/** 单次工具调用的描述 */
export interface ToolCall {
  /** 全局唯一 id（UUID） */
  id: string
  /** 工具名 */
  name: string
  /** 解析后的参数对象 */
  arguments: Record<string, unknown>
}

/** 可被 LLM 调用的工具定义（统一格式） */
export interface ToolDefinition {
  /** 工具名 */
  name: string
  /** 工具描述（中文） */
  description: string
  /** JSON Schema 描述参数 */
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /**
   * 副作用风险等级（R8I-2）：
   *   - 'none'        —— 纯读取 / 推理（默认）
   *   - 'side-effect' —— 创建 / 修改 / 删除数据；UI 必须弹确认框
   *   - 'destructive' —— 删除不可恢复数据；UI 必须二次确认
   *
   * 工具循环（chat 流）看到非 'none' 级别会发 `requires_confirmation` 事件到前端，
   * 前端用 confirm 对话框收集 yes/no 再回执，循环才会真正调 execute。
   */
  risk?: 'none' | 'side-effect' | 'destructive'
  /**
   * R8I-3：one-shot 令牌。true 时工具执行后这次 tool call id 会失效，
   * 防止 LLM 在后续回合里通过回顾历史"再次"触发同一个破坏性动作。
   */
  oneShot?: boolean
}

/** 调用选项 */
export interface ChatOptions {
  /** 使用的模型 ID */
  model: string
  /** 采样温度，默认 0.3 */
  temperature?: number
  /** 最大输出 token */
  maxTokens?: number
  /** 工具定义列表（仅当模型支持 tool use 时生效） */
  tools?: ToolDefinition[]
  /** 流式调用 ID，用于取消 */
  callId?: string
  /**
   * R10 修复：取消信号。
   * 原版只有 runStream 的 for-await 检查了 signal.aborted，但 OpenAI/Anthropic
   * SDK 的 create 调用根本没传 signal → 用户点"停止"时主进程循环立刻退出，
   * 但底层 HTTP 流仍在跑，模型继续推 chunk 直到自然结束或网络超时，token 浪费。
   * Provider 实现应该把 signal 透传给 SDK 的流式调用，让网络层也响应 abort。
   */
  signal?: AbortSignal
}

/** 流式响应的一个增量分片 */
export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCallId: string; result: unknown }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done'; persistError?: string }
  | { type: 'error'; message: string }
  // R8I-2：工具循环遇到 risk != 'none' 的工具时，先发这个事件，
  // 前端弹 confirm 对话框再把结果送回主进程。
  | {
      type: 'requires_confirmation'
      toolCallId: string
      toolName: string
      risk: 'side-effect' | 'destructive'
      summary: string
      args: Record<string, unknown>
    }
  // R8I-3：告知前端"该工具本次会话已消耗，下次再触发同一 toolCallId 视为重放，应忽略"。
  | { type: 'one_shot_consumed'; toolCallId: string; toolName: string }

/** AI Provider 接口 */
export interface AiProvider {
  /** 提供商 ID */
  readonly id: 'openai' | 'anthropic' | 'minimax'
  /** 展示名 */
  readonly name: string
  /** 发起对话（流式） */
  chat(messages: Message[], opts: ChatOptions): AsyncIterable<ChatChunk>
  /** 可用模型列表（静态） */
  listModels(): string[]
  /** 测试连接（不消耗 token，仅 ping） */
  testConnection(model?: string): Promise<{ ok: boolean; message?: string }>
}

/** 在路由层缓存的对话上下文（多轮 tool_call 流转用） */
export interface ChatContext {
  provider: 'openai' | 'anthropic' | 'minimax'
  model: string
  messages: Message[]
  usage: { input: number; output: number }
}
