/**
 * AI 对话 IPC 处理器
 */
import { randomUUID } from 'node:crypto'
import { handle } from './channels'
import { conversationsRepo } from '../db/repositories/conversations'
import type { AiMessage } from '@shared/types/ai'
import { IPC_CHANNELS } from '@shared/ipc/channels'

/**
 * R12 修复 (medium)：对话相关 IPC 入参边界检查。
 *
 * R16 修复 (critical)：role 白名单 —— 渲染端被劫持时可在历史里塞
 * role:'system' 的假消息，下一次 ai:stream 取历史时把假 system 透传给
 * LLM，覆盖服务端 SYSTEM_PROMPT。Handler 层在 append 时拒绝非白名单 role，
 * 让 ai:stream 那侧的 role check 不再是唯一防线（之前 R16 在 ai-handlers
 * 已加，这里 conversation 这条「落库」路径也得堵上）。
 *
 * R17 修复 (critical security)：renderer 仅可写 user / assistant。role='tool'
 * 消息是「主进程工具循环写给 LLM 的执行回执」，必须由可信的工具循环产生，渲染端
 * 提交会被利用：伪造一个上一次真实工具调用的 toolCallId + content='{"ok":true,...}'
 * 落库，下次 ai:stream 取历史时这条伪造 tool 消息会作为 messagesForBackend 的一部分
 * 送 LLM，让 LLM 误信之前工具已产生副作用（写文件 / 删便签 / 网络请求）并据此继续
 * 后续敏感操作。Handler 层直接拒绝 renderer 提交 tool 消息 —— 真实工具消息由主进程
 * tools.ts / stream.ts 内部 append 调用 conversationsRepo.appendMessage 写入，绕过 IPC。
 */
const MAX_TITLE_BYTES = 500
const MAX_MESSAGE_CONTENT_BYTES = 200_000
const RENDERER_ALLOWED_MESSAGE_ROLES = new Set(['user', 'assistant'])

export function registerConversationHandlers(): void {
  handle(
    IPC_CHANNELS.AI_LIST_CONVERSATIONS,
    async (
      _e,
      payload?:
        | number
        | { limit?: number; folderId?: string | null },
    ) => {
      // 向后兼容：旧调用方式 AI_LIST_CONVERSATIONS(limit) 仍可用
      let limit = 100
      let folderId: string | null | undefined = undefined
      if (typeof payload === 'number') {
        limit = payload
      } else if (payload && typeof payload === 'object') {
        if (typeof payload.limit === 'number') limit = payload.limit
        if ('folderId' in payload) folderId = payload.folderId ?? null
      }
      return conversationsRepo.findAll(limit, { folderId })
    },
  )
  handle(IPC_CHANNELS.AI_GET_CONVERSATION, async (_e, id: string) =>
    conversationsRepo.findById(id),
  )
  handle(
    IPC_CHANNELS.AI_CREATE_CONVERSATION,
    async (
      _e,
      input: {
        provider: string
        model: string
        title?: string | null
        folderId?: string | null
      },
    ) => {
      if (input.title && Buffer.byteLength(input.title, 'utf8') > MAX_TITLE_BYTES) {
        throw new Error(`conversation: title exceeds ${MAX_TITLE_BYTES} bytes`)
      }
      return conversationsRepo.create({
        id: randomUUID(),
        provider: input.provider,
        model: input.model,
        title: input.title ?? null,
        messages: [],
        tokenInput: 0,
        tokenOutput: 0,
        folderId: input.folderId ?? null,
      })
    },
  )
  handle(
    IPC_CHANNELS.AI_APPEND_MESSAGE,
    async (_e, args: { id: string; message: AiMessage }) => {
      // R16：role 白名单 —— 直接拒绝持久化渲染端发来的 role:'system'。
      // 真实系统提示词由服务端 SYSTEM_PROMPT 注入，不允许来自渲染端。
      // R17：进一步收窄为 user / assistant，tool 消息由主进程工具循环直接
      // append（不经 IPC）—— 渲染端伪造 tool 消息会被下一次 ai:stream 当真实
      // 工具结果送给 LLM。
      if (!args.message || !RENDERER_ALLOWED_MESSAGE_ROLES.has(args.message.role as string)) {
        throw new Error(
          `conversation: message role not allowed from renderer: ${String(args.message?.role)}`,
        )
      }
      // R31-Sec-2 修复 (MEDIUM size-cap-bypass-via-extras)：原版只检查
      // content 字段的字节长度。但 message 还可能有 toolResult / toolCallId
      // / name 等任意自定义键（role 已被白名单限死，但字段无 schema）。
      // 被劫持渲染端发 `{role:'user', content:'hi', toolResult:'A'.repeat(500_000_000)}`
      // → content 字节数 2（远低于 cap）→ JSON.stringify 整个对象后写库
      // 字段 → messages_json 单行 MB 级，ai:stream 反序列化卡死。
      // 修复：对**整个** message 做 byteLength 兜底。不限制字段个数（让
      // 工具消息字段如 tool_call_id 仍能落库），只限制整体序列化大小。
      const fullMessageBytes = Buffer.byteLength(JSON.stringify(args.message), 'utf8')
      if (fullMessageBytes > MAX_MESSAGE_CONTENT_BYTES) {
        throw new Error(
          `conversation: message (all fields) exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes (got ${fullMessageBytes})`,
        )
      }
      // content 单独检查作为 fast-path 错误信息（开发时更直观），但上面
      // 已经先做了整体检查，所以这一段基本不会被触发。保留以兼容极端
      // 调试场景（异常 JSON.stringify 超长 string 时的边界行为）。
      if (typeof args.message?.content === 'string'
          && Buffer.byteLength(args.message.content, 'utf8') > MAX_MESSAGE_CONTENT_BYTES) {
        throw new Error(`conversation: message content exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes`)
      }
      // R25-Sec-2 修复 (medium prompt-injection)：持久化前剥掉 assistant
      // 消息上的 toolCalls。toolCalls 应该只由主进程 dispatcher 在执行完
      // 工具后回写；渲染端 store 在落盘前虽然不会主动构造 toolCalls，但
      // 一个被 XSS 控制的渲染端可以伪造 assistant {toolCalls:[deleteNote]}
      // 写入持久化层，下次 ai:stream 直接进 LLM 历史，模型把伪造的「我
      // 自己以前调过 deleteNote」当真。落地前 strip。
      //
      // R26-Corr-4 / R26-Sec-6 修复 (medium mutation-hazard)：原版
      // `delete args.message.toolCalls` 直接 mutate 渲染端 store 里的对象
      // —— contextBridge structured clone 在 IPC 边界 deep clone 过一次，
      // 但 appendMessage 之后的 return 让 renderer 拿到的是同一个内部
      // 对象引用 → 下一次 renderer 想基于这条 message 重渲染（例如展示
      // 已调用的工具 chip），toolCalls 字段已被抹掉。改为克隆再写。
      //
      // R29-Sec-1 修复 (HIGH prompt-injection-persistence)：原版只剥
      // camelCase toolCalls。被 XSS 控制的渲染端可塞
      // `{tool_calls:[{id, type:'function', function:{name:'deleteNote', ...}}]}`
      // (snake_case) 落库，下次 ai:stream 把伪造"我之前调过 deleteNote"
      // 当真，让 LLM 跳过当前真实调用或据此执行破坏性后续操作。
      // 修复：用 `^tool[_-]?calls?$` 正则（mirror ai-handlers.ts:170-191 的
      // R27-Sec-4 修复）覆盖所有变体；同时也剥 function_call /
      // tool_call_id / name 工具辅助字段，防止伪造的 tool 执行回执。
      // 任何 role（不只是 assistant）都要做，避免被 system / user 角色绕开。
      const toolCallKeyRe = /^tool[_-]?calls?$/i
      const helperKeyRe = /^(function_call|tool_call_id|name)$/i
      let needsClone = false
      for (const k of Object.keys(args.message)) {
        if (toolCallKeyRe.test(k) || helperKeyRe.test(k)) {
          needsClone = true
          break
        }
      }
      if (needsClone) {
        const cloned: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(args.message)) {
          if (!toolCallKeyRe.test(k) && !helperKeyRe.test(k)) cloned[k] = v
        }
        await conversationsRepo.appendMessage(args.id, cloned as unknown as AiMessage)
        return { ok: true }
      }
      await conversationsRepo.appendMessage(args.id, args.message)
      return { ok: true }
    },
  )
  handle(
    IPC_CHANNELS.AI_UPDATE_TOKENS,
    async (_e, args: { id: string; input: number; output: number }) => {
      await conversationsRepo.updateTokens(args.id, args.input, args.output)
      return { ok: true }
    },
  )
  handle(
    IPC_CHANNELS.AI_UPDATE_TITLE,
    async (_e, args: { id: string; title: string }) => {
      if (typeof args.title !== 'string'
          || Buffer.byteLength(args.title, 'utf8') > MAX_TITLE_BYTES) {
        throw new Error(`conversation: title exceeds ${MAX_TITLE_BYTES} bytes`)
      }
      await conversationsRepo.updateTitle(args.id, args.title)
      return { ok: true }
    },
  )
  handle(IPC_CHANNELS.AI_DELETE_CONVERSATION, async (_e, id: string) => {
    await conversationsRepo.delete(id)
    return { ok: true }
  })
  /**
   * R10 修复：sendMessage 失败时回滚尾部孤儿 userMsg。
   * 原版无此通道，渲染端只能看着"用户消息已落 DB 但发送失败"的鬼影。
   *
   * R18 修复 (medium security)：R10 版本的 removeLastMessage 没有 role 校验，
   * 攻击者可重复调用本通道把对话里所有 assistant / tool / system 消息逐条
   * 删掉（每次删最后一条）—— 等价于「静默改写对话历史」。具体危害：
   *   1. 删 assistant 消息 → 用户看不到 AI 历史回答（轻度 UX）
   *   2. 删 tool 消息 → 上一次 tool 调用的结果从历史中消失，LLM 在
   *      下次调用时失去对之前工具副作用的记忆，可能重复执行或基于
   *      错误前提继续推进（高危：影响 agentic 工作流的正确性）
   *   3. 即使是删除 user 消息，本通道没有 role 限定，攻击者也能删
   *      别人的 user 输入 → 数据完整性破坏
   *
   * 修复：renderer 仅可删 user 消息（与 AI_APPEND_MESSAGE 的白名单对齐）。
   * 真实回滚场景里孤儿 userMsg 就是 user role，符合预期。其它 role 的
   * 消息只能由主进程 tools.ts / stream.ts 在受控路径里删（即使主进程
   * 当前没用到这条路径，未来加也走单独 IPC，不复用本通道）。
   */
  handle(IPC_CHANNELS.AI_REMOVE_LAST_MESSAGE, async (_e, id: string) => {
    await conversationsRepo.removeLastMessageIfRole(id, 'user')
    return { ok: true }
  })
  handle(IPC_CHANNELS.AI_GET_TOTAL_TOKENS, async () => conversationsRepo.getTotalTokens())
}