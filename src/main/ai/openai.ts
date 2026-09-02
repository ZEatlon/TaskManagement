/**
 * OpenAI Provider 实现
 *
 * 使用 openai SDK 4.x，支持流式输出 + function calling。
 * 把 SDK 的事件格式转换成统一的 ChatChunk 序列。
 */
import OpenAI from 'openai'
import { randomUUID, createHash } from 'node:crypto'
import {
  type AiProvider,
  type ChatChunk,
  type ChatOptions,
  type Message,
  type ToolDefinition,
} from './provider'
import { getSecret, SECRET_KEYS } from '../security/keychain'
import { loadAiConfig } from './router'
import log from '../log'

/** OpenAI 静态可用模型列表 */
const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'o1-mini',
  'o1-preview',
]

/** 把 Message[] 转成 OpenAI ChatCompletionMessageParam[] */
function toOpenAIMessages(messages: Message[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content })
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments ?? {}),
            },
          })),
        })
      } else {
        out.push({ role: 'assistant', content: m.content })
      }
    } else if (m.role === 'tool') {
      if (m.toolCallId) {
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })
      }
    }
  }
  return out
}

/** 工具定义转 OpenAI tools 格式 */
function toOpenAITools(tools: ToolDefinition[] | undefined): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }))
}

/**
 * OpenAI Provider
 *
 * 使用懒加载创建客户端（避免没有 key 时启动报错）。
 */
export class OpenAIProvider implements AiProvider {
  readonly id = 'openai' as const
  readonly name = 'OpenAI'

  private client: OpenAI | null = null
  /** R20 修复 (high security)：缓存 (apiKey + baseURL) 的指纹，配置变化时
   * 自动重建 SDK 客户端。否则 XSS 攻击者修改 aiOpenaiBaseUrl 后 SDK 仍
   * 把 Authorization 头打到原 host（旧 baseURL 失效 + 新 baseURL 不可见），
   * 或反过来首调之前预置 attacker 主机 → 整进程 token 外泄。 */
  private clientFingerprint: string | null = null

  /**
   * 获取 OpenAI 客户端（懒加载 / 配置变更后重建）
   * 如果 API key 不存在则抛出错误
   */
  private async getClient(): Promise<OpenAI> {
    const apiKey = await getSecret(SECRET_KEYS.OPENAI_API_KEY)
    if (!apiKey) {
      throw new Error('OpenAI API Key 未配置，请前往设置页面填写')
    }
    const cfg = await loadAiConfig()
    const baseURL = cfg.aiOpenaiBaseUrl ?? ''
    // 用 apiKey + baseURL 拼指纹；任一变化 → 重建 client。
    // R21 修复 (high security)：原版 `${baseURL}::${apiKey.slice(0, 8)}::${apiKey.length}`
    // 仅用 apiKey 前 8 字符 + 长度，对以下情况碰撞：
    //   1) 两个 key 前 8 字符相同（如 "sk-abc12345..." vs "sk-abc12345-other"）：
    //      slice(0,8) 一样，长度不一样但 baseURL 也可能凑齐 → 攻击者注入相同
    //      前缀的伪 key 不会重建 client，但 SDK 仍按原 key 调用 → 攻击者控制
    //      的请求悄悄打到 SDK 之前没识别出 key 已换。
    //   2) baseURL 变化但长度相同 → 仍能 prefix 命中旧指纹？字符串拼接里
    //      baseURL 在前，key 长度区分已够，但 slice(0,8) 与长度拼接有 1/2^64
    //      级哈希碰撞概率（生日攻击）。
    // 修复：用 sha256 把 (baseURL + apiKey) 整个哈希后取 16 hex 字符。
    // 1) sha256 是密码学抗碰撞，理论碰撞概率 2^-128；
    // 2) 把整个 apiKey（不只是前缀）参与哈希 → 任何一个字节变化都改指纹；
    // 3) 长度信息冗余但仍保留作为防御深度（防止 apiKey 末段相同巧合）。
    const fpInput = `${baseURL.length}::${baseURL}::${apiKey}`
    const fingerprint = createHash('sha256').update(fpInput).digest('hex').slice(0, 32)
    if (this.client && this.clientFingerprint === fingerprint) return this.client
    const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey }
    if (cfg.aiOpenaiBaseUrl) opts.baseURL = cfg.aiOpenaiBaseUrl
    this.client = new OpenAI(opts)
    this.clientFingerprint = fingerprint
    return this.client
  }

  listModels(): string[] {
    return OPENAI_MODELS
  }

  async testConnection(model?: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const client = await this.getClient()
      // 若指定了具体模型，做一次最小 chat completion 验证该模型可用；
      // 否则回退到 models.list()（仅验证鉴权）。
      if (model && model.trim().length > 0) {
        const res = await client.chat.completions.create({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        })
        const used = res.model ?? model
        return { ok: !!res.id, message: `已连上模型 ${used}` }
      }
      const list = await client.models.list()
      return { ok: !!list.data, message: `已发现 ${list.data.length} 个可用模型` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: msg }
    }
  }

  /**
   * 把累积的工具调用 flush 出来并清空 map，避免重复 yield。
   */
  private async *flushToolCalls(
    acc: Map<number, { id: string; name: string; argsText: string }>,
  ): AsyncIterable<ChatChunk> {
    for (const a of acc.values()) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = a.argsText ? JSON.parse(a.argsText) : {}
      } catch {
        parsed = { _raw: a.argsText }
      }
      yield {
        type: 'tool_call',
        toolCall: { id: a.id, name: a.name, arguments: parsed },
      }
    }
    acc.clear()
  }

  async *chat(messages: Message[], opts: ChatOptions): AsyncIterable<ChatChunk> {
    const client = await this.getClient()
    const aiMessages = toOpenAIMessages(messages)
    const tools = toOpenAITools(opts.tools)

    log.info(`[ai/openai] chat start, model=${opts.model}, messages=${messages.length}, tools=${tools?.length ?? 0}`)

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
    try {
      // R10 修复：把 signal 透传给 SDK。OpenAI SDK 在底层 HTTP 层订阅
      // AbortSignal.abort 事件并中断 fetch，否则用户点"停止"后 fetch 仍
      // 跑到模型自然结束 → token 持续消耗。
      stream = await client.chat.completions.create({
        model: opts.model,
        messages: aiMessages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 2048,
        tools,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[ai/openai] create stream failed', err)
      yield { type: 'error', message: msg }
      return
    }

    // 累积工具调用：stream 中的每个 chunk 可能包含部分 arguments
    const toolCallsAcc = new Map<
      number,
      { id: string; name: string; argsText: string }
    >()

    try {
      for await (const part of stream) {
        // 用量
        if (part.usage) {
          yield {
            type: 'usage',
            input: part.usage.prompt_tokens ?? 0,
            output: part.usage.completion_tokens ?? 0,
          }
        }
        const choice = part.choices?.[0]
        if (!choice) continue

        // 文本增量
        const delta = choice.delta
        if (delta?.content) {
          yield { type: 'text', text: delta.content }
        }

        // 工具调用增量
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            const existing = toolCallsAcc.get(idx)
            if (!existing) {
              toolCallsAcc.set(idx, {
                id: tc.id ?? randomUUID(),
                name: tc.function?.name ?? '',
                argsText: tc.function?.arguments ?? '',
              })
            } else {
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.argsText += tc.function.arguments
            }
          }
        }

        // 完成标记
        if (choice.finish_reason) {
          // 把累积的工具调用 yield 出去
          yield* this.flushToolCalls(toolCallsAcc)
        }
      }
      // 流结束（无论是否收到 finish_reason）也要 flush 一次，
      // 防止网络中断/abort 时累积的工具调用被静默丢弃。
      yield* this.flushToolCalls(toolCallsAcc)
      yield { type: 'done' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[ai/openai] stream error', err)
      yield { type: 'error', message: msg }
    }
  }
}

/** 单例 */
let _instance: OpenAIProvider | null = null
export function getOpenAIProvider(): OpenAIProvider {
  if (!_instance) _instance = new OpenAIProvider()
  return _instance
}
