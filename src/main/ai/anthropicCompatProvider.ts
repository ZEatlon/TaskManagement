/**
 * Anthropic 兼容 Provider 基类（R22 重构）
 *
 * 之前 anthropic.ts (167 行) 和 minimax.ts (195 行) 各自维护了一份几乎
 * 一模一样的 SDK 包装（getClient 指纹 / chat 流 / testConnection / 错误
 * 处理），任何 SDK 升级或事件处理修复都要改两遍。R21 的 sha256 指纹修复就
 * 重复了三处（openai.ts / anthropic.ts / minimax.ts），三处注释都各自维护。
 *
 * 本基类把全部公共实现收口到一处，子类只需声明 Provider ID / 模型列表 /
 * 鉴权方式（apiKey vs authToken）/ 是否启用 thinking 扩展这些配置差异。
 * 单一改动点 → 不会再漂移。
 */
import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import {
  type AiProvider,
  type ChatChunk,
  type ChatOptions,
  type Message,
} from './provider'
import { getSecret } from '../security/keychain'
import { toAnthropicMessages, toAnthropicTools } from './anthropicCompat'
import { loadAiConfig } from './router'
import { translateAiError } from '@shared/i18n/aiErrorTranslate'
import log from '../log'

/** SDK 鉴权方式 */
export type AnthropicCompatAuthMode = 'apiKey' | 'authToken'

/** Anthropic 兼容 Provider 的差异配置 */
export interface AnthropicCompatConfig {
  /** Provider ID */
  id: 'anthropic' | 'minimax'
  /** 展示名 */
  name: string
  /** 从 keychain 取 API Key 的 key 名 */
  secretKey: string
  /** API Key 未配置时的错误提示 */
  missingKeyMessage: string
  /**
   * 解析当前生效的 baseURL（settings 优先，否则回退到默认）。
   * Anthropic：空字符串代表走 SDK 默认端点；MiniMax：兜底为自带的兼容端点。
   */
  resolveBaseURL: (cfg: { aiAnthropicBaseUrl: string; aiMinimaxBaseUrl: string }) => string
  /** 可用模型列表 */
  models: string[]
  /**
   * 哪些模型需要附加 `thinking: { type: 'adaptive' }` 扩展参数。
   * 未提供或不含当前模型 → 不附加（Anthropic 官方 SDK 类型未声明此字段，
   * 整体走 any 透传）。
   */
  thinkingModels?: ReadonlySet<string>
  /** SDK 鉴权方式：'apiKey' (x-api-key) 或 'authToken' (Authorization Bearer) */
  authMode: AnthropicCompatAuthMode
  /** 日志 tag（如 'anthropic' / 'minimax'） */
  logTag: string
  /**
   * testConnection 兜底模型（用户没指定 model 时使用）。
   * 未提供则回退到 models 列表最后一项。
   */
  defaultTestModel?: string
}

/**
 * Anthropic 兼容 Provider 基类
 *
 * 实现共同的 SDK 客户端懒加载 / sha256 指纹重建 / 流式 chat / testConnection
 * 逻辑。具体 Provider 继承并填 AnthropicCompatConfig 即可。
 */
export class AnthropicCompatProvider implements AiProvider {
  readonly id: 'anthropic' | 'minimax'
  readonly name: string

  private readonly cfg: AnthropicCompatConfig
  private client: Anthropic | null = null
  /** R21 修复 (high security)：见 openai.ts getClient() 的详细注释。
   *  用 sha256 哈希 (baseURL + apiKey) 整体，避免 key 前缀碰撞导致 SDK 重建失效。
   *  公共逻辑收口到基类后只需维护一份。 */
  private clientFingerprint: string | null = null

  protected constructor(cfg: AnthropicCompatConfig) {
    this.cfg = cfg
    this.id = cfg.id
    this.name = cfg.name
  }

  private async getClient(): Promise<Anthropic> {
    const apiKey = await getSecret(this.cfg.secretKey)
    if (!apiKey) {
      throw new Error(this.cfg.missingKeyMessage)
    }
    const aiCfg = await loadAiConfig()
    const baseURL = this.cfg.resolveBaseURL(aiCfg)
    // R21 修复：用 sha256 哈希 (baseURL + apiKey) 整体构造指纹 → 抗碰撞
    // 强度 ~2^-128；任一变化 → SDK 重建，避免 XSS 攻击者改 baseURL 后
    // 真实请求仍带原 token 打到对手控制的目标。
    const fpInput = `${baseURL.length}::${baseURL}::${apiKey}`
    const fingerprint = createHash('sha256').update(fpInput).digest('hex').slice(0, 32)
    if (this.client && this.clientFingerprint === fingerprint) return this.client
    const opts: ConstructorParameters<typeof Anthropic>[0] = {}
    if (baseURL) opts.baseURL = baseURL
    if (this.cfg.authMode === 'authToken') {
      // Bearer Token 鉴权（MiniMax 等 Anthropic 兼容协议服务）
      opts.authToken = apiKey
    } else {
      // 官方 x-api-key 鉴权
      opts.apiKey = apiKey
    }
    this.client = new Anthropic(opts)
    this.clientFingerprint = fingerprint
    return this.client
  }

  listModels(): string[] {
    return this.cfg.models
  }

  async testConnection(model?: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const client = await this.getClient()
      // 用用户实际选择的模型做最小请求验证；为空则用 defaultTestModel
      // （保持向后兼容：Anthropic 用 'claude-3-5-haiku-latest'，MiniMax 用
      // 列表最后一个）
      const probeModel =
        model && model.trim().length > 0
          ? model
          : (this.cfg.defaultTestModel ??
            this.cfg.models[this.cfg.models.length - 1])
      const res = await client.messages.create({
        model: probeModel,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      })
      return { ok: !!res.id, message: res.id ? `已连上模型 ${res.model}` : '已连接' }
    } catch (err) {
      // R40-fix-ai-raw-sdk-error (medium)：不再把 SDK 原始 message 推给渲染端。
      // 原始错误进 log.error 留诊断痕迹；UI 拿中文友好文案。
      log.error(`[ai/${this.cfg.logTag}] testConnection failed`, err)
      return { ok: false, message: translateAiError(err, err instanceof Error ? err.message : String(err)) }
    }
  }

  async *chat(messages: Message[], opts: ChatOptions): AsyncIterable<ChatChunk> {
    const client = await this.getClient()
    const { system, messages: aiMessages } = toAnthropicMessages(messages)
    const tools = toAnthropicTools(opts.tools)

    log.info(
      `[ai/${this.cfg.logTag}] chat start, model=${opts.model}, messages=${aiMessages.length}, tools=${tools?.length ?? 0}`,
    )

    // 构造请求参数；对支持的模型附加 thinking 扩展。
    // Anthropic SDK 的类型未声明 thinking 字段，整体走 any 透传。
    const params: Record<string, unknown> = {
      model: opts.model,
      system,
      messages: aiMessages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      tools,
    }
    if (this.cfg.thinkingModels?.has(opts.model)) {
      params.thinking = { type: 'adaptive' }
    }

    let stream: ReturnType<Anthropic['messages']['stream']>
    try {
      // R10 修复：把 signal 透传给 SDK，让网络层响应 abort。
      stream = client.messages.stream(
        params as unknown as Parameters<Anthropic['messages']['stream']>[0],
        opts.signal ? { signal: opts.signal } : {},
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`[ai/${this.cfg.logTag}] create stream failed`, err)
      // R-fix-llm-error-vs-persist：chat() 抛错走 translateAiError 转中文
      // 友好文案 + 打 llm-error reason；stream.ts 据此不再把这串 message
      // 塞进 done.persistError，避免渲染端把 LLM 故障误报为 "DB 写入失败"。
      yield {
        type: 'error',
        message: translateAiError(err, msg),
        reason: 'llm-error',
      }
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
            // 工具调用参数的增量片段，SDK 会在 finalMessage 聚合
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
      log.error(`[ai/${this.cfg.logTag}] stream error`, err)
      // R-fix-llm-error-vs-persist：同上 create stream failed 分支，把 SDK
      // message 翻译成中文并打 llm-error reason，让 stream.ts 把它当作
      // LLM 错误而不是 DB 持久化失败。
      yield {
        type: 'error',
        message: translateAiError(err, msg),
        reason: 'llm-error',
      }
    }
  }
}