/**
 * AI 聊天 Zustand store
 *
 * 职责：
 *   - 保存对话列表 / 当前选中对话
 *   - 维护消息列表（用户 / 助手 / 工具调用卡片）
 *   - 订阅 IPC 推送的流事件，合并到消息 UI 状态
 *   - 提供 sendMessage / abort / newConversation 等动作
 */
import { create } from 'zustand'
import type { AiConversation, AiMessage, AiConversationFolder } from '@shared/types/ai'
import {
  conversationsApi,
  aiApi,
  aiConvFoldersApi,
  type AiStreamEvent,
  type AiProviderInfo,
} from '../lib/ipc'
import { translateAiError } from '@shared/i18n/aiErrorTranslate'
import { getRelativeTimeMessages } from '@shared/i18n/locales'
import { useSettingsStore } from './settings'

/** UI 层的扩展消息：除基础 AiMessage 外还携带渲染所需的临时数据 */
export interface UiMessage {
  /** 本地唯一 id（与 DB 的 AiMessage.id 对应，或临时生成） */
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  ts: string
  /** 工具调用列表（仅 assistant） */
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
    result?: unknown
    status: 'calling' | 'done' | 'error'
  }>
  /** 流式末尾的小光标 */
  streaming?: boolean
  /**
   * tool 消息携带的工具名 / 原始参数 / 解析后的结果 / 对应的 toolCallId。
   * R10 修复：原版 UiMessage 没有这些字段，toUiMessage 全部丢弃，
   * reload 后工具结果只剩 content（可能是一坨 JSON 字符串），无法关联回
   * assistant 消息里的 tool_call 卡片。
   */
  toolName?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolCallId?: string
}

/**
 * 用户当前上下文的轻量描述。
 *
 * 由 InlineAIButton + 各 store 订阅推过来（render-side 独立于 LLM 工具调用）。
 * 主要用途：
 *   1. 注入到 LLM system prompt 末尾，让模型知道"用户正在编辑 X / 番茄钟
 *      正在跑 Y"以便给出更贴切的回答（详见 main/ai/stream.ts）
 *   2. 通过 IPC 推到主进程，主进程在 LLM 工具调用时也用同一份上下文（详见
 *      main/ai/tools.ts 的 setCurrentStickyId / setCurrentNoteId /
 *      setCurrentPomodoroContext helpers）
 *
 * 注意：AIContext 是渲染端 UI 状态，不参与持久化；切换页面 / 卸载组件 / 重启
 * 都重置为初始空对象。
 */
export interface AIContext {
  /** 当前选中的便签 ID（点击 InlineAIButton 时由 StickyNoteCard 提供） */
  stickyId?: string
  /** 当前编辑的笔记 ID（NoteEditor mount 时写入） */
  noteId?: string
  /** 番茄钟是否正在运行 */
  pomodoroRunning?: boolean
  /** 番茄钟当前阶段 */
  pomodoroMode?: 'focus' | 'shortBreak' | 'longBreak'
  /** 番茄钟关联的便签 ID（若用户在跑一个与某便签绑定的番茄钟） */
  pomodoroStickyNoteId?: string | null
}

/**
 * 等待用户确认的 createNote 工具请求
 *
 * 当 AI 工具返回 `{ kind: 'confirm_create', ok, id, title, filename, content }` 时，
 * 流事件处理把它塞进 store，UI 层渲染 ConfirmDialog；用户点接受后才真正落盘。
 */
export interface PendingCreateNote {
  /** AI 给的临时 id（用于关联 assistant 消息中的 tool_result） */
  toolCallId: string
  title: string
  content: string
  filename: string
}

/**
 * R8I-2：通用副作用确认。createSticky / updateSticky / completeSticky /
 * createNote 等 risk != 'none' 的工具循环挂起时由主进程推到前端。
 */
export interface PendingConfirm {
  toolCallId: string
  toolName: string
  risk: 'side-effect' | 'destructive'
  summary: string
  args: Record<string, unknown>
}

/**
 * 把 AI 调用 / IPC / SDK 抛出的 raw err 翻译成中文用户可见错误文案，
 * 然后 set 进 store 的 error 字段。
 *
 * R-fix-ai-chat-error-i18n (high)：原版 `set({ error: (err as Error).message })`
 * 在 15 处 catch 块里把英文 SDK 文本（'fetch failed' / 'socket hang up' /
 * 'Request failed with status code 401' / 'model_not_found' 等）直接塞进
 * ChatPanel banner —— 与 translateAiError 已覆盖的 testConnection 路径形成
 * 一致性缺口。本函数把 chat 流路径也收口到 translateAiError，调用方只需
 * 替换 set 调用即可：
 *
 *   catch (err) {
 *     setUserFacingError(set, err)                                  // 仅 error
 *     setUserFacingError(set, err, { streaming: false, activeCallId: null }) // 多字段
 *   }
 *
 * 实现：复用 @shared/i18n/aiErrorTranslate.translateAiError（覆盖 status /
 * SDK error.type / 网络层 message 子串，未命中走内置兜底），并额外给一层
 * translateAiError 自身抛错时的"请求级"兜底（语义比"服务异常"更贴合 chat
 * 流路径 banner）。
 *
 * extra：允许同时写入其它会话级字段（如 streaming: false / loaded: true），
 *       但禁止覆盖 error 自身。
 */
function setUserFacingError(
  set: (partial: Partial<AiState>) => void,
  err: unknown,
  extra?: Omit<Partial<AiState>, 'error'>,
  fallback = 'AI 请求异常，请稍后重试',
): void {
  let msg: string
  try {
    msg = translateAiError(err, err instanceof Error ? err.message : String(err))
  } catch {
    msg = fallback
  }
  set({ error: msg, ...extra })
}

interface AiState {
  providers: AiProviderInfo[]
  conversations: AiConversation[]
  currentId: string | null
  /**
   * R20 修复 (high race)：selectConversation 并发调用时，晚到的 IPC 响应
   * 不应覆盖用户最后一次选择。每发起一次 select 就自增；响应回来时若
   * generation 不匹配 → 静默丢弃，不写 store。
   */
  selectGeneration: number
  /**
   * 当前 UI 上下文快照（便签 / 笔记 / 番茄钟）。流式请求时主进程把它
   * 注入到 system prompt 末尾（详见 main/ai/stream.ts）。
   * 见 AIContext 接口说明。
   */
  context: AIContext
  /** 当前消息（UI 渲染形态） */
  messages: UiMessage[]
  /** 当前助手消息的累积文本 */
  streaming: boolean
  /** 当前流式 callId，用于 abort */
  activeCallId: string | null
  /** 总 token 计数（本次会话） */
  tokenInput: number
  tokenOutput: number
  error: string | null
  loaded: boolean
  /** 等待用户确认的 createNote 请求（null = 当前没有） */
  pendingCreateNote: PendingCreateNote | null
  /** R8I-2：通用副作用确认（写入便签 / 标记完成 / 创建笔记等） */
  pendingConfirm: PendingConfirm | null
  /** CommandBar（全局 Cmd+K AI 命令栏）是否打开 */
  commandBarOpen: boolean
  /**
   * R15 修复 (high)：CreateNoteConfirmDialog 点"让 AI 再调整"时，
   * 之前直接 querySelector textarea 并 ta.value = next，会被 React
   * 下一次 render 覆盖。改为：把要填入的文本存到这里，MessageInput
   * 订阅并在 effect 里 setValue + 清空本字段。
   * 自增 counter 让"两次相同的文本"也能被识别为新请求。
   */
  prefillInput: { seq: number; text: string } | null
  /**
   * R27-Corr-3 修复 (high error-swallowing)：主进程 stream 在 persist 失败
   * 时把错误信息通过 done.persistError 推过来，存到本字段让 UI 渲染 banner
   * 提醒用户「对话未持久化，下次重启会丢失」。null 表示上次 persist 成功。
   */
  persistError: string | null

  // ===== AI 文件夹 =====
  folders: AiConversationFolder[]
  foldersLoaded: boolean
  /**
   * 当前选中的 folder 过滤：
   *   - undefined → 全部对话（不显示「未分类」分组）
   *   - null      → 仅「未分类」
   *   - string    → 仅该 folder 下对话
   */
  activeFolderId: string | null | undefined

  loadProviders: () => Promise<void>
  loadConversations: () => Promise<void>
  loadFolders: () => Promise<void>
  newConversation: (provider: 'openai' | 'anthropic' | 'minimax', model: string) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  sendMessage: (content: string) => Promise<boolean>
  abort: () => Promise<void>
  /** 处理一个流事件（由订阅回调调用） */
  handleStreamEvent: (e: AiStreamEvent) => void
  /** 估算 token（界面显示用） */
  estimateTokens: () => Promise<number>
  /** 用户接受 createNote 确认 → 调主进程落盘 → 写一条本地反馈消息 */
  acceptCreateNote: () => Promise<void>
  /** 用户拒绝 createNote 确认 */
  dismissCreateNote: () => void
  /** R15：把文本灌入 MessageInput（MessageInput 订阅并自清空） */
  requestPrefillInput: (text: string) => void
  /** R15：MessageInput 已消费，清空 prefillInput */
  clearPrefillInput: () => void
  /** R8I-2：用户接受通用副作用确认 */
  acceptPendingConfirm: () => Promise<void>
  /** R8I-2：用户拒绝通用副作用确认 */
  dismissPendingConfirm: () => void
  /** 全局 CommandBar：打开 / 关闭 / 切换 */
  openCommandBar: () => Promise<void>
  closeCommandBar: () => void
  toggleCommandBar: () => Promise<void>
  /**
   * 打开 CommandBar 并把 prompt 预填到输入框；后续可由 CommandBar 自行
   * 发送，也可由用户接着修改。InlineAIButton 触发具体场景（拆解 / 润色
   * / 续写 等）时调用此方法。
   */
  openWithPrompt: (prompt: string) => Promise<void>
  /**
   * 同步当前 UI 上下文（便签 / 笔记 / 番茄钟）。各 store 订阅相关字段
   * 变化时调用，store 内部仅浅 merge，不会触发 stream 中断 / 重启。
   */
  setContext: (patch: Partial<AIContext>) => void
  /**
   * 清空 AIContext（页面卸载 / 长时间无活动时由调用方主动重置，避免
   * stale id 被下次流式请求用作 system prompt 上下文）。
   */
  resetContext: () => void

  // ===== AI 文件夹操作 =====
  createFolder: (input: { name: string; color?: AiConversationFolder['color'] }) => Promise<AiConversationFolder | null>
  renameFolder: (id: string, name: string) => Promise<void>
  deleteFolder: (id: string) => Promise<{ detachedConversations: number } | null>
  setActiveFolderId: (id: string | null | undefined) => void
  moveConversationToFolder: (id: string, folderId: string | null) => Promise<void>
}

/** 把后端 AiMessage 映射成 UiMessage */
function toUiMessage(m: AiMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ts: m.ts,
    // R10 修复：原版丢弃 toolCalls / toolName / toolArgs / toolResult / toolCallId
    // 五个字段 → 重新打开对话后看不到任何工具调用痕迹，多轮工具链路彻底消失
    // （UI 上既没有 tool_call 卡片，工具结果也只显示一坨 JSON）。
    ...(m.toolCalls && m.toolCalls.length > 0
      ? {
          toolCalls: m.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: tc.arguments,
            status: 'done' as const,
            result: undefined as unknown,
          })),
        }
      : {}),
    ...(m.role === 'tool'
      ? {
          toolName: m.toolName,
          toolArgs: m.toolArgs,
          toolResult: m.toolResult,
          toolCallId: m.toolCallId,
        }
      : {}),
  }
}

/** 容错 JSON.parse：失败时返回 null */
function safeParse<T = Record<string, unknown>>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * 流式追加/更新助手消息的辅助（immer 风格的轻量实现）：
 *   - 如果末尾已是 streaming 的 assistant 消息，则克隆该条并在它上面原地变更；
 *     其余消息对象保持同一引用，React.memo 包裹的子组件不会因此重渲染
 *   - 否则在末尾追加一条新的 assistant 消息（自然变化，引用重建）
 *
 * 顶层 messages 数组仍是新引用（zustand 需要它来触发订阅）；
 * 内部未变化的 UiMessage 引用保持稳定。
 */
function appendOrPatchLastAssistant(
  messages: UiMessage[],
  patch: (m: UiMessage) => void
): UiMessage[] {
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]
  if (last && last.role === 'assistant' && last.streaming) {
    // immer-style：仅克隆被修改的最后一条消息，前面所有消息保持同一引用
    const next = messages.slice()
    const cloned: UiMessage = { ...last }
    patch(cloned)
    next[lastIdx] = cloned
    return next
  }
  // 没有 streaming 助手消息：追加一条新占位
  const placeholder: UiMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    ts: new Date().toISOString(),
    streaming: true,
    toolCalls: [],
  }
  patch(placeholder)
  return [...messages, placeholder]
}

/**
 * 清空「当前对话的流式 / 等待确认 / 错误」等会话级状态。
 *
 * 之前 newConversation / selectConversation / deleteConversation 三个动作
 * 都手抄了一份 `{ streaming: false, activeCallId: null, pendingConfirm: null,
 * pendingCreateNote: null, error: null }` —— R12 加了 4 个字段，R24-Corr-6
 * 补了 `error: null`，handleStreamEvent 的 done / aborted / error 分支则
 * 只清了 3 个字段。下一轮新加会话级字段（如 prefillInput / persistError）
 * 极易在某一处漏掉，让残留状态跨对话泄漏。
 *
 * 本函数作为单一来源：调用方只需 `...resetChatSessionState()` 即可；
 * 新增字段只需改这里。`Pick<AiState, ...>` 是为了拿到精确的字段子集
 * 类型（与 set 的 Partial<AiState> 签名对齐）。
 */
function resetChatSessionState(): Pick<
  AiState,
  'streaming' | 'activeCallId' | 'pendingConfirm' | 'pendingCreateNote' | 'error'
> {
  return {
    streaming: false,
    activeCallId: null,
    pendingConfirm: null,
    pendingCreateNote: null,
    error: null,
  }
}

/**
 * 安装 AI 流事件监听：主进程推送 ai:chunk 时自动路由到 store。
 * 由渲染端入口（main.tsx）调用一次，返回的解绑函数供 HMR dispose 使用。
 */
export function installAiListeners(): () => void {
  if (typeof window === 'undefined') return () => {}
  return window.api.ai.onChunk((_evt, payload) => {
    useAiStore.getState().handleStreamEvent(payload)
  })
}

export const useAiStore = create<AiState>((set, get) => {
  return {
    providers: [],
    conversations: [],
    currentId: null,
    selectGeneration: 0,
    messages: [],
    streaming: false,
    activeCallId: null,
    tokenInput: 0,
    tokenOutput: 0,
    error: null,
    loaded: false,
    pendingCreateNote: null,
    pendingConfirm: null,
    commandBarOpen: false,
    prefillInput: null,
    persistError: null,
    // 当前 UI 上下文（便签 / 笔记 / 番茄钟）。见 AIContext 接口。
    context: {},

    // AI 文件夹
    folders: [],
    foldersLoaded: false,
    activeFolderId: undefined,

    async loadProviders() {
      try {
        const list = await aiApi.listProviders()
        set({ providers: list })
      } catch (err) {
        setUserFacingError(set, err)
      }
    },

    async loadConversations() {
      try {
        const folderId = get().activeFolderId
        const list = await conversationsApi.list(
          folderId === undefined ? 100 : { limit: 100, folderId },
        )
        set({ conversations: list, loaded: true })
      } catch (err) {
        setUserFacingError(set, err, { loaded: true })
      }
    },

    async loadFolders() {
      try {
        const folders = await aiConvFoldersApi.list()
        set({ folders, foldersLoaded: true })
      } catch (err) {
        setUserFacingError(set, err, { foldersLoaded: true })
      }
    },

    async newConversation(provider, model) {
      // R12 修复 (high)：原版 newConversation 不重置 streaming / activeCallId /
      // pendingConfirm / pendingCreateNote，导致上一对话的流式状态泄漏到新对话
      // —— UI 显示"正在生成"但没有新事件；旧 pendingConfirm 在新会话里触发。
      // 先尝试 abort 当前流（若在流），再重置这些状态。
      const wasStreaming = get().streaming
      const oldCallId = get().activeCallId
      if (wasStreaming && oldCallId) {
        try {
          await aiApi.abort(oldCallId)
        } catch {
          /* abort 失败不影响创建 */
        }
      }
      try {
        const activeFolderId = get().activeFolderId
        // R-fix-i18n-conv-title-placeholder-flag：占位标题前缀走 locale 字典
        // （getRelativeTimeMessages.conversationTitlePlaceholder），不再硬编码
        // 『新对话』。日期部分用 settings.language 直接驱动 toLocaleString，
        // zh-CN → '2026/10/15 14:30:00'、en-US → '10/15/2026, 2:30:00 PM'
        // 形态自然跟随。分隔符 `·` 与标题一起走字典：若未来需要按 locale
        // 切换分隔符（en-US 用 ' - '），把字段升级为 (args) => string 即可。
        const language = useSettingsStore.getState().language
        const placeholder = getRelativeTimeMessages(language).conversationTitlePlaceholder
        const conv = await conversationsApi.create({
          provider,
          model,
          title: `${placeholder} · ${new Date().toLocaleString(language)}`,
          // 当选中具体 folder 时，新对话默认归入该 folder；选中「全部」或「未分类」则保持 null
          folderId: typeof activeFolderId === 'string' ? activeFolderId : null,
          // 占位 flag：title_updated 事件据此判定是否覆盖，不用 prefix-match 字面量
          titleIsAuto: true,
        })
        set((s) => ({
          conversations: [conv, ...s.conversations],
          currentId: conv.id,
          messages: [],
          tokenInput: 0,
          tokenOutput: 0,
          // 与 selectConversation / deleteConversation 保持一致：清掉跨会话泄漏
          // （详见 resetChatSessionState 的注释 —— 这是单一来源）。
          ...resetChatSessionState(),
        }))
      } catch (err) {
        setUserFacingError(set, err)
      }
    },

    async selectConversation(id) {
      // R20 修复 (high race)：每次调用都自增 generation；若用户在 IPC
      // 响应回来前又点开了别的对话，generation 已更新 → 旧响应被丢弃，
      // 不会用 A 的旧 messages 覆盖用户已经看到的 B。
      const myGen = get().selectGeneration + 1
      set({ selectGeneration: myGen })
      try {
        const conv = await conversationsApi.get(id)
        // 关键检查：响应期间用户没再发起新的 select（generation 没变）
        if (get().selectGeneration !== myGen) return
        if (!conv) {
          set({
            currentId: null,
            messages: [],
            // R10 修复：清空流式状态，否则切对话时遗留的 streaming=true /
            // activeCallId=旧值 会让 UI 显示"正在生成"和等待旧流的 pendingConfirm，
            // 用户在 B 对话看到 A 对话的 ConfirmDialog 残留。
            // R24-Corr-6 修复：同上，残留 error 会污染"对话已删除/丢失"的 UI。
            // 单一来源 —— 详见 resetChatSessionState 的注释。
            ...resetChatSessionState(),
          })
          return
        }
        set({
          currentId: id,
          messages: conv.messages.map(toUiMessage),
          tokenInput: conv.tokenInput ?? 0,
          tokenOutput: conv.tokenOutput ?? 0,
          // R24-Corr-6 修复：成功切到存在的对话时也清掉残留 error —— 上一对
          // 话的错误不该出现在新对话的 UI 上。
          // 单一来源 —— 详见 resetChatSessionState 的注释。
          ...resetChatSessionState(),
        })
      } catch (err) {
        // generation 已更新同样不写错误（旧对话的错误会污染新对话 UI）
        if (get().selectGeneration !== myGen) return
        setUserFacingError(set, err)
      }
    },

    async deleteConversation(id) {
      // R11 修复：如果删的是当前正在流式输出的对话，必须显式清掉 activeCallId /
      // streaming / pendingConfirm，否则主进程后续推来的 text chunk / tool_result
      // 仍会通过 callId 守卫（虽然新版守卫要求 !activeCallId 即丢），更关键的是
      // appendOrPatchLastAssistant 会拿一个"已删除对话"的 messages 数组继续 patch，
      // 在 UI 上出现幽灵 assistant 气泡。先 abort 主进程侧的流，再清本地状态。
      const wasStreaming = get().streaming && get().currentId === id
      const oldCallId = get().activeCallId
      try {
        await conversationsApi.delete(id)
        if (wasStreaming && oldCallId) {
          try {
            await aiApi.abort(oldCallId)
          } catch {
            /* abort 失败不影响删除 */
          }
        }
        const next = get().conversations.filter((c) => c.id !== id)
        const isCurrent = get().currentId === id
        // R24-Corr-6 修复：删除当前对话时清掉残留 error，避免「刚删了 A
        // 对话但 toast 还显示 A 的网络超时」。
        // 单一来源 —— 详见 resetChatSessionState 的注释。仅当删除的是当前
        // 对话时整组 reset；删的是非当前对话时只清 error（保留其它会话级
        // 状态 —— 它们属于当前对话，与被删对话无关）。
        set({
          conversations: next,
          currentId: isCurrent ? null : get().currentId,
          messages: isCurrent ? [] : get().messages,
          ...(isCurrent ? resetChatSessionState() : { error: null }),
        })
      } catch (err) {
        setUserFacingError(set, err)
      }
    },

    async sendMessage(content) {
      const state = get()
      const trimmed = content.trim()
      if (!trimmed || state.streaming) return false
      if (!state.currentId) {
        set({ error: '请先选择或新建一个对话' })
        return false
      }

      // R16 修复 (high)：在启动流前捕获目标对话 id。await 期间（systemPrompt 拉取、
      // appendMessage 落 DB、IPC 启动流）用户可能切换 / 删除 / 新建对话（selectConversation
      // / deleteConversation / newConversation 都能在 await 窗口里跑），原代码全部用
      // state.currentId / get().currentId 引用 —— 一旦切走，乐观消息会被错误地 push
      // 到新对话的 messages 里（把 userMsg 渲染到 B 对话，但 DB 的 appendMessage 写的是
      // A 对话；或反之）。snapshot targetConvId 后，IPC 用 snapshot，所有 DB 回滚也只
      // 在 targetConvId 仍是 currentId 时才执行（不在线时丢弃插入）。
      //
      // R17 修复 (high correctness)：R16 的快照只覆盖 currentId，但 R16 实现里
      //   - `history` 在 await aiApi.systemPrompt() 之后用 get().messages.map(...)
      //   - `requestedModel` 在同一 await 之后用 get().conversations.find(targetConvId)
      // 这两段 await 期间 messages 与 conversations 都可能已被 selectConversation /
      // deleteConversation / newConversation 改写。后果：
      //   (a) 用户切到 B 对话后，A 的 userMsg 已落 DB，但 messagesForBackend 包含
      //       B 的历史——LLM 收到跨对话上下文，token 白烧 + 助手"看到"用户
        //       没让它看的对话；
      //   (b) A 在 await 期间被删除，get().conversations.find(A)=undefined，
      //       requestedModel=undefined → stream.ts 回退到 settings 默认 model，
      //       用户选的 opus 被静默替换成默认 model，账单 / 输出行为都偏离。
      // 修复：在 await 前快照 messages 与 conv 两者，从快照派生 history / model，
      // IPC payload 完全用快照构建，DB 回滚仍以 currentId===targetConvId 为准。
      const targetConvId = state.currentId
      const messagesSnapshot: UiMessage[] = state.messages
      const convSnapshot = state.conversations.find((c) => c.id === targetConvId) ?? null
      const requestedModel = convSnapshot?.model || undefined
      const callId = crypto.randomUUID()
      const userMsgTs = new Date().toISOString()
      const userMsg: UiMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
        ts: userMsgTs,
      }
      const assistantMsg: UiMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        ts: userMsgTs,
        streaming: true,
        toolCalls: [],
      }

      // R11 修复 (critical #1)：先标记 activeCallId + streaming，再 await appendMessage
      //   - 之前流启动后才设 activeCallId，存在窗口期：主进程 stream.ts 已经发出
      //     早期 text chunk，但渲染端 activeCallId 还是 null → handleStreamEvent
      //     的 callId 守卫 `if (!state.activeCallId) return` 会把早期 chunk 丢掉，
      //     用户看到 assistant 消息"卡住不写字"。
      // R11 修复 (critical #2)：include userMsg in messagesForBackend。
      //   - 之前 history 从 get().messages 构建（不含 userMsg），messagesForBackend
      //     只包含 [system, ...history]，userMsg 永远送不到 LLM。LLM 看不到用户的
      //     新问题，凭空答一份无关回复。
      // R11 修复 (high：data-loss rollback)：跟踪 userMsgPersisted。
      //   - 之前 catch 无条件调 removeLastMessage → 当 aiApi.systemPrompt() 或
      //     appendMessage 自己抛错时，userMsg 还没落 DB，但 removeLastMessage 会删掉
      //     该对话中最近一条已存在的消息（用户上轮发言）。现在仅在确实写入后才回滚。
      set({
        streaming: true,
        activeCallId: callId,
        error: null,
      })
      let userMsgPersisted = false
      try {
        // R32-Corr-5：system 消息由主进程在 runStream 边界硬注入（防 XSS 覆盖
        // SYSTEM_PROMPT），渲染端不再 fetch ai:system-prompt 也不再构造 role:'system'
        // 消息 —— 主进程 ai:stream 角色白名单已显式拒绝渲染端提交 system 消息。
        // R17：history 从快照派生（不在 await 窗口里 get()）。
        const history = messagesSnapshot.map((m) => ({
          role: m.role,
          content: m.content,
          toolCallId: m.role === 'tool' ? m.toolCallId : undefined,
          toolCalls: m.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.args,
          })),
          name: m.role === 'tool' ? m.toolName : undefined,
        }))
        const userMessageForBackend = {
          role: 'user' as const,
          content: trimmed,
        }
        const messagesForBackend = [
          ...history.filter(
            (m) =>
              m.content ||
              (m.toolCalls && m.toolCalls.length > 0) ||
              (m.role === 'tool' && m.toolCallId),
          ),
          userMessageForBackend,
        ]

        // 同步插入 DB（先于 UI 乐观更新，便于失败回滚）
        await conversationsApi.appendMessage(targetConvId, {
          id: userMsg.id,
          role: 'user',
          content: trimmed,
          ts: userMsgTs,
        })
        userMsgPersisted = true

        // 启动后端流（IPC 返回 { ok: true, callId } 立刻，runStream 在主进程后台跑）
        await aiApi.stream({
          callId,
          conversationId: targetConvId,
          messages: messagesForBackend,
          ...(requestedModel ? { model: requestedModel } : {}),
        })

        // R16 修复 (high)：DB 成功 + IPC 启动成功后再插入 UI，但要确认用户仍停在
        // targetConvId 上 —— 否则 userMsg + assistantMsg 会被 push 到当前对话的
        // messages 里（与已写入 DB 的目标对话错位）。
        if (get().currentId === targetConvId) {
          set((s) => ({
            messages: [...s.messages, userMsg, assistantMsg],
          }))
        } else {
          // 用户在流启动前已经切走 → 既然消息已落 DB，正确做法是不在 UI 显示
          // （让用户切回原对话时 reload 看到），并清掉本 store 的 streaming 状态
          // （activeCallId 由 handleStreamEvent 的 callId 守卫按 callId 过滤，
          // 即使主进程继续推流式事件，本 store 也不会污染当前对话）。
          set({ streaming: false, activeCallId: null })
        }
        return true
      } catch (err) {
        // 仅当 userMsg 真的落 DB 且仍在线（用户没切走）时回滚，否则：
        //   - 用户切走：不要碰别的对话的 DB
        //   - 没写入：不要碰上一条已存在消息
        if (userMsgPersisted && get().currentId === targetConvId) {
          void conversationsApi
            .removeLastMessage(targetConvId)
            .catch(() => undefined)
        }
        setUserFacingError(set, err, { streaming: false, activeCallId: null })
        return false
      }
    },

    async abort() {
      const id = get().activeCallId
      if (!id) return
      try {
        await aiApi.abort(id)
      } catch (err) {
        setUserFacingError(set, err)
      }
    },

    handleStreamEvent(e) {
      const state = get()
      // R11 修复 (critical #2)：只接受匹配当前 activeCallId 的事件。
      // 原版 `state.activeCallId && e.callId !== state.activeCallId` 在 activeCallId
      // 为 null 时放行任何事件 —— 用户在 A 对话流式期间切到 B 对话后，A 的 stream 仍在
      // 主进程跑，迟到的 text chunk 会污染 B 对话的 messages（出现 A 的回复残片）。
      // 新守卫：没有 activeCallId → 直接丢弃。
      if (!state.activeCallId || e.callId !== state.activeCallId) return

      switch (e.type) {
        case 'round_start': {
          // R11 修复 (medium #39)：工具循环多轮时，后台 messages 数组每轮 push 一条
          // 新的 assistant 消息（stream.ts:357），但渲染端 appendOrPatchLastAssistant
          // 只 patch「最后一条 streaming assistant 消息」—— round 1 的那条全程保持
          // streaming=true，第二轮的 text chunk 全被 append 到 round 1 的 content，
          // 用户看到一条超长回复，丢失多轮结构。处理：收到 round_start 时把当前
          // 最后一条 assistant 消息的 streaming 置 false，下一次 text chunk 找不到
          // streaming=true 的目标 → 自动创建新占位。
          //
          // R16 修复 (medium)：仅当上一条有实际内容时才 seal。如果 userMsg 后
          // 直接是 assistant 占位（content='' 且没有 toolCalls），那是 sendMessage
          // 乐观插入的空 placeholder（见上方 sendMessage），seal 它不会带来多轮
          // 结构好处（它不会变成"上轮消息"——下一轮 text chunk 会用 appendOrPatchLastAssistant
          // 找到末尾 streaming 占位继续 patch），反而让用户先看到一个"⏎"形状的空
          // assistant 卡片。
          set((s) => {
            const last = s.messages[s.messages.length - 1]
            if (
              last &&
              last.role === 'assistant' &&
              last.streaming &&
              (last.content.length > 0 || (last.toolCalls && last.toolCalls.length > 0))
            ) {
              const next = s.messages.slice()
              next[next.length - 1] = { ...last, streaming: false }
              return { messages: next }
            }
            return {}
          })
          break
        }
        case 'round_end': {
          // R11 修复 (medium #39)：让 UI 知道上一轮已结束，把最后一条 assistant
          // 消息的 streaming 置 false，避免在「后续 round 不再有 text chunk」
          // 的情况下该条消息一直闪烁"正在输入"。
          set((s) => {
            const last = s.messages[s.messages.length - 1]
            if (last && last.role === 'assistant' && last.streaming) {
              const next = s.messages.slice()
              next[next.length - 1] = { ...last, streaming: false }
              return { messages: next }
            }
            return {}
          })
          break
        }
        case 'text': {
          // 关键路径：流式文本 chunk
          // 仅末尾 streaming 的 assistant 消息被克隆/更新，其它消息保持同一引用
          set((s) => ({
            messages: appendOrPatchLastAssistant(s.messages, (m) => {
              m.content += e.text ?? ''
            }),
          }))
          break
        }
        case 'tool_call': {
          // R10 修复：原版 id 用 crypto.randomUUID()，但 stream 推送的 e.toolCallId
          // 才是和 confirmToolCall / markToolConsumed / one_shot_consumed 配对的真 id。
          // 用 randomUUID 后，pendingConfirm 通过 toolCallId 找 assistant 消息里的
          // tool_call 卡片永远找不到（见确认对话框"接受"时无对应卡片状态更新），
          // one_shot_consumed 事件也无法把对应卡片从 calling 切到 done。
          const toolCallId = e.toolCallId ?? crypto.randomUUID()
          set((s) => ({
            messages: appendOrPatchLastAssistant(s.messages, (m) => {
              const toolCalls = [
                ...(m.toolCalls ?? []),
                {
                  id: toolCallId,
                  name: e.toolName ?? 'unknown',
                  args: (e.args as Record<string, unknown>) ?? {},
                  status: 'calling' as const,
                },
              ]
              m.toolCalls = toolCalls
            }),
          }))
          break
        }
        case 'tool_result': {
          // createNote 工具的"创建笔记"是一个写操作：必须由用户明确同意。
          // 后端把 writeFile 拆出来变成 createNoteConfirmed，工具本身只返回
          // `{ kind: 'confirm_create', ok, id, title, filename, content }`。
          // 这里把这种结果塞进 pendingCreateNote，等 UI 弹窗确认。
          if (e.toolName === 'createNote') {
            const raw = e.result
            const obj =
              typeof raw === 'string'
                ? safeParse<Record<string, unknown>>(raw)
                : (raw as Record<string, unknown> | null)
            if (obj && obj['kind'] === 'confirm_create' && obj['ok'] !== false) {
              const toolCallId =
                typeof obj['id'] === 'string'
                  ? (obj['id'] as string)
                  : crypto.randomUUID()
              set({
                pendingCreateNote: {
                  toolCallId,
                  title: typeof obj['title'] === 'string' ? (obj['title'] as string) : '未命名笔记',
                  content:
                    typeof obj['content'] === 'string' ? (obj['content'] as string) : '',
                  filename:
                    typeof obj['filename'] === 'string'
                      ? (obj['filename'] as string)
                      : '',
                },
              })
            }
          }
          set((s) => {
            const messages = s.messages
            const lastIdx = messages.length - 1
            const last = messages[lastIdx]
            if (!last || last.role !== 'assistant' || !last.toolCalls) {
              return {}
            }
            // R-fix-parallel-tool-result：优先按 toolCallId 精确匹配，
            // 避免 LLM 在同一轮并发调用同名工具时结果被颠倒；老事件没有
            // toolCallId 时回退到按 name+status 反向匹配（保持向后兼容）。
            const tcs = last.toolCalls.slice()
            let matched = false
            if (e.toolCallId) {
              for (let i = 0; i < tcs.length; i += 1) {
                if (tcs[i].id === e.toolCallId) {
                  tcs[i] = { ...tcs[i], result: e.result, status: 'done' as const }
                  matched = true
                  break
                }
              }
            }
            if (!matched) {
              for (let i = tcs.length - 1; i >= 0; i -= 1) {
                if (tcs[i].name === e.toolName && tcs[i].status === 'calling') {
                  tcs[i] = { ...tcs[i], result: e.result, status: 'done' as const }
                  break
                }
              }
            }
            const next = messages.slice()
            next[lastIdx] = { ...last, toolCalls: tcs }
            return { messages: next }
          })
          break
        }
        case 'requires_confirmation': {
          // R8I-2：主进程挂起了一个有副作用的工具调用，等用户拍板。
          // 把请求暂存到 pendingConfirm，UI 层弹 ConfirmDialog；用户接受
          // 后调 acceptPendingConfirm 回送 toolCallId，主进程恢复工具循环。
          if (!e.toolCallId || !e.toolName) break
          set({
            pendingConfirm: {
              toolCallId: e.toolCallId,
              toolName: e.toolName,
              risk: e.risk ?? 'side-effect',
              summary: e.summary ?? `${e.toolName}`,
              args: (e.args as Record<string, unknown>) ?? {},
            },
          })
          break
        }
        case 'one_shot_consumed': {
          // R8I-3：把状态为 calling 的同名 toolCallId 标记为 consumed，
          // 避免后续 'tool_result' 用同一 id 复活一个已经被用户处理过的工具。
          if (!e.toolCallId) break
          set((s) => {
            const messages = s.messages
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              const m = messages[i]
              if (!m || m.role !== 'assistant' || !m.toolCalls) continue
              const tcs = m.toolCalls.slice()
              let touched = false
              for (let j = tcs.length - 1; j >= 0; j -= 1) {
                if (tcs[j].id === e.toolCallId && tcs[j].status === 'calling') {
                  tcs[j] = { ...tcs[j], status: 'done' as const, result: { skipped: 'one-shot' } }
                  touched = true
                  break
                }
              }
              if (touched) {
                const next = messages.slice()
                next[i] = { ...m, toolCalls: tcs }
                return { messages: next }
              }
            }
            return {}
          })
          break
        }
        case 'usage': {
          // R29-A11yPerf-5 修复 (HIGH perf)：原版每次 usage chunk 都无条件
          // set 触发整个 store 的所有订阅者重渲染。LLM 长对话时一条
          // assistant 回复可能 emit 30+ usage chunk，每个 chunk 即使 input
          // /output 都是 0 也会让 TokenUsage 组件 + 所有 useAiStore 订阅者
          // 重新 render。修复：先判断 delta 是否都为 0，是则直接 break 跳过
          // set；非零才一次性 batch 两个字段写回（input + output 走同一个
          // set 调用，避免两次连发）。
          const dIn = e.input ?? 0
          const dOut = e.output ?? 0
          if (dIn === 0 && dOut === 0) break
          set((s) => ({
            tokenInput: s.tokenInput + dIn,
            tokenOutput: s.tokenOutput + dOut,
          }))
          break
        }
        case 'done': {
          // R27-Corr-3 修复 (high error-swallowing)：主进程在 persist 失败时
          // 会发 done 事件并带 persistError 字段。原版忽略 → 用户以为流成功，
          // 下次重启 conversation 时整轮 assistant + tool 链路全部丢失。
          // 修复：done 收到时检查 payload 的 persistError；非空则把消息标
          // 为「对话未持久化」（sticky banner / toast / AriaAnnouncer），
          // 让用户知情并主动重试。
          const persistErrorMsg = e.persistError
            ? `对话未持久化（DB 写入失败）：${e.persistError}`
            : null
          if (e.persistError) {
            console.error('[ai/store] persist failed:', e.persistError)
          }
          // Perf-fix：把 persistError 更新合并进同一个 set，避免两次连发
          // 触发两轮 store-wide subscriber render（每次 done 都会
          // 影响所有 useAiStore 消费者：TokenUsage / MessageInput /
          // ConversationList / MessageList / CommandBar 等）。
          //
          // 单一来源 —— resetChatSessionState 一并清掉 pendingCreateNote
          // 与 error（上一轮的错误 / 未消费的 confirmCreateNote 不该跨
          // 流次泄漏）。persistError 是另一条独立通道，不在这里覆盖。
          set((s) => {
            const messages = s.messages
            const lastIdx = messages.length - 1
            const last = messages[lastIdx]
            const updates: Partial<AiState> = {
              ...resetChatSessionState(),
            }
            if (last && last.role === 'assistant') {
              const next = messages.slice()
              next[lastIdx] = { ...last, streaming: false }
              updates.messages = next
            }
            // persistError 仅在状态翻转时写入（同值跳过 → 无变更通知）
            if (s.persistError !== persistErrorMsg) {
              updates.persistError = persistErrorMsg
            }
            return updates
          })
          break
        }
        case 'aborted': {
          // 单一来源 —— resetChatSessionState 一并清掉 pendingCreateNote
          // 与 error（同 done 的处理：上一轮的 confirmCreateNote / 错误
          // 不该跨流次泄漏）。
          set((s) => {
            const messages = s.messages
            const lastIdx = messages.length - 1
            const last = messages[lastIdx]
            const updates: Partial<AiState> = {
              ...resetChatSessionState(),
            }
            if (last && last.role === 'assistant') {
              const next = messages.slice()
              next[lastIdx] = { ...last, streaming: false }
              updates.messages = next
            }
            return updates
          })
          break
        }
        case 'error': {
          set((s) => {
            const errMsg = e.message ?? '未知错误'
            const messages = s.messages
            const lastIdx = messages.length - 1
            const last = messages[lastIdx]
            // R32-04 修复 (medium error-handling)：error 事件可能携带
            // reason（ai-disabled / no-provider / dns-blocked），这是
            // AI 路由层预检阶段的拒绝，不是 DB 失败。给出"上下文对应"
            // 的横幅文案，让用户知道该去哪改设置 / 哪个域名被拦截，
            // 而不是看到一个看起来像 DB 故障的原始 provider 错误。
            //
            // R-fix-llm-error-vs-persist：新增 reason='llm-error' 表示
            // SDK 在 chat() catch 块抛出的真实 LLM 错误（401/403/404/429/
            // 5xx/fetch failed/aborted 等）。provider.chat() 内部已经把
            // message 走 translateAiError 转中文（如「API Key 无效或已过期」、
            // 「网络连接失败，请检查网络后重试」），渲染端直接展示 message，
            // 不再误报为「对话未持久化（DB 写入失败）」（那是
            // ai.ts:917 persistError 的逻辑，与 error 事件分流）。
            const reason = e.reason
            const banner = reason
              ? reason === 'ai-disabled'
                ? 'AI 已禁用 — 请在设置中开启 AI 总开关'
                : reason === 'no-provider'
                  ? '无可用 AI 提供方 — 请在设置中选择 OpenAI / Anthropic / MiniMax'
                  : reason === 'dns-blocked'
                    ? '自定义 baseUrl 被 DNS 防护拦截（可能指向了内网/已变更的地址）'
                    : errMsg
              : errMsg
            // R9 修复：error 时也要清 pendingConfirm，否则 ConfirmDialog 滞留
            // 单一来源 —— resetChatSessionState 把所有会话级字段清零；
            // error 字段用 banner 覆盖（reset 默认是 null，这里改成具体错误）。
            const updates: Partial<AiState> = {
              ...resetChatSessionState(),
              error: banner,
            }
            let next: UiMessage[]
            if (last && last.role === 'assistant') {
              next = messages.slice()
              next[lastIdx] = {
                ...last,
                streaming: false,
                content: last.content
                  ? `${last.content}\n\n⚠️ ${banner}`
                  : `⚠️ ${banner}`,
              }
            } else {
              next = [
                ...messages,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: `⚠️ ${banner}`,
                  ts: new Date().toISOString(),
                },
              ]
            }
            return { ...updates, messages: next }
          })
          break
        }
        case 'title_updated': {
          // 自动生成标题：主进程 stream.ts 末尾异步触发，把新标题推过来。
          // 改 conversations 列表中对应项的 title + 把当前对话的 title 同步更新。
          // 二次校验：只在 titleIsAuto===true（系统占位）时才覆盖；用户已手动
          // 改过（titleIsAuto===false）就跳过。详见 R-fix-i18n-conv-title-placeholder-
          // flag + migrations/015-ai-conv-title-is-auto.sql。
          const cid = e.conversationId
          const newTitle = e.title
          if (!cid || !newTitle) break
          set((s) => {
            const updatedList = s.conversations.map((c) => {
              if (c.id !== cid) return c
              // 占位 flag 才允许覆盖 + 覆盖后把 flag 置 false，避免下一次
              // 流事件再次覆盖（极端情况下 stream 推两次 title_updated）
              if (!c.titleIsAuto) return c
              return { ...c, title: newTitle, titleIsAuto: false }
            })
            return { conversations: updatedList }
          })
          break
        }
        default:
          break
      }
    },

    async estimateTokens() {
      try {
        return await aiApi.estimateTokens(
          get().messages.map((m) => ({ role: m.role, content: m.content })),
        )
      } catch {
        return 0
      }
    },

    async acceptCreateNote() {
      const pending = get().pendingCreateNote
      if (!pending) return
      // 立刻清掉 pending，避免双击 Accept 重复落盘
      set({ pendingCreateNote: null })
      try {
        const result = await aiApi.confirmCreateNote({
          title: pending.title,
          content: pending.content,
          toolCallId: pending.toolCallId,
        })
        const ts = new Date().toISOString()
        const conversationId = get().currentId
        if (result.ok) {
          // R28-Corr-4 修复 (medium data-loss)：原版只把系统反馈写到 UI
          // messages 数组，不入 conversationsRepo；reload / 跨设备同步时
          // 「✅ 已创建笔记：...」整条消失，但 assistant tool_calls + tool
          // 链路仍在 DB 里，审计链不完整。修复：appendMessage 同步落库；
          // appendMessage 失败（极罕见，仅 DB 损坏）catch 后 set error
          // 不让 UI 状态走歧路。
          const note: UiMessage = {
            id: crypto.randomUUID(),
            // R32-Corr-6 修复：原 role:'system' 会被 conversation-handlers
            // 角色白名单拒绝（防渲染端伪造 system 消息覆盖 SYSTEM_PROMPT），
            // 导致「UI 显示成功但反馈消息未持久化」+ DB 审计链断裂。
            // 改为 role:'assistant' —— 语义上这条消息就是「assistant 报告
            // 它刚执行的 createNote 工具的结果」，下次 ai:stream 把它当助手
            // 历史重发是正确行为（OpenAI / Anthropic 标准约定）。
            role: 'assistant',
            content: `✅ 已创建笔记：${result.title}（${result.filename}）`,
            ts,
          }
          set((s) => ({ messages: [...s.messages, note] }))
          if (conversationId) {
            try {
              await conversationsApi.appendMessage(conversationId, {
                id: note.id,
                role: 'assistant',
                content: note.content,
                ts,
              })
            } catch (persistErr) {
              const msg = (persistErr as Error).message
              // 渲染端没有 log 模块，用 console.error。
              console.error(
                '[ai/store] acceptCreateNote: system feedback appendMessage failed:',
                msg,
              )
              set({ error: `UI 显示成功但反馈消息未持久化：${msg}` })
            }
          }
        } else {
          const note: UiMessage = {
            id: crypto.randomUUID(),
            // 同 R32-Corr-6：role:'assistant' —— assistant 报告 createNote 工具失败
            role: 'assistant',
            content: `⚠️ 创建笔记失败：${result.error}`,
            ts,
          }
          set((s) => ({ messages: [...s.messages, note], error: result.error }))
          if (conversationId) {
            try {
              await conversationsApi.appendMessage(conversationId, {
                id: note.id,
                role: 'assistant',
                content: note.content,
                ts,
              })
            } catch (persistErr) {
              // 与成功分支对齐：appendMessage 失败时记 warn，不覆盖已被
              // `result.error` 设好的用户可见 error 字段（保留失败主因）。
              // R-fix acceptCreateNote-failure-silent-catch：失败路径的
              // appendMessage 同样属于审计链，不该比成功路径更安静。
              console.warn(
                '[ai/store] acceptCreateNote: failure feedback appendMessage failed:',
                (persistErr as Error).message,
              )
            }
          }
        }
      } catch (err) {
        setUserFacingError(set, err)
      }
    },

    dismissCreateNote() {
      set({ pendingCreateNote: null })
    },

    requestPrefillInput(text) {
      // R15：seq 自增让"两次灌入相同文本"也能被识别为新请求，
      // MessageInput 用 [seq] dep 触发 effect。
      const prev = get().prefillInput
      set({ prefillInput: { seq: (prev?.seq ?? 0) + 1, text } })
    },

    clearPrefillInput() {
      set({ prefillInput: null })
    },

    async acceptPendingConfirm() {
      // R8I-2：用户拍板同意 → 把 toolCallId 回送给主进程，主进程恢复工具循环。
      // 接受时同时清掉 pendingConfirm 并把对应 tool_call 标 'done'，
      // 避免响应在网络上来回时用户连点多次。
      //
      // R10 修复：主进程 confirmToolCall 现在返回 boolean，IPC handler 据此回
      // { ok: false, error }。这里把"等待已过期"的错误透传给 UI（避免用户以为
      // 已接受而 LLM 工具循环还在挂起 → 30s 后才发现）。
      const pc = get().pendingConfirm
      if (!pc) return
      set({ pendingConfirm: null })
      try {
        const res = await aiApi.confirmTool(get().activeCallId ?? '', pc.toolCallId, true)
        if (!res.ok) {
          set({
            error: `确认已过期：${res.error}（请重新发起对话）`,
          })
        }
      } catch (err) {
        setUserFacingError(set, err)
      }
    },

    dismissPendingConfirm() {
      // R8I-2：用户拒绝 → 把 toolCallId 回送给主进程拒绝执行。
      const pc = get().pendingConfirm
      if (!pc) return
      set({ pendingConfirm: null })
      void aiApi
        .confirmTool(get().activeCallId ?? '', pc.toolCallId, false)
        .then((res) => {
          if (!res.ok) {
            set({ error: `确认已过期：${res.error}` })
          }
        })
        .catch((err) => {
          setUserFacingError(set, err)
        })
    },

    async openCommandBar() {
      // 如果还没选对话，先快速建一个"命令栏专用"对话，避免用户进入时是空状态
      // 实际 provider/model 决策在 CommandBar 内部根据 settings 决定；
      // 这里只确保 currentId 非空，使 sendMessage 不会因"请先选择对话"而报错。
      const s = get()
      if (!s.currentId) {
        try {
          await useAiStore.getState().newConversation('openai', 'gpt-4o-mini')
        } catch {
          /* 即使失败也允许弹窗打开；CommandBar 内部会处理发送失败 */
        }
      }
      set({ commandBarOpen: true })
    },

    closeCommandBar() {
      set({ commandBarOpen: false })
    },

    async toggleCommandBar() {
      if (get().commandBarOpen) {
        set({ commandBarOpen: false })
      } else {
        await useAiStore.getState().openCommandBar()
      }
    },

    /**
     * InlineAIButton 的"打开 AI 命令栏并预填 prompt"入口：
     *   1) 先确保 CommandBar 打开（自动新建一个对话避免空状态报错）
     *   2) 用 requestPrefillInput 把 prompt 灌入 CommandBar 的输入框
     *
     * 这样设计的好处：
     *   - 复用了 CommandBar 既有的 prefillInput 机制（与 /ai 页面共享逻辑）
     *   - 不破坏 sendMessage 的并发安全：用户可接着修改 prompt，再按 Enter 发送
     *   - 不直接 sendMessage，避免在没有当前对话时 IPC 串错
     */
    async openWithPrompt(prompt: string) {
      const text = (prompt ?? '').trim()
      if (!text) return
      // 先灌文本再打开：CommandBar 内部 useEffect 监听 prefillInput.seq
      // 变化 → 触发 setValue，因此即使已经打开，再次灌入也能更新输入框。
      useAiStore.getState().requestPrefillInput(text)
      await useAiStore.getState().openCommandBar()
    },

    /**
     * 浅合并当前 UI 上下文。
     * 不做任何去抖（每个 store 的 selector 都已细粒度；setContext 仅在
     * stickyId / noteId / pomodoro 三类真正变化时由订阅者调用），避免
     * 引入额外复杂度。
     */
    setContext(patch) {
      set((s) => {
        const next = { ...s.context, ...patch }
        // 浅比较：若 patch 后与原值全等则跳过 set（避免无变更触发订阅者）
        let changed = false
        for (const k of Object.keys(patch) as Array<keyof AIContext>) {
          if (next[k] !== s.context[k]) {
            changed = true
            break
          }
        }
        return changed ? { context: next } : {}
      })
    },

    resetContext() {
      set({ context: {} })
    },

    async createFolder(input) {
      try {
        const folder = await aiConvFoldersApi.create(input)
        set((s) => ({ folders: [...s.folders, folder] }))
        return folder
      } catch (err) {
        setUserFacingError(set, err)
        return null
      }
    },

    async renameFolder(id, name) {
      try {
        const updated = await aiConvFoldersApi.update(id, { name })
        if (updated) {
          set((s) => ({ folders: s.folders.map((f) => (f.id === id ? updated : f)) }))
        }
      } catch (err) {
        setUserFacingError(set, err)
      }
    },

    async deleteFolder(id) {
      try {
        const result = await aiConvFoldersApi.delete(id)
        set((s) => ({
          folders: s.folders.filter((f) => f.id !== id),
          // 若删的是当前 active folder，回退到「全部」
          activeFolderId: s.activeFolderId === id ? undefined : s.activeFolderId,
          // 内部对话的 folder_id 在主进程被置 NULL，这里同步本地
          conversations: s.conversations.map((c) =>
            c.folderId === id ? { ...c, folderId: null } : c,
          ),
        }))
        return { detachedConversations: result.detachedConversations }
      } catch (err) {
        setUserFacingError(set, err)
        return null
      }
    },

    setActiveFolderId(id) {
      set({ activeFolderId: id })
      // 立即 reload conversations 列表以匹配新筛选
      void get().loadConversations()
    },

    async moveConversationToFolder(id, folderId) {
      try {
        await conversationsApi.setFolder(id, folderId)
        const active = get().activeFolderId
        // 无筛选：本地 patch 即可（避免一次 IPC + SQL 重载）
        if (active === undefined) {
          set((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === id ? { ...c, folderId } : c,
            ),
          }))
        } else {
          // 有筛选：reload 才能让该 conv 离开当前 folder 视图（patch 不够，
          // 因为 reload 会按 activeFolderId 过滤整体替换数组）。此时跳过
          // 本地 patch —— 会被 reload 立刻覆盖，徒增一次 O(N) map 分配
          // 与一次 React re-render。
          void get().loadConversations()
        }
      } catch (err) {
        setUserFacingError(set, err)
      }
    },
  }
})
