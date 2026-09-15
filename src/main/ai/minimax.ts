/**
 * MiniMax Provider（R22 重构）
 *
 * MiniMax 提供与 Anthropic Messages API 完全兼容的端点：
 *   - Base URL: https://api.minimaxi.com
 *   - Endpoint: POST /anthropic/v1/messages
 *   - Auth: Authorization: Bearer <API_KEY>
 *
 * 因此直接复用 @anthropic-ai/sdk 并覆盖 baseURL + authToken。
 * 消息/工具转换走 anthropicCompat.ts，客户端懒加载 / 流式 chat /
 * testConnection 全部走 anthropicCompatProvider.ts 的共用基类。
 *
 * 注意事项：
 *   - `thinking: { type: 'adaptive' }` 是 MiniMax-M3 的扩展参数，
 *     Anthropic 官方 SDK 的类型里没有声明，由基类按 thinkingModels
 *     列表自动附加（整体走 any 透传）。
 *   - MiniMax-M3 支持多模态（图片、视频），当前 UI 只走文本流，
 *     后续若加入图片附件可直接利用 SDK 的 image block。
 */
import { SECRET_KEYS } from '../security/keychain'
import {
  AnthropicCompatProvider,
  type AnthropicCompatConfig,
} from './anthropicCompatProvider'

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

const MINIMAX_CONFIG: AnthropicCompatConfig = {
  id: 'minimax',
  name: 'MiniMax',
  secretKey: SECRET_KEYS.MINIMAX_API_KEY,
  missingKeyMessage: 'MiniMax API Key 未配置，请前往设置页面填写',
  // 默认 baseURL 指向 MiniMax 的 Anthropic 兼容端点（含 /anthropic 子路径）；
  // 若用户在设置里填了自定义 baseURL，则覆盖。
  resolveBaseURL: (cfg) => cfg.aiMinimaxBaseUrl || MINIMAX_BASE_URL,
  models: MINIMAX_MODELS,
  thinkingModels: MINIMAX_THINKING_MODELS,
  authMode: 'authToken',
  logTag: 'minimax',
}

export class MinimaxProvider extends AnthropicCompatProvider {
  constructor() {
    super(MINIMAX_CONFIG)
  }
}

let _instance: MinimaxProvider | null = null
export function getMinimaxProvider(): MinimaxProvider {
  if (!_instance) _instance = new MinimaxProvider()
  return _instance
}