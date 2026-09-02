/**
 * Anthropic Provider 实现
 *
 * 使用 @anthropic-ai/sdk 0.32.x。
 *
 * 消息/工具转换逻辑已抽到 anthropicCompat.ts，
 * MiniMax（Anthropic 兼容协议）也复用同一份实现。
 */
import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import {
  type AiProvider,
  type ChatChunk,
  type ChatOptions,
  type Message,
} from './provider'
import { getSecret, SECRET_KEYS } from '../security/keychain'
import { toAnthropicMessages, toAnthropicTools } from './anthropicCompat'
import { loadAiConfig } from './router'
import log from '../log'

/** Anthropic 静态可用模型列表 */
const ANTHROPIC_MODELS = [
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'claude-3-opus-latest',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
]

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const
  readonly name = 'Anthropic'

  private client: Anthropic | null = null
  /** R20 修复 (high security)：见 openai.ts 同名字段注释。 */
  private clientFingerprint: string | null = null

  private async getClient(): Promise<Anthropic> {
    const apiKey = await getSecret(SECRET_KEYS.ANTHROPIC_API_KEY)
    if (!apiKey) {
      throw new Error('Anthropic API Key 未配置，请前往设置页面填写')
    }
    const cfg = await loadAiConfig()
    const baseURL = cfg.aiAnthropicBaseUrl ?? ''
    // R21 修复 (high security)：见 openai.ts getClient() 的详细注释。
    // 原 `${baseURL}::${apiKey.slice(0, 8)}::${apiKey.length}` 只用 key 前 8
    // 字节 + 长度构造指纹，两个不同 key 前缀相同时会被误判为同一指纹，
    // 攻击者注入相同前缀的伪 key 不会触发 SDK 重建 → 真实请求仍带原 key
    // 打到对手控制的目标。改用 sha256 哈希整个 (baseURL + apiKey)，抗碰撞
    // 强度从 1/2^64 提升到 1/2^128，并消除前缀匹配的攻击面。
    const fpInput = `${baseURL.length}::${baseURL}::${apiKey}`
    const fingerprint = createHash('sha256').update(fpInput).digest('hex').slice(0, 32)
    if (this.client && this.clientFingerprint === fingerprint) return this.client
    const opts: ConstructorParameters<typeof Anthropic>[0] = { apiKey }
    if (cfg.aiAnthropicBaseUrl) opts.baseURL = cfg.aiAnthropicBaseUrl
    this.client = new Anthropic(opts)
    this.clientFingerprint = fingerprint
    return this.client
  }

  listModels(): string[] {
    return ANTHROPIC_MODELS
  }

  async testConnection(model?: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const client = await this.getClient()
      // 用用户实际选择的模型做最小请求验证；为空则用 haiku（最便宜）
      const probeModel = model && model.trim().length > 0 ? model : 'claude-3-5-haiku-latest'
      const res = await client.messages.create({
        model: probeModel,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      })
      return { ok: !!res.id, message: res.id ? `已连上模型 ${res.model}` : '已连接' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: msg }
    }
  }

  async *chat(messages: Message[], opts: ChatOptions): AsyncIterable<ChatChunk> {
    const client = await this.getClient()
    const { system, messages: aiMessages } = toAnthropicMessages(messages)
    const tools = toAnthropicTools(opts.tools)

    log.info(
      `[ai/anthropic] chat start, model=${opts.model}, messages=${aiMessages.length}, tools=${tools?.length ?? 0}`,
    )

    let stream: ReturnType<Anthropic['messages']['stream']>
    try {
      // R10 修复：把 signal 透传给 SDK，否则 SDK 在网络层继续跑。
      stream = client.messages.stream(
        {
          model: opts.model,
          system,
          messages: aiMessages,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.3,
          tools,
        },
        // Anthropic SDK 的 stream() 第二个参数是 RequestOptions，其中包含
        // signal?: AbortSignal。空对象兜底避免 undefined 透传时类型不匹配。
        opts.signal ? { signal: opts.signal } : {},
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[ai/anthropic] create stream failed', err)
      yield { type: 'error', message: msg }
      return
    }

    try {
      for await (const event of stream) {
        // 文本增量
        if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            yield { type: 'text', text: delta.text }
          } else if (delta.type === 'input_json_delta') {
            // 工具调用参数的增量片段，缓存到 delta 内，由后续 content_block_stop 汇总
            // 这里用一个伪 ID 占位，完整 ID 会在 stop 事件中出现
            // 但 SDK 已经会聚合，直接监听 stop 事件
          }
        } else if (event.type === 'content_block_stop') {
          // SDK 0.32 没有直接给聚合后的 tool_use，依赖 message_stop 时的 finalMessage
        }
      }
      // 拿到完整响应，做一次工具调用提取
      const finalMessage = await stream.finalMessage()
      let inputTokens = 0
      let outputTokens = 0
      const usage = finalMessage.usage
      if (usage) {
        inputTokens = usage.input_tokens ?? 0
        outputTokens = usage.output_tokens ?? 0
      }
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          yield {
            type: 'tool_call',
            toolCall: {
              id: block.id,
              name: block.name,
              arguments: (block.input ?? {}) as Record<string, unknown>,
            },
          }
        }
      }
      yield { type: 'usage', input: inputTokens, output: outputTokens }
      yield { type: 'done' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[ai/anthropic] stream error', err)
      yield { type: 'error', message: msg }
    }
  }
}

let _instance: AnthropicProvider | null = null
export function getAnthropicProvider(): AnthropicProvider {
  if (!_instance) _instance = new AnthropicProvider()
  return _instance
}
