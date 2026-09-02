/**
 * AI Router（按设置选择 Provider）
 *
 * 负责：
 *   - 根据全局设置中 aiProvider 字段选择 OpenAI / Anthropic / MiniMax Provider
 *   - 提供可用 Provider 列表
 *   - 暴露统一的 chat 调用入口（含 tools）
 */
import type { AiProvider, ChatChunk, ChatOptions, Message } from './provider'
import { getOpenAIProvider } from './openai'
import { getAnthropicProvider } from './anthropic'
import { getMinimaxProvider } from './minimax'
import { getToolDefinitions } from './tools'
import log from '../log'
import { settingsRepo } from '../db/repositories/settings'
import { SETTINGS_KEY_APP, SETTINGS_KEY_AI, type AppSettings } from '../../shared/ipc/channels'
import { assertHostnameStillPublic } from '../lib/networkSafety'

/** 全局设置中 AI 段对应的 key（与 stores/settings.ts 中保存路径一致） */
const SETTINGS_KEY = SETTINGS_KEY_APP

/** 旧版 AITab 写入的 key，保留兼容 */
const LEGACY_AI_KEY = SETTINGS_KEY_AI

/** 所有支持的 Provider ID */
export type ProviderId = 'openai' | 'anthropic' | 'minimax'

interface LegacyAiCfg {
  provider: 'openai' | 'anthropic' | 'dual'
  model: string
}

type AiCfg = Pick<
  AppSettings,
  | 'aiProvider'
  | 'aiOpenaiModel'
  | 'aiAnthropicModel'
  | 'aiMinimaxModel'
  | 'aiOpenaiBaseUrl'
  | 'aiAnthropicBaseUrl'
  | 'aiMinimaxBaseUrl'
  | 'aiEnabled'
>

/**
 * 合并读取：
 *   - 主：app.settings（与 useSettingsStore 对齐）
 *   - 备：app.ai（早期 AITab 写入位置）
 *
 * legacy.provider === 'dual' 时取 openai 作为默认值；
 * 字段以主 key 为准。
 */
export async function loadAiConfig(): Promise<AiCfg & {
  aiOpenaiBaseUrl: string
  aiAnthropicBaseUrl: string
  aiMinimaxBaseUrl: string
}> {
  const all = await settingsRepo.getAll()
  const main = (all[SETTINGS_KEY] as Partial<AiCfg> | undefined) ?? {}
  const legacy = (all[LEGACY_AI_KEY] as Partial<LegacyAiCfg> | undefined) ?? {}

  // 推导主 provider
  let provider: AiCfg['aiProvider'] = main.aiProvider ?? null
  if (!provider && legacy.provider) {
    provider = legacy.provider === 'anthropic' ? 'anthropic' : 'openai'
  }

  // 推导 openai 模型
  let openaiModel = main.aiOpenaiModel ?? 'gpt-4o-mini'
  if (legacy.provider === 'openai' && legacy.model) openaiModel = legacy.model

  // 推导 anthropic 模型
  let anthropicModel = main.aiAnthropicModel ?? 'claude-3-5-sonnet-latest'
  if (legacy.provider === 'anthropic' && legacy.model) anthropicModel = legacy.model

  // 推导 minimax 模型
  let minimaxModel = main.aiMinimaxModel ?? 'MiniMax-M3'

  // baseURL：settings 表里读取，空串回退到默认
  const aiOpenaiBaseUrl = main.aiOpenaiBaseUrl ?? ''
  const aiAnthropicBaseUrl = main.aiAnthropicBaseUrl ?? ''
  const aiMinimaxBaseUrl = main.aiMinimaxBaseUrl ?? ''

  // enabled：只要任一边有 provider 就认为启用
  const enabled = main.aiEnabled ?? Boolean(provider)

  return {
    aiProvider: provider,
    aiOpenaiModel: openaiModel,
    aiAnthropicModel: anthropicModel,
    aiMinimaxModel: minimaxModel,
    aiOpenaiBaseUrl,
    aiAnthropicBaseUrl,
    aiMinimaxBaseUrl,
    aiEnabled: enabled,
  }
}

/** R7S-3 修复：所有合法的 provider id 白名单。任何不在这里的输入都抛错， 避免 typo / 恶意 IPC 把请求路由到 minimax 兜底 provider（默认会读取 minimax API key，可能触发意外的计费请求）。 */
export const ALLOWED_PROVIDER_IDS: readonly ProviderId[] = ['openai', 'anthropic', 'minimax'] as const

export function isValidProviderId(provider: unknown): provider is ProviderId {
  return (
    typeof provider === 'string' &&
    (ALLOWED_PROVIDER_IDS as readonly string[]).includes(provider)
  )
}

/** 选择 Provider：按 aiProvider 字段决定
 *
 *  R7S-3：传入字符串不在白名单时抛错，不再 fallthrough 到 minimax。
 *  这样上层调用方（ai-handlers / pickModel / chat / testConnection）能
 *  立刻收到明确的错误，而不是悄悄用错的 provider 扣 token。
 */
export function pickProvider(provider: ProviderId): AiProvider {
  if (!isValidProviderId(provider)) {
    throw new Error(`unknown provider id: ${String(provider)}`)
  }
  if (provider === 'openai') return getOpenAIProvider()
  if (provider === 'anthropic') return getAnthropicProvider()
  return getMinimaxProvider()
}

/** 获取所有可用 Provider 元数据（用于渲染端下拉） */
export function listProviders(): Array<{
  id: ProviderId
  name: string
  models: string[]
}> {
  return [
    { id: 'openai', name: getOpenAIProvider().name, models: getOpenAIProvider().listModels() },
    { id: 'anthropic', name: getAnthropicProvider().name, models: getAnthropicProvider().listModels() },
    { id: 'minimax', name: getMinimaxProvider().name, models: getMinimaxProvider().listModels() },
  ]
}

/** 选当前模型（按 provider） */
export async function pickModel(providerId: ProviderId): Promise<string> {
  const cfg = await loadAiConfig()
  if (providerId === 'openai') return cfg.aiOpenaiModel
  if (providerId === 'anthropic') return cfg.aiAnthropicModel
  return cfg.aiMinimaxModel
}

/**
 * 统一的 chat 调用入口：
 *   - 根据 provider ID 选择具体 Provider
 *   - 注入 tools（始终启用）
 *   - 返回 AsyncIterable<ChatChunk>
 *
 * 用法：
 *   for await (const chunk of aiRouter.chat(msgs, opts)) { ... }
 */
export async function* chat(
  messages: Message[],
  optsOverride?: Partial<ChatOptions>,
): AsyncIterable<ChatChunk> {
  const cfg = await loadAiConfig()
  if (!cfg.aiEnabled) {
    yield { type: 'error', message: 'AI 总开关未开启，请前往设置启用' }
    return
  }
  if (!cfg.aiProvider) {
    yield { type: 'error', message: '尚未选择 AI 提供商' }
    return
  }

  const providerId = cfg.aiProvider
  const provider = pickProvider(providerId)
  const defaultModel =
    providerId === 'openai'
      ? cfg.aiOpenaiModel
      : providerId === 'anthropic'
        ? cfg.aiAnthropicModel
        : cfg.aiMinimaxModel

  const opts: ChatOptions = {
    model: optsOverride?.model ?? defaultModel,
    temperature: optsOverride?.temperature ?? 0.3,
    maxTokens: optsOverride?.maxTokens ?? 2048,
    tools: optsOverride?.tools ?? getToolDefinitions(),
    callId: optsOverride?.callId,
    signal: optsOverride?.signal,
  }

  // R21 修复 (medium security)：DNS rebinding 防护 —— 在 chat 真正发起
  // 请求前再次解析目标 baseURL 主机，DNS 记录若已被改为内网则拒（详见
  // networkSafety.assertHostnameStillPublic）。仅对自定义 baseURL 做这层
  // 校验（默认端点不会变），null/空 / 默认 provider URL 跳过。
  const customBaseUrl =
    providerId === 'openai'
      ? cfg.aiOpenaiBaseUrl
      : providerId === 'anthropic'
        ? cfg.aiAnthropicBaseUrl
        : cfg.aiMinimaxBaseUrl
  if (customBaseUrl && customBaseUrl.trim()) {
    try {
      const parsed = new URL(customBaseUrl)
      await assertHostnameStillPublic(parsed.hostname)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      yield { type: 'error', message: `[ai/router] ${msg}` }
      return
    }
  }

  log.info(`[ai/router] dispatch -> ${providerId}/${opts.model}`)

  yield* provider.chat(messages, opts)
}

/**
 * 测试连接（不进入 chat 流）
 *
 * @param providerId  目标 provider（openai / anthropic / minimax）
 * @param model       当前用户选中的模型；为空时由 provider 自选最低成本的默认值
 *                    （确保提示文案「已连上模型 X」与用户实际选择一致）
 */
export async function testConnection(
  providerId: ProviderId,
  model?: string,
): Promise<{ ok: boolean; message?: string }> {
  const p = pickProvider(providerId)
  return p.testConnection(model)
}
