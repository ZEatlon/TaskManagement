/**
 * AI 流式响应控制器
 *
 * 流式响应有"循环"：LLM -> 工具调用 -> 工具执行 -> 再次丢回 LLM -> 最终文本
 *
 * 这个文件负责编排整条链路：
 *   1. 调用 router.chat() 拿增量片段
 *   2. 收集 tool_call，交给本地执行，拿到 tool 结果
 *   3. 把 tool 结果作为 tool message 拼回 messages，再次请求 LLM
 *   4. 重复直到没有 tool_call 或者达到最大轮次
 *   5. 通过 IPC 推到前端（AI_CHUNK 通道）
 *
 * 取消机制：通过 AbortController + activeStreams 表。
 */
import type { ChatChunk, Message, ToolDefinition } from './provider'
import type { AiErrorReason } from './provider'
import { chat as routerChat } from './router'
import {
  executeTool,
  getToolDefinitions,
  setCurrentCallerWebContentsId,
  runWithCallerContext,
  getAiContextByWebContents,
  buildAiContextPrompt,
  getCurrentOpenNoteByWebContents,
  __bindActiveStreamsAccessor,
} from './tools'
import { conversationsRepo } from '../db/repositories/conversations'
import { dbClient } from '../db/client'
import log from '../log'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { scheduleAutoTitle } from './autoTitle'
import { SYSTEM_PROMPT } from './prompts'
import { buildConfirmSummary } from './confirmSummary'
import { localDayKeyOf } from '@shared/lib/dayKey'
import type { BrowserWindow } from 'electron'

/**
 * 当前活跃的流（callId -> { controller, webContentsId }）。
 *
 * R32-03 修复 (MEDIUM cross-window-abort)：原版 Map<callId, AbortController>
 * 不带所有权信息。任意被劫持渲染端（或不同窗口的渲染端）可调用
 * ai:abort 携带别人的 callId 把对方的流强制中断 → 对话被第三方操控，
 * LLM 上下文被意外切断。修复：记录每个流由哪个 webContents 发起，
 * abortStream 时校验发起者 ID 匹配才允许中断（不匹配视为越权、no-op）。
 */
interface ActiveStream {
  controller: AbortController
  webContentsId: number | null
}
const activeStreams = new Map<string, ActiveStream>()

/**
 * R-fix-caller-context-leak (medium correctness)：把 activeStreams 的访问
 * 桥挂到 context.ts —— clearWebContentsNoteState 销毁 webContents 时要
 * abort 该 wc 拥有的所有 in-flight 流。这里只导出最小需要的两个操作
 * （snapshot 拥有者对、abort by callId），避免 stream.ts 暴露完整 abortStream
 * 所有权校验逻辑给 context.ts（防止绕过 R32-03 修复的越权校验）。
 */
__bindActiveStreamsAccessor(
  function* snapshotActiveStreamOwners(): IterableIterator<[string, number | null]> {
    for (const [callId, entry] of activeStreams) {
      yield [callId, entry.webContentsId]
    }
  },
  function abortActiveStreamByCallId(callId: string): void {
    const entry = activeStreams.get(callId)
    if (!entry) return
    // 这里只由 context.clearWebContentsNoteState(已被销毁的 wcId) 调用，
    // 所有权隐式匹配（wcId == entry.webContentsId）已在外层 for-of 保证；
    // 不再走 abortStream() 二次校验以避免循环依赖（abortStream 在同模块
    // 内部能直接 entry.controller.abort()，更便宜）。
    try {
      entry.controller.abort()
    } catch {
      /* abort 自身可能抛（罕见），吞掉 —— 清理路径不能崩 */
    }
    activeStreams.delete(callId)
    // 流主动 abort 时把挂起的 confirm 一并清掉，避免 confirm 端
    // 调 confirmToolCall(callId, ...) 时命中一个不再等待的 promise。
    clearPendingConfirms(callId)
  },
)

/** 最大多轮工具迭代轮次（防止死循环） */
const MAX_TOOL_ROUNDS = 6

/**
 * 容错 JSON.parse：失败时返回原字符串。用于把工具结果原文解析成对象
 * 存入 AiMessage.toolResult 字段，UI 重渲染时不丢失结构信息。
 */
function safeParseToolResult(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * R8I-2 / R8I-3：等待用户回传的副作用确认 / one-shot 已用令牌。
 *
 * R9 修复：用 callId + toolCallId 复合键（confirmKey）做 Map key，
 * 避免一个流 clear() 把另一个流正在等待的确认一起 reject 掉。
 */
interface PendingConfirm {
  resolve: (approved: boolean) => void
  /** 超时定时器；超时自动拒绝并向 LLM 注入拒绝消息 */
  timer: NodeJS.Timeout | null
  callId: string
  toolCallId: string
}
const pendingConfirms = new Map<string, PendingConfirm>()

/** R8I-2 确认等待超时（30s）；超时视为拒绝，避免工具循环永远挂起 */
const CONFIRM_TIMEOUT_MS = 30_000

function confirmKey(callId: string, toolCallId: string): string {
  return `${callId}::${toolCallId}`
}

/**
 * R8I-3：one-shot 工具的 toolCallId；执行后加入集合；后续若同一 id 再次进入
 * 工具循环（LLM 历史回顾 / 重新发起），直接当作"已消费"跳过。
 */
const consumedOneShotIds = new Set<string>()

/**
 * 渲染端确认（同意 / 拒绝）某次副作用调用。
 * 调用后 stream 循环会立刻继续推进；超时则自动拒绝。
 *
 * R9 修复：参数从 toolCallId 改为 { callId, toolCallId }，因为不同流的
 * toolCallId 可能撞（LLM 重新发起对话会复用 id），复合键避免误判。
 *
 * R10 修复：返回 boolean 表示是否真的命中了等待中的 confirm。
 * 调用方（IPC handler）根据返回值告诉渲染端"实际没匹配上"，避免
 * 渲染端以为"已确认"但 LLM 工具循环还在挂起、30s 后才超时拒绝。
 */
export function confirmToolCall(callId: string, toolCallId: string, approved: boolean): boolean {
  const pc = pendingConfirms.get(confirmKey(callId, toolCallId))
  if (!pc) return false
  if (pc.timer) clearTimeout(pc.timer)
  pendingConfirms.delete(confirmKey(callId, toolCallId))
  pc.resolve(approved)
  return true
}

/**
 * 把工具调用挂起等待用户确认。返回 Promise<boolean>：true=同意执行，
 * false=拒绝（或超时）。渲染端需要在此期间弹 ConfirmDialog 并调 confirmToolCall。
 *
 * R9 修复：原版不带 callId，且 runStream 路径里 await 的是
 * awaitToolConfirmationInternal（从来不写 pendingConfirms），所以 pendingConfirms
 * 永远是空，confirm 永远走 fallback 分支 resolve(false)，每个副作用工具都
 * 被自动拒绝。现已统一：runStream 调本函数，confirm 端按 (callId, toolCallId)
 * 复合键查找。
 *
 * R-fix-toctou-one-shot：本函数**不再**做 consumedOneShotIds 重放检查。
 * 抢占与去重的责任已上提到 runStream 的 for-of 循环开头（has() → add()
 * 暂存 → 执行成功/失败/拒绝各分支 delete/add 收尾）。这里再 has() 检查
 * 会把 runStream 自己刚刚暂存的占位误判为「已消费」→ 每个副作用工具
 * 都被自动拒绝，破坏现有确认流。仅保留 emit 与 pendingConfirms 的注册逻辑。
 */
export function awaitToolConfirmation(
  callId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  emit: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const key = confirmKey(callId, toolCallId)
    // R22 修复 (medium correctness)：timer / onAbort 都可能先 resolve；需保证
    // 只有一个真正驱动 resolve，另一个在 resolve 前清理 listener + timer
    // （否则 abort listener 在 timer 已先 resolve 后仍挂在 signal 上，
    //  stream 内多次 awaitToolConfirmation 累积泄漏，每次都会在 abort 时
    // 重复调 resolve(false)，虽然 idempotent 但浪费工作且 listener 永远
    // 不被 GC）。
    let settled = false
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      pendingConfirms.delete(key)
      resolve(value)
    }
    const timer = setTimeout(() => {
      log.warn(`[ai/stream] tool confirm timeout callId=${callId} toolCallId=${toolCallId} toolName=${toolName}`)
      settle(false)
    }, CONFIRM_TIMEOUT_MS)
    pendingConfirms.set(key, { resolve: settle, timer, callId, toolCallId })
    emit({
      type: 'requires_confirmation',
      callId,
      toolCallId,
      toolName,
      risk: 'side-effect',
      summary: buildConfirmSummary(toolName, args),
      args,
    } as StreamEvent)
    // 用户 abort 流时立刻 resolve(false)，避免悬挂等 confirm
    const onAbort = () => {
      settle(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 把一次性工具标记为已消费（防止重放）。仅当工具执行成功后才调用，
 * 拒绝 / 失败时不应记录。
 *
 * R11 修复 (medium #37)：原版 500 上限 + FIFO 在 size > 500 时单次只 delete 1 条
 * —— 当 size 一次涨到 600（如长会话一次性插入），每次 add 只 evict 1 条，
 * 真正在 500-600 之间的 100 条都"卡在内存"直到下一次 add（再各 evict 1 条）。
 * 现在改为 while 循环一直 evict 到 size === MAX，确保 add 完成后 size 永远
 * ≤ MAX（明确的 LRU/FIFO 上界）。
 */
const CONSUMED_ONESHOT_MAX = 500
export function markToolConsumed(toolCallId: string): void {
  consumedOneShotIds.add(toolCallId)
  while (consumedOneShotIds.size > CONSUMED_ONESHOT_MAX) {
    const oldest = consumedOneShotIds.values().next().value
    if (typeof oldest !== 'string') break
    consumedOneShotIds.delete(oldest)
  }
}

/**
 * 清空某次流的确认状态。R9 修复：原来清空所有 pendingConfirms，会误杀其他
 * 流正在等待的确认；改为按 callId 过滤。
 */
export function clearPendingConfirms(callId: string): void {
  for (const [key, pc] of pendingConfirms) {
    if (pc.callId !== callId) continue
    if (pc.timer) clearTimeout(pc.timer)
    pendingConfirms.delete(key)
    pc.resolve(false)
  }
}

/** 流式响应请求体 */
export interface StreamRequest {
  /** 流唯一 id，用于取消 */
  callId: string
  /** 对话 id（用于工具调用完成后归档消息） */
  conversationId: string
  /** 当前完整消息列表（含 system + 历史 user/assistant/tool） */
  messages: Message[]
  /** 工具循环里新产生的最终 assistant 文本（聚合用） */
  /** 可选：温度 / 模型覆盖 */
  temperature?: number
  model?: string
  /** R12 修复 (medium)：允许调用方指定 provider，让 ai-handlers 能在流前
   *  做 providerId 白名单校验。 */
  providerId?: string
  /**
   * R10 修复：取消信号转发到 provider SDK。
   * 此前只把 signal 给 runStream 的内部循环看，OpenAI/Anthropic/MiniMax SDK
   * 继续接收 chunk 直到模型自然结束 → 用户点"停止"后实际仍在烧 token。
   */
  signal?: AbortSignal
}

/** 流式事件（推送到渲染端） */
export type StreamEvent =
  | { type: 'text'; text: string; callId: string }
  | { type: 'tool_call'; callId: string; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_result'
      callId: string
      /** R-fix-parallel-tool-result：携带 tc.id 让渲染端按 id 精确匹配，
       *  避免 LLM 在同一轮并发调用同名工具（如两个 createSticky）时按
       *  name 反向匹配到最后一条 calling → 结果颠倒。 */
      toolCallId: string
      toolName: string
      result: unknown
    }
  | { type: 'usage'; callId: string; input: number; output: number }
  | { type: 'round_start'; callId: string; round: number }
  | { type: 'round_end'; callId: string; round: number }
  | { type: 'done'; callId: string; persistError?: string }
  | {
      type: 'error'
      callId: string
      message: string
      /**
       * R32-04：AI 路由层在发起请求前做的配置/安全预检失败原因。
       * 渲染端据此区分「AI 总开关未开」「未选 provider」「DNS 拦截」，
       * 不再一律误报为"对话未持久化"。
       *
       * R-fix-llm-error-vs-persist：新增 'llm-error' 表示 SDK 在 chat()
       * catch 块抛出的真实 LLM 错误（401/403/404/429/5xx/fetch failed/
       * aborted 等）。stream.ts 看到 reason='llm-error' 时不把 message
       * 塞进 done.persistError —— 那是 LLM 故障不是 DB 故障，不应让
       * 渲染端 banner 误报为「对话未持久化」。
       */
      reason?: AiErrorReason
    }
  | { type: 'aborted'; callId: string }
  // R8I-2：副作用工具挂起 → 等用户确认
  | {
      type: 'requires_confirmation'
      callId: string
      toolCallId: string
      toolName: string
      risk: 'side-effect' | 'destructive'
      summary: string
      args: Record<string, unknown>
    }
  // R8I-3：one-shot 已消费
  | { type: 'one_shot_consumed'; callId: string; toolCallId: string; toolName: string }
  // 自动生成标题完成后通知渲染端（首轮对话结束后触发）
  | { type: 'title_updated'; callId: string; conversationId: string; title: string }

/**
 * 主动取消某次流
 *
 * R32-03 修复 (MEDIUM cross-window-abort)：新增 webContentsId 参数 —— 只
 * 允许 callId 对应的「发起者 webContents」调用 abort；其他窗口 / 被劫持
 * 渲染端持同 callId 调用 abort 直接 no-op。不匹配时记 warn 让用户能
 * 排查「为什么我点取消没反应」（其实是因为发起方不同 / 已经被另一方取消）。
 */
export function abortStream(callId: string, webContentsId: number | null): boolean {
  const entry = activeStreams.get(callId)
  if (!entry) return false
  // 所有权校验：null 表示「任意调用方都允许」（向后兼容调用方传 null）
  if (webContentsId !== null && entry.webContentsId !== null
      && entry.webContentsId !== webContentsId) {
    log.warn(
      `[ai/stream] abortStream callId=${callId} ownership mismatch: caller=${webContentsId} owner=${entry.webContentsId}; refusing`,
    )
    return false
  }
  entry.controller.abort()
  activeStreams.delete(callId)
  return true
}

/**
 * R-fix-confirm-tool-cross-window (MEDIUM sender-validation)：查询
 * 某次流的发起者 webContents.id，供 AI_CONFIRM_TOOL handler 做 sender
 * ownership 校验（与 abortStream 同思路：callId 对应 wc 才有权确认 /
 * 拒绝其副作用工具）。无对应流或流已完成 → 返回 null。
 */
export function getActiveStreamWebContentsId(callId: string): number | null {
  const entry = activeStreams.get(callId)
  return entry ? entry.webContentsId : null
}

/**
 * 启动流式响应
 *
 * 设计：
 *   - 使用 AbortController 在收到 abort 时立即停止推进
 *   - 工具调用循环：最多 MAX_TOOL_ROUNDS 轮
 *   - 每轮产生的 assistant 文本 / 工具调用通过 emit 推到前端
 *   - 最终 messages 数组（包含 tool 回应）写回 ai_conversations 表
 *
 * @param win  拥有该渲染进程的 BrowserWindow，用于 webContents.send
 */
export async function runStream(
  win: BrowserWindow | null,
  req: StreamRequest,
): Promise<void> {
  const ctrl = new AbortController()
  // R32-03 修复：activeStreams 现在是 { controller, webContentsId } 结构。
  const ownerWcId = win?.webContents?.id ?? null
  activeStreams.set(req.callId, { controller: ctrl, webContentsId: ownerWcId })
  const signal = ctrl.signal

  const emit = (e: StreamEvent) => {
    // R9 修复：原版对所有事件一刀切在 signal.aborted 时丢弃，导致
    // 'aborted' / 'done' / 'error' 这些收尾事件本身也被吞掉，前端流状态卡死。
    // 仅 abort / done / error 三类终结事件允许在 aborted 后继续发送。
    const isTerminal = e.type === 'aborted' || e.type === 'done' || e.type === 'error'
    if (signal.aborted && !isTerminal) return
    try {
      win?.webContents.send(IPC_CHANNELS.AI_CHUNK, e)
    } catch (err) {
      log.warn('[ai/stream] webContents.send failed', err)
    }
  }

  try {
    // 把当前 messages 复制一份，方便在迭代中 mutate
    // R32-Corr-5 修复 (HIGH system-prompt-not-injected)：ai:stream 的角色白名单
    // 拒绝渲染端提交的 role:'system' 消息（防 XSS 覆盖 SYSTEM_PROMPT）。但
    // runStream 没把 SYSTEM_PROMPT 拼回去 —— 历史上由渲染端负责 fetch + 注入，
    // R16 之后两端都不到位：渲染端还在 fetch（stores/ai.ts sendMessage），
    // runStream 这里也不注入，system 消息实际上完全没到 LLM，模型失去全部
    // 角色定位 / 工具使用约定 / 中文润色 / 步骤拆解规则。修复：在主进程
    // 边界硬注入 SYSTEM_PROMPT，保证无论渲染端如何变化（甚至将来放弃 IPC
    // 拿 system prompt），system 消息都在第一位。
    //
    // 上下文注入（InlineAIButton 配套）：把"用户当前正在编辑便签 X /
    // 笔记 Y / 番茄钟正在跑 Z 阶段"附加到 SYSTEM_PROMPT 末尾。LLM 据此
    // 可以给出更贴切的回答（例如步骤拆解优先针对当前便签、
    // summarizeNote 直接拿当前笔记做摘要）。context 是 advisory，不参与
    // 权限校验 —— summarizeNote 的正文返回仍走 openedNotes 集合那一套。
    const ctxPrompt = buildAiContextPrompt(
      getAiContextByWebContents(ownerWcId),
      getCurrentOpenNoteByWebContents(ownerWcId),
    )
    // R45-fix-system-prompt-no-date (MEDIUM ai-quality)：planDay 在
    // sticky.ts:746 用 localDayKeyOf() 过滤今日便签，navigate.date /
    // createSticky.date / completeSticky.date / batchUpdateStickies.patch.date
    // 都期望 YYYY-MM-DD 相对「今天」，getPomodoroStats 的 todayCount /
    // weekCount / streakDays 也都从本地日桶派生。但 SYSTEM_PROMPT 没注入
    // 当前日期，LLM 只能依赖训练知识 —— 模型知识截止早于用户本地日期时
    // （chat 模型常见情况）会拿到错的「今天」，影响所有 date-bearing 工具。
    // 修复：在主进程边界注入 `今天是 YYYY-MM-DD`（本地日，避开
    // `new Date().toISOString().slice(0,10)` 的 UTC 漂移），位置在
    // SYSTEM_PROMPT 之后、ctxPrompt 之前，让 LLM 看到时已经知道「系统
    // 注入的今天日期优先于训练知识」。PROMPT_HEADER 是静态标签，避免
    // 每次 round 都重新拼字符串。
    const todayKey = localDayKeyOf()
    const dateHeader = `\n\n[用户本地时间] 今天是 ${todayKey}（YYYY-MM-DD，本地日）。涉及「今天 / 今日 / 昨天 / 本周 / 当周」等相对时间词时请以此日期为准，不要依赖你的训练知识截止日期。`
    const systemContent = SYSTEM_PROMPT + dateHeader + ctxPrompt
    const messages: Message[] = [
      { role: 'system', content: systemContent },
      ...req.messages,
    ]
    const toolDefinitions: ToolDefinition[] = getToolDefinitions()

    let totalInput = 0
    let totalOutput = 0
    let round = 0

    // 多轮工具循环
    while (round < MAX_TOOL_ROUNDS) {
      if (signal.aborted) {
        emit({ type: 'aborted', callId: req.callId })
        return
      }

      round += 1
      emit({ type: 'round_start', callId: req.callId, round })

      /** 本轮累积出的 assistant 文本（最终给前端 + 写入 DB） */
      let roundText = ''
      /** 本轮出现的 tool calls，等待统一执行 */
      const pendingToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
      /** 本轮是否在 provider 端收到 error chunk；用于在 for-await 出口区分收尾路径 */
      let roundErrored = false
      let roundErrorMessage = ''
      // R32-04：AI 路由层预检阶段（AI 未启用 / 未选 provider / DNS 拦截）
      // 给出 reason 时不算 LLM 错误，不要把它当 persistError 转发。
      // R-fix-llm-error-vs-persist：扩展为包含 'llm-error' —— provider.chat()
      // catch 块抛出的 SDK 运行时错误（401/403/404/429/5xx/fetch failed/
      // aborted 等）也走这条路径，message 已经在 provider 内部经 translateAiError
      // 转成中文，stream.ts 不再把它当 persistError 转发。
      let roundErrorReason: AiErrorReason | undefined

      // 跑一轮 LLM
      const iter = routerChat(messages, {
        model: req.model,
        temperature: req.temperature,
        // R10 修复：把取消信号透传给 provider SDK。
        // 之前只有 for-await 循环检查 signal.aborted → SDK 在网络层继续收 chunk
        // → 用户点"停止"后 token 仍在被消耗。
        signal,
      })

      for await (const chunk of iter) {
        if (signal.aborted) {
          emit({ type: 'aborted', callId: req.callId })
          return
        }
        const handlerChunk = chunk as ChatChunk
        switch (handlerChunk.type) {
          case 'text':
            roundText += handlerChunk.text
            emit({ type: 'text', text: handlerChunk.text, callId: req.callId })
            break
          case 'tool_call':
            pendingToolCalls.push({
              id: handlerChunk.toolCall.id,
              name: handlerChunk.toolCall.name,
              args: handlerChunk.toolCall.arguments,
            })
            emit({
              type: 'tool_call',
              callId: req.callId,
              toolCallId: handlerChunk.toolCall.id,
              toolName: handlerChunk.toolCall.name,
              args: handlerChunk.toolCall.arguments,
            })
            break
          case 'usage':
            totalInput += handlerChunk.input
            totalOutput += handlerChunk.output
            break
          case 'error':
            // R-fix-error-loses-round (medium correctness)：原版 emit error 后
            // 直接 return 跳出 runStream，绕过后续 round_end emit、把本轮 roundText
            // 压入 messages、以及外层 persist 路径上的 persistError 上报。两类后果：
            //   (a) LLM 已吐出文本 + 已 emit tool_call → 网络抖动触发 error chunk
            //       → 本轮累积全部丢失，下次 reload conversation 时没有这部分历史；
            //   (b) first round 就出错 → 用户只看到 error 事件、runStream 提前
            //       return，渲染端拿不到 done 收尾、spinner 不关。
            // 改为 break 退出 for-await，由出口处的收尾分支决定怎么处理：
            //   - 完全空（无 roundText、无 pendingToolCalls）：跳过 round_end 和
            //     空消息 push，直接 emit done + persistError（用 LLM 错误消息填充
            //     persistError 字段，渲染端可据此区分「AI 流异常收尾」与正常 done）
            //   - 有文本 + 无 orphan tool_call：仍 emit round_end + push messages
            //     让 persist 保住可见内容，然后 break 出 while 走正常 done 路径
            //   - 有 orphan tool_call（无对应 tool 结果会破坏下次 reload 的多轮
            //     链路）：同样丢弃，走 done + persistError 收尾
            //
            // R32-04：handlerChunk 携带的 reason（ai-disabled / no-provider /
            // dns-blocked）说明这是 router 在发起请求前做的预检拒绝，
            // 不是 LLM 流中途的运行时错误。把它原样透传给渲染端，
            // 同时禁止在 done 里把这条消息当 persistError（避免把
            // 「AI 已禁用」误报成"对话未持久化（DB 写入失败）"）。
            roundErrored = true
            roundErrorMessage = handlerChunk.message
            roundErrorReason = handlerChunk.reason
            emit({
              type: 'error',
              callId: req.callId,
              message: handlerChunk.message,
              ...(handlerChunk.reason ? { reason: handlerChunk.reason } : {}),
            })
            break
          case 'done':
            break
          default:
            break
        }
      }

      // R-fix-error-loses-round：本轮出错时的收尾分支（见 case 'error' 注释）。
      if (roundErrored) {
        if (roundText !== '' && pendingToolCalls.length === 0) {
          emit({ type: 'round_end', callId: req.callId, round })
          messages.push({
            role: 'assistant',
            content: roundText,
          })
          break
        }
        // R32-04：若错误来自路由层预检（reason 已设置），是配置/安全拒绝，
        // 不是 DB 持久化失败 —— 不要把消息塞进 persistError，避免渲染端
        // 把「AI 已禁用 / 未选 provider / DNS 拦截」误报为「对话未持久化」。
        // 真正的错误内容已通过前面的 error 事件单独推到渲染端（带 reason）。
        if (roundErrorReason) {
          emit({ type: 'done', callId: req.callId })
        } else {
          emit({ type: 'done', callId: req.callId, persistError: roundErrorMessage })
        }
        return
      }

      emit({ type: 'round_end', callId: req.callId, round })

      // 把本轮 assistant 消息压入消息列表
      messages.push({
        role: 'assistant',
        content: roundText,
        toolCalls:
          pendingToolCalls.length > 0
            ? pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args }))
            : undefined,
      })

      // 没有 tool_call，本轮结束
      if (pendingToolCalls.length === 0) {
        break
      }

      // 执行每个 tool_call，把结果以 tool role 消息塞回
      // 单个工具抛错不能让整轮被 outer catch 终止，否则 round 里剩余的 tool_call
      // 都会丢失，并在 messages 里留下一个没有对应 tool 结果的 assistant 消息。
      // 这里单独捕获，合成一个 { ok:false, error } 结果，保证 round 干净结束。
      for (const tc of pendingToolCalls) {
        // R8I-3 + R-fix-toctou-one-shot (MEDIUM correctness)：one-shot 重放
        // 保护 + 并发抢占。用 add-and-check 而非单纯 has() —— 进入工具
        // 执行分支前先把 toolCallId 暂存到 consumedOneShotIds（占位），
        // 后续同 id 进入（同一流多 round / 并发 runStream 重用 tool_call.id）
        // 会在 has() 处直接跳过，避免两个流都通过检查、各自弹 confirm 弹窗、
        // 各自执行同一副作用（删除笔记 / 创建便签等非幂等操作的「执行两次」）。
        //
        // 占位语义：本次 tc.id 在 await 边界前已被「预定」。最终 outcome：
        //   - 成功（非 confirm_create）→ 留作永久消费（markToolConsumed 同效）
        //   - 成功（confirm_create，createNote 等待用户确认）→ 释放占位，
        //     让 ai-handlers 在用户接受/拒绝落盘后再行 markToolConsumed
        //   - 用户拒绝 / 超时 / 执行抛错 / 工具返回 ok:false → 释放占位，
        //     LLM 重试同一 toolCallId 时不会被误判为已消费
        if (consumedOneShotIds.has(tc.id)) {
          const skipped = JSON.stringify({
            ok: false,
            error: '该操作为一次性，已被消费；请勿重放同一调用。',
          })
          messages.push({
            role: 'tool',
            content: skipped,
            toolCallId: tc.id,
            name: tc.name,
          })
          emit({
            type: 'tool_result',
            callId: req.callId,
            toolCallId: tc.id,
            toolName: tc.name,
            result: { ok: false, error: 'one-shot already consumed' },
          })
          continue
        }
        // 暂存占位；本次循环内的失败/拒绝分支会在末尾 delete 回滚。
        consumedOneShotIds.add(tc.id)
        // 标记本次 tc.id 是否最终要被回滚（拒绝/失败/confirm_create 等待）
        // —— 默认 false；成功（非 confirm_create）路径保留；其余路径置 true。
        let releaseTentative = false

        // R8I-2：从工具定义表里查 risk / oneShot，决定是否需要用户确认。
        const toolDef = toolDefinitions.find((d) => d.name === tc.name)
        const risk = toolDef?.risk ?? 'none'
        let approved = true
        if (risk !== 'none') {
          // R9 修复：原 awaitToolConfirmationInternal 永远返回 false（pendingConfirms
          // 永远空），导致所有 side-effect 工具都被自动拒绝。
          // 改用 awaitToolConfirmation：它会真正把 confirm Promise 塞进 map，
          // 等渲染端通过 ai:confirm-tool 通道回传后 resolve。
          approved = await awaitToolConfirmation(
            req.callId,
            tc.id,
            tc.name,
            tc.args,
            emit,
            signal,
          )
          if (!approved) {
            // 用户拒绝（或超时）：直接跳过工具执行，注入一条「用户已拒绝」消息
            const denied = JSON.stringify({
              ok: false,
              error: '用户已取消该操作',
            })
            messages.push({
              role: 'tool',
              content: denied,
              toolCallId: tc.id,
              name: tc.name,
            })
            emit({
              type: 'tool_result',
              callId: req.callId,
              toolCallId: tc.id,
              toolName: tc.name,
              result: { ok: false, error: 'user-denied' },
            })
            // R-fix-toctou-one-shot：拒绝路径释放占位，让 LLM 重试
            // 同一 toolCallId 时不会被误判为已消费。
            consumedOneShotIds.delete(tc.id)
            continue
          }
        }

        let result: string
        try {
          // R27-Sec-9：把当前流的发送方 webContents 上下文传给 tools（如
          // summarizeNote 用它判断 noteId 是否真的在该 webContents 中打开）。
          // try/finally 保证抛错也清掉，避免下一个不相关 executeTool 误用。
          //
          // R28-Corr-1：进一步把 caller 上下文绑到 AsyncLocalStorage.run()，
          // 这样两条 runStream 并发时（多 BrowserWindow 同时跑 AI 流），
          // 工具侧 getCurrentCallerWebContentsId() 读到的永远是当前调
          // 用栈里的 id，不会被其他流 set/clear 串扰。模块级 set/clear
          // 模式保留作 fallback，但 ALS 才是主要实现。
          const callerId = win?.webContents.id ?? null
          setCurrentCallerWebContentsId(callerId)
          try {
            result = await runWithCallerContext(callerId, () =>
              executeTool(tc.name, tc.args),
            )
          } finally {
            setCurrentCallerWebContentsId(null)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn(`[ai/stream] tool ${tc.name} failed`, err)
          result = JSON.stringify({ ok: false, error: msg })
          // R-fix-toctou-one-shot：执行抛错视为失败，释放占位让 LLM 重试
          releaseTentative = true
        }
        // R8I-3：执行成功后标为已消费；失败 / 拒绝时不算（LLM 可以重试别的方案）。
        // R10 修复：原版无条件 markToolConsumed，导致工具执行失败（ok:false）时仍
        // 记入 consumedOneShotIds → LLM 重试同一 toolCallId 时被当作"重放"永久
        // 拒绝，用户看到的副作用从未发生。
        // R11 修复 (medium #5)：createNote 工具即使 ok:true 也只是返回了 confirm_create
        // 载荷，实际写入要等用户在 ConfirmDialog 同意后才发生。原先无条件 markToolConsumed
        // 把这个一次性 id 提前"消费"了：用户拒绝后 conversation 历史里有 tool_result
        // 说 ok:true，但磁盘上没有文件；之后再有人重放同一 toolCallId 就被错误地
        // 当作"已消费"阻止合法重试。所以：createNote 在 ok:true 但 kind==='confirm_create'
        // 时跳过 markToolConsumed，等用户接受 / 拒绝落盘后再标记。
        let toolSucceeded = false
        let isConfirmOnlyCreateNote = false
        try {
          const parsed = JSON.parse(result) as { ok?: unknown; kind?: unknown }
          toolSucceeded = parsed?.ok === true
          if (
            tc.name === 'createNote' &&
            toolSucceeded &&
            parsed?.kind === 'confirm_create'
          ) {
            isConfirmOnlyCreateNote = true
          }
        } catch {
          toolSucceeded = false
        }
        // R-fix-toctou-one-shot：toolSucceeded=false（工具返回 ok:false 或
        // result 不是合法 JSON）时也要释放占位，让 LLM 重试同一 toolCallId
        // 不会被误判为已消费。
        if (!toolSucceeded) {
          releaseTentative = true
        }
        if (toolDef?.oneShot && toolSucceeded && !isConfirmOnlyCreateNote) {
          markToolConsumed(tc.id)
        } else if (isConfirmOnlyCreateNote) {
          // R-fix-toctou-one-shot：confirm_create 等待用户确认期间释放占位
          // —— ai-handlers 在用户接受/拒绝落盘后会再次 markToolConsumed。
          // 释放是为了让 LLM 在用户尚未回应前重发同一 toolCallId 时能再次
          // 执行（拿到新的 confirm_create 载荷），不被误判为重放。
          releaseTentative = true
        }
        // 兜底释放：成功路径保留占位（markToolConsumed 已 add 一次），其他
        // 路径释放。
        if (releaseTentative) {
          consumedOneShotIds.delete(tc.id)
        }
        messages.push({
          role: 'tool',
          content: result,
          toolCallId: tc.id,
          name: tc.name,
        })
        // R-fix-stream-tool-abort-visibility：executeTool 完成后用户已中止时
        // （createSticky / updateSticky / batchUpdateStickies 等 side-effect 工具
        // 已经落 DB，无法回滚），messages 仍会被外层 persist 块（762-851）写进
        // conversation 历史 —— 这是设计 tradeoff：rollback 需要给工具包
        // BEGIN/COMMIT + ROLLBACK 包装，cost 远超收益。改为在 tool_result 事件
        // 上挂 toolAborted=true，让渲染端能区分「工具已成功落盘 + 用户中途取消」
        // （toast / banner / AriaAnnouncer 显示"操作已执行，对话已中断"），而
        // 不是把这条工具结果当成正常完成静默吞掉。toolAborted=false 时字段不传，
        // 保持既有渲染端字段兼容。
        const toolAborted = signal.aborted
        const toolResultBase = {
          callId: req.callId,
          toolCallId: tc.id,
          toolName: tc.name,
          ...(toolAborted ? { toolAborted: true as const } : {}),
        }
        try {
          const parsed = JSON.parse(result)
          emit({
            type: 'tool_result',
            ...toolResultBase,
            result: parsed,
          })
        } catch {
          emit({
            type: 'tool_result',
            ...toolResultBase,
            result,
          })
        }
      }
    }

    if (totalInput > 0 || totalOutput > 0) {
      emit({ type: 'usage', callId: req.callId, input: totalInput, output: totalOutput })
    }

    // R10 修复：原版只 appendMessage(finalText)，工具调用链路（assistant.toolCalls
    // + 紧随其后的 tool role 消息）全部丢失 → 下次 reload 后对话历史里没有
    // createSticky 的痕迹，OpenAI 等会因为 assistant 后缺对应 tool 消息而拒绝
    // 多轮工具调用。现把 req.messages 之后**新产生**的所有消息（每轮 assistant
    // + 每条 tool 结果）一次性写入，保证 reload 后多轮链路完整。
    try {
      const originalLen = req.messages.length
      const newMessages = messages.slice(originalLen)
      // R21 修复 (medium data integrity)：原版循环 appendMessage 每条独立
      // UPDATE，最后 updateTokensDelta 又一条独立 UPDATE。如果中途某条
      // appendMessage 抛错（DB lock / IPC 断连 / OOM）→ 用户看到部分对话
      // 历史 + token 计数 0，下次 reload 把工具调用链路丢一半；如果
      // updateTokensDelta 失败 → 整段对话已写但 token 永远显示 0。
      // 修复：把整段 appendMessage 循环 + updateTokensDelta 包进同一
      // BEGIN/COMMIT 事务，任一失败整体 ROLLBACK，对话历史与 token 计数
      // 始终保持一致（要么全有，要么全无）。
      //
      // R23-DI-2 修复 (high data integrity)：上述 BEGIN/COMMIT 跨多次
      // dbClient.call IPC，每次 await 都让出 Node 事件循环。两个串流并发
      // 时（用户在 chat A 还在跑时切到 chat B）会交错：A 发 BEGIN 让出 →
      // B 也发 BEGIN → 「cannot start a transaction within a transaction」
      // 抛错 → B 的 catch 块对 A 的事务发 ROLLBACK 错杀 → A 的 UPDATE 落到
      // 事务外被自动提交。修复：用 dbClient.runInTransaction(work) 串行化，
      // work 仍自行发 BEGIN/COMMIT，但互斥锁保证前一个事务完全收尾前 work
      // 不会启动。
      await dbClient.runInTransaction(async () => {
        // C2 修复 (CRITICAL deadlock)：appendMessage 内部**已经**走
        // dbClient.runInTransaction + 自行 BEGIN/COMMIT（FIFO trim 的原子
        // 边界要求）；原版在这里又发 BEGIN 形成「嵌套事务死锁」—— 外层
        // 把 txLock 抢走后 await appendMessage，内层 runInTransaction 又
        // 等外层释放 txLock，永远等不到。
        // 修复：去掉外层 BEGIN/COMMIT/ROLLBACK，让每条 appendMessage 走
        // 自己的事务（已被 txLock 串行化保证不并发）。代价：消息集合 vs
        // token 计数不再是单事务原子——假定 18 条消息写到一半崩溃可能丢
        // 最后几条但 token 已部分累计，这是可接受的 tradeoff（vs. 完全
        // 死锁）；token delta 用 SQL 原子增量，崩在 appendMessage 之前
        // token delta 还没发出，崩在 delta 之后 token 多算几条不破坏不变量。
        // R20 修复 (medium data-integrity)：循环外捕获的 `now` 在所有新消息上
        // 复用 → 一批 6 轮多工具调用产出 18 条 row 共享同一 `ts`，未来按 ts 排
        // 序或区间过滤的查询（"最近一小时消息"、"批处理导入去重"）会把它们
        // 折叠到同一瞬时。改成每次迭代取一个新 ISO，保证 messages_json 内顺序
        // 与 ts 顺序严格一致。
        for (const m of newMessages) {
          const now = new Date().toISOString()
          if (m.role === 'assistant') {
            await conversationsRepo.appendMessage(req.conversationId, {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: m.content,
              ...(m.toolCalls && m.toolCalls.length > 0
                ? {
                    toolCalls: m.toolCalls.map((tc) => ({
                      id: tc.id,
                      name: tc.name,
                      arguments: tc.arguments,
                    })),
                  }
                : {}),
              ts: now,
            })
          } else if (m.role === 'tool') {
            // 工具结果消息：必须带上 toolCallId 让前端能匹配回 assistant.toolCalls
            await conversationsRepo.appendMessage(req.conversationId, {
              id: crypto.randomUUID(),
              role: 'tool',
              content: m.content,
              toolCallId: m.toolCallId,
              toolName: m.name,
              toolResult: safeParseToolResult(m.content),
              ts: now,
            })
          }
        }
        // token 累计走 SQL 原子增量（conversationsRepo.updateTokensDelta），
        // 避免 read-modify-write 与并发流竞争导致计数丢失。
        if (totalInput > 0 || totalOutput > 0) {
          await conversationsRepo.updateTokensDelta(
            req.conversationId,
            totalInput,
            totalOutput,
          )
        }
      })
    } catch (err) {
      // R27-Corr-3 修复 (high error-swallowing)：原版仅 log 后继续 emit done，
      // 渲染端把 done 当成正常完成 → 关掉 spinner / active call，下次重启
      // conversation 时整轮 assistant + tool 链路全部丢失。修复：done 事件
      // 带 persistError 字段，渲染端可识别并把"对话未持久化"暴露给用户
      // （toast / banner / AriaAnnouncer）；同时整个 done 仍正常发，因为流式
      // 输出本身已发给用户且 abort 已经清理，差别只是"是否真的写到 DB"。
      log.warn('[ai/stream] persist failed', err)
      const msg = err instanceof Error ? err.message : String(err)
      emit({ type: 'done', callId: req.callId, persistError: msg })
      return
    }

    emit({ type: 'done', callId: req.callId })

    // 自动生成标题：首轮对话结束后异步触发，不阻塞主对话流。
    // scheduleAutoTitle 内部自己查最新 conv + 判断 shouldAutoTitle（用户已手动改过
    // 就跳过；网络 / LLM 失败 fallback 到首条 user 消息前 20 字）。
    if (!signal.aborted) {
      scheduleAutoTitle({
        conversationId: req.conversationId,
        signal,
        onTitle: (cid, title) => {
          emit({
            type: 'title_updated',
            callId: req.callId,
            conversationId: cid,
            title,
          })
        },
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('[ai/stream] error', err)
    emit({ type: 'error', callId: req.callId, message: msg })
  } finally {
    activeStreams.delete(req.callId)
    // 清掉还在等待的副作用确认，避免 IPC 通道把答案发到一个已死的流
    clearPendingConfirms(req.callId)
  }
}
