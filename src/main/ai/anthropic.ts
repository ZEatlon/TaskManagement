/**
 * Anthropic Provider（R22 重构）
 *
 * 客户端懒加载 / 流式 chat / testConnection / 错误处理等公共逻辑已抽到
 * anthropicCompatProvider.ts，本文件只剩 Provider 配置（ID / 鉴权方式 /
 * 模型列表 / 默认 baseURL）。后续 SDK 升级或安全修复只需改基类一处。
 *
 * 使用 @anthropic-ai/sdk 0.32.x，消息/工具转换走 anthropicCompat.ts。
 */
import { SECRET_KEYS } from '../security/keychain'
import {
  AnthropicCompatProvider,
  type AnthropicCompatConfig,
} from './anthropicCompatProvider'

/** Anthropic 静态可用模型列表 */
const ANTHROPIC_MODELS = [
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'claude-3-opus-latest',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
]

const ANTHROPIC_CONFIG: AnthropicCompatConfig = {
  id: 'anthropic',
  name: 'Anthropic',
  secretKey: SECRET_KEYS.ANTHROPIC_API_KEY,
  missingKeyMessage: 'Anthropic API Key 未配置，请前往设置页面填写',
  // Anthropic 不设 baseURL 则走 SDK 默认端点；settings 优先，无默认 fallback。
  resolveBaseURL: (cfg) => cfg.aiAnthropicBaseUrl,
  models: ANTHROPIC_MODELS,
  authMode: 'apiKey',
  logTag: 'anthropic',
  // 保持向后兼容：原 testConnection 兜底用 'claude-3-5-haiku-latest'
  defaultTestModel: 'claude-3-5-haiku-latest',
}

export class AnthropicProvider extends AnthropicCompatProvider {
  constructor() {
    super(ANTHROPIC_CONFIG)
  }
}

let _instance: AnthropicProvider | null = null
export function getAnthropicProvider(): AnthropicProvider {
  if (!_instance) _instance = new AnthropicProvider()
  return _instance
}