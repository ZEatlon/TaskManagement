/**
 * AI Provider 错误翻译工具（R40-fix-ai-raw-sdk-error medium）
 *
 * 历史：
 *   anthropicCompatProvider.testConnection / openai.ts.testConnection
 *   原版都直接 `return { ok: false, message: msg }`（msg = SDK 抛出的
 *   err.message），渲染端在「测试连接」面板直接渲染英文 SDK 文本
 *   （"Request failed with status code 401" / "Authentication Error: ..." /
 *   "Connection error" / "model_not_found"），与中文 UI 混杂、可读性差，
 *   且泄漏 SDK 实现细节。
 *
 * 设计：
 *   - 本函数只做 "技术错误 → 中文友好文案" 翻译，不抛错。
 *   - 调用方负责：原始 err 仍要进 log.error 留诊断痕迹。
 *   - 状态码 / 常见错误子串 / SDK 错误名 三层识别，命中规则按顺序短路。
 *   - 兜底："服务异常，请稍后重试" —— 永不把英文 / 技术栈文本透给用户。
 *
 * 适用范围：
 *   - OpenAI SDK（openai@4.x）：错误有 `status` 字段
 *   - Anthropic SDK（@anthropic-ai/sdk@0.32.x）：错误有 `status` 字段
 *   - fetch / undici 网络层抛的原生 Error（如 "fetch failed"）
 *
 * 不适用范围（保留原文）：
 *   - chat() 流式错误 —— R-fix-llm-error-vs-persist 之前本工具仅供
 *     testConnection 调用；chat() catch 块原版直接 yield 原始 err.message
 *     （"Request failed with status code 401" / "Authentication Error" /
 *     "fetch failed" 等英文 SDK 文本）→ 渲染端 banner 把英文 SDK 文案
 *     展示给用户，或被 stream.ts 错塞进 done.persistError 后被 ai.ts:917
 *     强制加 "对话未持久化（DB 写入失败）" 前缀，误导用户以为是 DB 故障。
 *     现已统一：chat() 与 testConnection 都走本工具翻译 + 打 reason='llm-error'，
 *     渲染端 banner 直接展示 message 即可，不再渲染英文 SDK 文本，
 *     也不再误报为持久化失败。
 *
 * 位置：本文件位于 src/shared/i18n/ 而非 main/ai/ —— 渲染端
 *   stores/ai.ts 同样需要把 setUserFacingError(err) 收口到这里，避免
 *   chat 流路径把英文 SDK 错误透传到 ChatPanel banner（见 R40-fix-2）。
 *   文件内容保持纯逻辑、零运行时依赖，便于两侧共用。
 */

interface SdkErrorLike {
  /** HTTP 状态码（OpenAI / Anthropic SDK 都会附） */
  status?: number
  /** 错误码（OpenAI: error.code；Anthropic: error.error?.type） */
  code?: string
  /** 错误类型（Anthropic: error.error?.type；OpenAI: error.type） */
  error?: { type?: string; message?: string } | { type?: string }
  /** 原始 message */
  message?: string
}

function asSdkError(err: unknown): SdkErrorLike {
  if (err && typeof err === 'object') {
    return err as SdkErrorLike
  }
  return {}
}

/**
 * 把 AI Provider 抛出的错误翻译成中文友好文案。
 *
 * @param err  来自 SDK 或网络层的原始错误对象
 * @param rawFallback  当 err 不是 Error 实例时（如 SDK 抛了个 string），用
 *                    这个字符串兜底；调用方可传 `String(err)`。
 *                    仅在日志 / 兜底文案里出现，绝不展示给用户。
 */
export function translateAiError(err: unknown, rawFallback = 'unknown error'): string {
  const e = asSdkError(err)
  const status = typeof e.status === 'number' ? e.status : undefined
  // SDK 错误类型字符串（Anthropic: 'authentication_error' / 'not_found_error'；
  // OpenAI: 'invalid_request_error' 等）
  const errType =
    e.error?.type ||
    (typeof e.code === 'string' ? e.code : undefined) ||
    (typeof (err as { type?: unknown })?.type === 'string'
      ? ((err as { type?: string }).type as string)
      : undefined)

  // 1) HTTP 状态码优先（最明确）
  if (status === 401 || status === 403) {
    return 'API Key 无效或已过期，请前往设置检查'
  }
  if (status === 404) {
    return '模型不存在或无权访问，请检查模型名称'
  }
  if (status === 413) {
    return '请求内容过大，请缩短输入或减少上下文'
  }
  if (status === 429) {
    return '请求频率过高或额度用尽，请稍后重试'
  }
  if (status !== undefined && status >= 500) {
    return 'AI 服务暂时不可用，请稍后重试'
  }
  if (status !== undefined && status >= 400) {
    return '请求被拒绝，请检查配置后重试'
  }

  // 2) SDK 错误类型名
  if (errType) {
    const t = errType.toLowerCase()
    if (t.includes('authentication') || t.includes('invalid_api_key')) {
      return 'API Key 无效或已过期，请前往设置检查'
    }
    if (t.includes('not_found') || t.includes('model_not_found')) {
      return '模型不存在或无权访问，请检查模型名称'
    }
    if (t.includes('rate_limit')) {
      return '请求频率过高，请稍后重试'
    }
    if (t.includes('permission')) {
      return '权限不足，请检查 API Key 授权范围'
    }
    if (t.includes('overloaded') || t.includes('server_error')) {
      return 'AI 服务暂时繁忙，请稍后重试'
    }
  }

  // 3) 网络层错误（fetch / undici / dns）
  const msg = (err instanceof Error ? err.message : '').toLowerCase()
  if (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg === 'connection error'
  ) {
    return '网络连接失败，请检查网络后重试'
  }
  if (msg.includes('abort') || msg.includes('aborted')) {
    return '请求已取消'
  }

  // 4) 兜底 —— 调用方可据此判断「是未知错误」并把 rawFallback 写进日志
  // 参考 rawFallback 仅用于日志，本返回值仍给中文兜底文案
  void rawFallback
  return 'AI 服务异常，请稍后重试'
}
