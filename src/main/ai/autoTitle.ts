/**
 * AI 对话标题自动生成
 *
 * 触发时机：首轮对话结束（assistant 已给出第一条回复，且对话标题仍是默认占位
 * 或为 null）—— 用 5-15 字概括主题。
 *
 * 失败回退：LLM 调用失败 / 超时 → 取首条 user 消息前 20 字作为标题。
 *
 * 实现位置：在 main/ai/stream.ts runStream 末尾触发（异步 fire-and-forget），
 * 不阻塞主对话流。标题生成完后通过 emit('title_updated') 把新标题推到渲染端。
 *
 * 与 persist 的关系：标题更新走 conversationsRepo.updateTitle() 单条 UPDATE，
 * 不参与 runStream 的事务 —— 即便 persist 失败、对话未落库，updateTitle 自身
 * 也是 idempotent（无 row → 0 changes，不抛错）。
 */
import { chat as routerChat } from './router'
import { conversationsRepo } from '../db/repositories/conversations'
import log from '../log'
import type { AiMessage } from '@shared/types/ai'

const TITLE_TIMEOUT_MS = 5_000
const FALLBACK_TITLE_MAX_CHARS = 20
const GENERATED_TITLE_MAX_CHARS = 30

/**
 * 判断是否应该触发自动标题生成。
 * 条件：
 *  - 对话标题为 null / 空 / 「新对话」占位（前端默认 placeholder）
 *  - 至少有 1 条 user + 1 条 assistant
 */
export function shouldAutoTitle(conv: {
  title: string | null
  messages: AiMessage[]
}): boolean {
  if (conv.title && !conv.title.startsWith('新对话')) return false
  let userCount = 0
  let assistantCount = 0
  for (const m of conv.messages) {
    if (m.role === 'user') userCount += 1
    else if (m.role === 'assistant' && m.content?.trim()) assistantCount += 1
  }
  return userCount >= 1 && assistantCount >= 1
}

/**
 * 用首条 user 消息前 N 字作为回退标题（去掉空白）。
 */
export function fallbackTitle(messages: AiMessage[]): string | null {
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return null
  const text = (firstUser.content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (text.length <= FALLBACK_TITLE_MAX_CHARS) return text
  return text.slice(0, FALLBACK_TITLE_MAX_CHARS) + '…'
}

/**
 * 截断 + 清理 LLM 返回的标题：去引号 / 换行 / 前缀（"标题："），截到 30 字。
 */
function sanitizeTitle(raw: string): string {
  let s = raw.trim()
  // 去成对引号 / 中文引号
  s = s.replace(/^["'""「」]+|["'""「」]+$/g, '')
  // 去前缀
  s = s.replace(/^(标题[:：]|Title[:：]?)\s*/i, '')
  // 去换行
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > GENERATED_TITLE_MAX_CHARS) s = s.slice(0, GENERATED_TITLE_MAX_CHARS) + '…'
  return s
}

/**
 * 构造 prompt：取前 2 条 user + 1 条 assistant，组装成「用 X 字概括」。
 */
function buildPrompt(messages: AiMessage[]): string {
  const recent: string[] = []
  let userCount = 0
  let assistantCount = 0
  for (const m of messages) {
    if (m.role === 'user' && userCount < 2) {
      recent.push(`用户: ${m.content.slice(0, 200)}`)
      userCount += 1
    } else if (m.role === 'assistant' && m.content?.trim() && assistantCount < 1) {
      recent.push(`助手: ${m.content.slice(0, 200)}`)
      assistantCount += 1
    }
    if (userCount >= 2 && assistantCount >= 1) break
  }
  return [
    '请用 5-15 个字概括以下对话的主题，作为对话标题。',
    '要求：直接给标题文字，不要加引号、不要加前缀、不要换行。',
    '',
    '对话内容：',
    ...recent,
  ]
    .filter(Boolean)
    .join('\n')
}

export interface ScheduleAutoTitleOptions {
  conversationId: string
  /** Provider 覆盖（不传则由 router 自动选） */
  providerId?: string
  model?: string
  /** 标题事件回调（推送到渲染端） */
  onTitle: (conversationId: string, title: string) => void
  /** Abort signal：流被中止时跳过 */
  signal?: AbortSignal
}

/**
 * 异步触发自动标题生成。失败 / 超时 → 立即用 fallback 标题。
 * 该函数 fire-and-forget，不抛错（异常吞到 log）。
 */
export function scheduleAutoTitle(opts: ScheduleAutoTitleOptions): void {
  // 异步执行，不阻塞主对话流
  void (async () => {
    try {
      await runAutoTitle(opts)
    } catch (err) {
      log.warn('[ai/autoTitle] failed', err)
    }
  })()
}

async function runAutoTitle(opts: ScheduleAutoTitleOptions): Promise<void> {
  const conv = await conversationsRepo.findById(opts.conversationId)
  if (!conv) return
  if (!shouldAutoTitle(conv)) return

  const prompt = buildPrompt(conv.messages)
  const abortCtl = new AbortController()
  const timeoutTimer = setTimeout(() => abortCtl.abort(), TITLE_TIMEOUT_MS)
  // 把外部 signal 一并接入：流被中止时也立刻放弃
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timeoutTimer)
      return await useFallback(conv.messages, opts)
    }
    opts.signal.addEventListener('abort', () => abortCtl.abort(), { once: true })
  }

  let accumulated = ''
  try {
    for await (const chunk of routerChat(
      [
        { role: 'system', content: '你是一个对话标题助手，只输出简短的对话标题，不超过 15 个汉字。' },
        { role: 'user', content: prompt },
      ],
      {
        temperature: 0.2,
        maxTokens: 64,
        // 不传 tools —— 标题生成不需要工具
        tools: [],
        signal: abortCtl.signal,
      },
    )) {
      if (chunk.type === 'text') accumulated += chunk.text
      else if (chunk.type === 'error') throw new Error(chunk.message)
    }
  } catch (err) {
    clearTimeout(timeoutTimer)
    log.warn('[ai/autoTitle] LLM call failed, falling back', err)
    return await useFallback(conv.messages, opts)
  }
  clearTimeout(timeoutTimer)

  let title = sanitizeTitle(accumulated)
  if (!title) {
    return await useFallback(conv.messages, opts)
  }

  // 二次校验：用户已经手动改过标题就跳过（避免覆盖人工命名）
  const fresh = await conversationsRepo.findById(opts.conversationId)
  if (!fresh) return
  if (!shouldAutoTitle(fresh)) return

  await conversationsRepo.updateTitle(opts.conversationId, title)
  opts.onTitle(opts.conversationId, title)
}

async function useFallback(
  messages: AiMessage[],
  opts: ScheduleAutoTitleOptions,
): Promise<void> {
  const title = fallbackTitle(messages)
  if (!title) return
  const fresh = await conversationsRepo.findById(opts.conversationId)
  if (!fresh) return
  if (!shouldAutoTitle(fresh)) return
  await conversationsRepo.updateTitle(opts.conversationId, title)
  opts.onTitle(opts.conversationId, title)
}