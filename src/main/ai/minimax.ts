/**
 * MiniMax Provider 实现
 *
 * MiniMax 提供与 Anthropic Messages API 完全兼容的端点：
 *   - Base URL: https://api.minimaxi.com
 *   - Endpoint: POST /anthropic/v1/messages
 *   - Auth: Authorization: Bearer <API_KEY>
 *
 * 因此直接复用 @anthropic-ai/sdk 并覆盖 baseURL + authToken，
 * 消息/工具转换走 anthropicCompat.ts，与 Anthropic Provider 完全一致。
 *
 * 注意事项：
 *   - `thinking: { type: 'adaptive' }` 是 MiniMax-M3 的扩展参数，
 *     Anthropic 官方 SDK 的类型里没有声明，传参时用 `as any` 透传。
 *   - MiniMax-M3 支持多模态（图片、视频），当前 UI 只走文本流，
 *     后续若加入图片附件可直接利用 SDK 的 image block。
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

/** MiniMax 服务地址（Anthropic 兼容端点挂在 /anthropic 子路径下，
 *  @anthropic-ai/sdk 内部会在 baseURL 后追加 /v1/messages，
 *  因此这里必须包含 /anthropic 前缀，否则会命中不存在的 /v1/messages 返回 404） */
const MINIMAX_BASE_URL = 'https://api.minimaxi.com/anthropic'

/** MiniMax 静态可用模型列表 */
const MINIMAX_MODELS = [
  'MiniMax-M3',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2',
]

/** 支持 thinking 扩展参数的模型（M3 系列） */
const MINIMAX_THINKING_MODELS = new Set<string>(['MiniMax-M3'])

export class MinimaxProvider implements AiProvider {
  readonly id = 'minimax' as const
  readonly name = 'MiniMax'

  private client: Anthropic | null = null
  /** R20 修复 (high security)：见 openai.ts 同名字段注释。 */
  private clientFingerprint: string | null = null

  private async getClient(): Promise<Anthropic> {
    const apiKey = await getSecret(SECRET_KEYS.MINIMAX_API_KEY)
    if (!apiKey) {
      throw new Error('MiniMax API Key 未配置，请前往设置页面填写')
    }
    const cfg = await loadAiConfig()
    // 默认 baseURL 指向 MiniMax 的 Anthropic 兼容端点（含 /anthropic 子路径）；
    // 若用户在设置里填了自定义 baseURL，则覆盖。
    const baseURL = cfg.aiMinimaxBaseUrl || MINIMAX_BASE_URL
    // R21 修复 (high security)：见 openai.ts getClient() 的详细注释。
    // 原 `${baseURL}::${apiKey.slice(0, 8)}::${apiKey.length}` 只用 key 前 8
    // 字节 + 长度构造指纹，两个不同 key 前缀相同时会被误判为同一指纹，
    // SDK 重建条件失效 → 攻击者可注入同前缀 key 让 Authorization 头带着真实
    // token 打到自己控制的 baseURL。改用 sha256 哈希 (baseURL + apiKey)
    // 整体，碰撞概率从 ~1/2^64 降到 1/2^128。
    const fpInput = `${baseURL.length}::${baseURL}::${apiKey}`
    const fingerprint = createHash('sha256').update(fpInput).digest('hex').slice(0, 32)
    if (this.client && this.clientFingerprint === fingerprint) return this.client
    // 不传 apiKey，避免 SDK 顺手在请求里附 x-api-key: placeholder 头污染鉴权
    this.client = new Anthropic({
      baseURL,
      // MiniMax 使用 Bearer Token；通过 authToken 走 Authorization 头
      authToken: apiKey,
    })
    this.clientFingerprint = fingerprint
    return this.client
  }

  listModels(): string[] {
    return MINIMAX_MODELS
  }

  async testConnection(model?: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const client = await this.getClient()
      // 实际跑一个最小的 messages 请求，验证所选模型真实可用
      //（不再硬编码 M2.5-highspeed，避免与用户选择不一致）
      const probeModel = model && MINIMAX_MODELS.includes(model)
        ? model
        : MINIMAX_MODELS[MINIMAX_MODELS.length - 1] // fallback：最后一个模型（M2，最便宜）
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
      `[ai/minimax] chat start, model=${opts.model}, messages=${aiMessages.length}, tools=${tools?.length ?? 0}`,
    )

    // 构造请求参数；对 M3 等支持的模型附加 thinking 扩展
    // Anthropic SDK 的类型未声明该字段，透传时用 as any
    const params: Record<string, unknown> = {
      model: opts.model,
      system,
      messages: aiMessages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      tools,
    }
    if (MINIMAX_THINKING_MODELS.has(opts.model)) {
      params.thinking = { type: 'adaptive' }
    }

    let stream: ReturnType<Anthropic['messages']['stream']>
    try {
      // SDK 类型不识别扩展字段，整体走 any。
      // R10 修复：把 signal 透传给 SDK，让网络层也响应 abort。
      stream = client.messages.stream(
        params as unknown as Parameters<Anthropic['messages']['stream']>[0],
        opts.signal ? { signal: opts.signal } : {},
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[ai/minimax] create stream failed', err)
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
          }
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
      log.error('[ai/minimax] stream error', err)
      yield { type: 'error', message: msg }
    }
  }
}

let _instance: MinimaxProvider | null = null
export function getMinimaxProvider(): MinimaxProvider {
  if (!_instance) _instance = new MinimaxProvider()
  return _instance
}
