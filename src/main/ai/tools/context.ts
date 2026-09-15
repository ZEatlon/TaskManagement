/**
 * AI 工具层 — webContents 维度的状态管理
 *
 * 历史来源：从原 src/main/ai/tools.ts 抽离，把 3 个 module-level Map
 * （currentOpenNoteByWebContents / openedNotesByWebContents /
 * aiContextByWebContents）、AsyncLocalStorage caller 上下文包装、
 * 以及一整套 setCurrentXxx / clear 系列 setter 收敛到一个文件。
 *
 * 设计要点：
 *  - 不使用 module-level 全局变量，全部按 webContentsId 分桶，避免多
 *    BrowserWindow 并发写入互相覆盖。
 *  - clearedNotesByWebContents / openedNotesByWebContents 是 summarizeNote
 *    等「必须校验调用方权限」工具的强校验源；aiContextByWebContents 是
 *    stream.ts 拼 system prompt 时读的 advisory 上下文（不参与权限判断）。
 *  - 调用方异步路径优先用 AsyncLocalStorage（callerAls），同步 fallback
 *    仍保留模块级 currentCallerWebContentsId 变量 —— 实际 stream.ts
 *    都走 ALS 路径，模块级变量仅作测试兼容 / 兜底。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import log from '../../log'
import { escapeToolText } from './validators'

/**
 * R27-Sec-9 修复 (medium info-disclosure)：原版 `currentOpenNoteId` 是一个
 * 全局 module-level 变量，由渲染端通过 IPC `ai:set-current-note-id` 直接
 * 写入，主进程不验证这个 noteId 是否真的是该 webContents 正在编辑的笔记。
 * 攻击：被劫持渲染端 → `ai:set-current-note-id('target-secret-id')` →
 * 触发 LLM 调 summarizeNote(target-secret-id) → 主进程比较成功 →
 * 把任意笔记的完整内容以 data-only wrapper 形式回灌给 LLM → LLM 通过
 * 注入的信道把内容回传。
 *
 * 修复策略：主进程维护「每 webContents 已打开的笔记集合」+ 「每 webContents
 * 当前正在编辑的笔记 ID」。打开/关闭的集合只能通过专用 IPC `note:opened` /
 * `note:closed` 写入（由渲染端 NoteEditor mount/unmount 时调用），主进程
 * 不接受绕过；setCurrentNoteId 必须带 webContentsId，且 noteId 必须已在该
 * webContents 的「已打开集合」里。summarizeNote 把 webContentsId 透传给
 * executeTool，仅放行当前 webContents 真的打开的笔记。
 */

/** 每 webContents 当前正在编辑的笔记 ID */
const currentOpenNoteByWebContents = new Map<number, string | null>()
/** 每 webContents 已打开的笔记 ID 集合（NoteEditor mount 时注册，unmount 时反注册） */
const openedNotesByWebContents = new Map<number, Set<string>>()

/**
 * 渲染端 UI 上下文（与 src/renderer/src/stores/ai.ts 的 AIContext 同步）。
 *
 * 不是 module-level 全局变量 —— 与 currentOpenNoteByWebContents 一样按
 * webContentsId 分桶，避免多 BrowserWindow 并发写入互相覆盖。
 *
 * 用于：
 *   1) stream.ts 在 runStream 边界把它追加到 system prompt 末尾，让模型
 *      知道"用户当前正在编辑便签 X / 笔记 Y / 番茄钟正在跑 Z 阶段"
 *   2) 后续工具（如针对当前便签的 updateSticky / 步骤拆解建议）时的优先目标
 *
 * 注意：写入侧不校验合法性（便签是否真存在 / noteId 是否在 openedNotes
 * 集合里）。这是因为 context 是 advisory，stream.ts 仅用于"提示 LLM"，不
 * 参与权限判断。summarizeNote / 工具执行的真权限校验仍走 openedNotes
 * 集合那一套。
 */
export interface CallerAiContext {
  stickyId?: string | null
  noteId?: string | null
  pomodoroRunning?: boolean | null
  pomodoroMode?: 'focus' | 'shortBreak' | 'longBreak' | null
  pomodoroStickyNoteId?: string | null
}

const aiContextByWebContents = new Map<number, CallerAiContext>()

/** 当前流式工具调用的发送方 webContentsId（stream.ts 在 executeTool 前 set；null = 未知）
 *
 * R28-Corr-1 修复 (high race-condition)：原版用 module-level 单一变量保存
 * 当前 caller。两条 runStream 并发时（两个 BrowserWindow 同时跑 AI 流），
 * stream A set(id_A) → executeTool → stream B set(id_B) → stream B's tool
 * 读到的却是 id_A（反之亦然）。`summarizeNote` 用错 id 校验 openedNotes
 * 集合 → 该放行的不放行、该拦的不拦。
 *
 * 修复：用 Node AsyncLocalStorage 把 caller 上下文绑到当前异步调用栈。
 * stream.ts 把 executeTool 包装在 als.run(store, () => …) 里；工具侧
 * 用 getCurrentCallerWebContentsId() 读出栈上值，无论多少流并发都不会
 * 互相覆盖。模块级变量 + set/clear 模式保留作 fallback（同步路径
 * 兼容），但所有异步读路径一律走 ALS。
 */

interface CallerContext {
  webContentsId: number | null
}
const callerAls = new AsyncLocalStorage<CallerContext>()

/**
 * R-fix-caller-context-leak (medium correctness)：暴露 ALS store 直接读
 * 路径。executeTool 用它做进入时校验 —— 如果 store 是 undefined，说明
 * 调用方没经过 runWithCallerContext()，意味着 caller 上下文已不可信
 * （典型场景：webContents 在 runStream 入口到 executeTool 之间被销毁，
 * runStream 的 for-of 循环下一轮才退出，但流仍带着空 ALS 进入工具）。
 * 这时直接返回 bridge failure 避免副作用落到 aiContextByWebContents /
 * IPC emit 到已死渲染端。
 *
 * 注意：getCurrentCallerWebContentsId() 走 ALS 优先 + module-level
 * fallback，对工具侧权限判断更宽松；这里的 store 直接读**不**走 fallback，
 * 严格区分「ALS 上下文是否存在」。
 */
export function getCallerAlsStore(): CallerContext | undefined {
  return callerAls.getStore()
}

// 旧的 module-level 变量 —— 同步 set/clear 仍保留（向后兼容），异步
// 路径必须用 als.run() 隔离。
let currentCallerWebContentsId: number | null = null

/**
 * 渲染端通过 IPC `note:opened` 调用：NoteEditor mount 时注册笔记为「这个
 * webContents 当前已打开」。同一个 webContents 多次 open 同一笔记幂等。
 */
export function noteOpenedByWebContents(webContentsId: number, noteId: string): void {
  if (!noteId) return
  let set = openedNotesByWebContents.get(webContentsId)
  if (!set) {
    set = new Set()
    openedNotesByWebContents.set(webContentsId, set)
  }
  set.add(noteId)
}

/** 渲染端通过 IPC `note:closed` 调用：NoteEditor unmount 时反注册 */
export function noteClosedByWebContents(webContentsId: number, noteId: string): void {
  const set = openedNotesByWebContents.get(webContentsId)
  if (!set) return
  set.delete(noteId)
  // 如果关闭的就是当前正在编辑的笔记，清掉 currentOpen
  if (currentOpenNoteByWebContents.get(webContentsId) === noteId) {
    currentOpenNoteByWebContents.set(webContentsId, null)
  }
}

/**
 * 渲染端通过 IPC `ai:set-current-note-id` 调用。必须带 webContentsId；
 * noteId 必须已在该 webContents 的 openedNotes 集合里（防止渲染端绕过
 * NoteEditor 直接声称"我正在编辑某个笔记"）。关闭时传 null —— null 不需
 * 要已在 opened 集合里，因为卸载组件路径里 noteClosed 已经清掉。
 */
export function setCurrentNoteId(noteId: string | null, webContentsId: number): void {
  if (noteId === null) {
    currentOpenNoteByWebContents.set(webContentsId, null)
    return
  }
  const opened = openedNotesByWebContents.get(webContentsId)
  if (!opened || !opened.has(noteId)) {
    // 不在已打开集合里 → 拒绝（防止被劫持渲染端任意指认目标笔记）
    log.warn(
      `[ai/tools] setCurrentNoteId refused: noteId=${noteId} not in openedNotes for wc=${webContentsId}`,
    )
    return
  }
  currentOpenNoteByWebContents.set(webContentsId, noteId)
}

/**
 * 测试 / 窗口销毁时清理 webContents 状态。
 *
 * 三个 Map 生命周期必须一致绑定到 webContentsId：
 *   - openedNotesByWebContents / currentOpenNoteByWebContents：NoteEditor 强校验用
 *   - aiContextByWebContents：stream.ts 拼 system prompt 时读，advisory 但同样会泄漏
 *
 * 渲染端即便在卸载时已经主动 setCurrent*(null) 兜底，destroyed 事件这条
 * 最终清理路径必须把三 Map 都 delete，否则 webContentsId 单调递增复用旧 id
 * 时（新窗口复用旧 id）会读到上一次 stickyId / pomodoroContext 残留 →
 * stream.ts 把 stale id 注入 system prompt → AI 上下文被污染。
 */
export function clearWebContentsNoteState(webContentsId: number): void {
  openedNotesByWebContents.delete(webContentsId)
  currentOpenNoteByWebContents.delete(webContentsId)
  aiContextByWebContents.delete(webContentsId)
  // R33 修复 (HIGH ai:confirm-create-note-bypass)：同一 webContents 销毁时
  // 把它的所有待确认 createNote 一并清掉，避免残留的 pending 项被同 id 复用
  // 的 webContents 消费掉（webContentsId 单调递增时新窗口复用旧 id）。
  for (const key of pendingCreateNoteByWebContentsKeys()) {
    if (key.startsWith(`${webContentsId}::`)) {
      pendingCreateNoteByWebContentsDelete(key)
    }
  }
  // R-fix-caller-context-leak (medium correctness)：webContents 销毁时
  // 把该 webContents 拥有的所有活跃流全部 abort 并从 activeStreams 表里
  // 摘除。否则 runStream 的 in-flight LLM 调用 / 工具 await 链继续跑，
  // 直到 await 解析后 emit() 把事件发到一个已死的 webContents，事件丢
  // 失；如果之后 executeTool 写 aiContextByWebContents/pendingConfirms，
  // 该 wcId 已 delete（早两行）→ 写入落到一个全新的空 Map key，但因为
  // emit 通道已死，IPC 仍发不出去 —— 表现是「用户以为取消了，但流
  // 还在跑、CPU 浪费、磁盘多写入，UI 啥也没看到」。
  //
  // 注意：webContentsId 可能为 null（流由非 webContents 上下文发起）。
  // null 拥有者不属于任何一个 webContents 销毁路径，所以这里只 abort
  // 拥有者严格等于目标 id 的流 —— 不会误伤其他窗口的流。
  for (const [callId, ownerId] of activeStreamsOwnerSnapshot()) {
    if (ownerId === webContentsId) {
      activeStreamsAbortByCallId(callId)
    }
  }
}

/**
 * R33 修复 (medium #2)：compare-and-clear —— 仅在主进程当前 stickyId 等于
 * expectedStickyId 时才清空，避免多张 StickyNoteCard 同时挂载时 A 卸载把
 * B 推过来的 stickyId 误清。
 *
 * 之前 setCurrentStickyId(null, ...) 是无脑覆盖，渲染端虽然做了
 * useAiStore.context.stickyId === note.id 的判定才发 null，但主进程侧没有
 * 对应守护；TOCTOU 窗口里 B 的 mount 已经把 stickyId 改成 B 了，但 A 的
 * cleanup 在 B 之后到达 → A 的无条件 set(null) 覆盖掉 B。结果：
 * 渲染端 store 显示 B、主进程却 null，AI 工具调用命中 null fallback
 * 走"no sticky context"，LLM 错选实体或拒绝动作。
 *
 * atomic compare-and-clear 在主进程内部读 aiContext → 校验 → 写回，
 * JS 单线程下不存在 TOCTOU；同时保留 setCurrentStickyId 用于 mount 时
 * "无条件写新值"（mount 不需要守卫，那是预期的覆盖）。
 */
export function clearStickyIdIfMatches(
  expectedStickyId: string,
  webContentsId: number,
): boolean {
  const ctx = aiContextByWebContents.get(webContentsId)
  if (!ctx) return false
  if (ctx.stickyId !== expectedStickyId) return false
  aiContextByWebContents.set(webContentsId, { ...ctx, stickyId: null })
  return true
}

/**
 * 渲染端通过 IPC `ai:set-current-sticky-id` 写入：用户当前正在操作的
 * 便签 ID。仅用作 system prompt 提示，不参与任何工具的权限判断。
 * 关闭便签（卸载 StickyNoteCard 或打开别的便签）时传 null。
 *
 * 直接复用上面 CallerAiContext / aiContextByWebContents，与 setCurrentNoteId
 * 区分：那个走 openedNotes 集合强校验（summarizeNote 用），这个只是
 * advisory，stream.ts 注入到 system prompt 末尾用。
 */
export function setCurrentStickyId(
  stickyId: string | null,
  webContentsId: number,
): void {
  const prev = aiContextByWebContents.get(webContentsId) ?? {}
  aiContextByWebContents.set(webContentsId, { ...prev, stickyId: stickyId ?? null })
}

/**
 * 渲染端通过 IPC `ai:set-current-pomodoro-context` 写入：番茄钟的当前
 * 状态。三个字段一起更新（保持一致：mode + running + stickyNoteId）。
 * 停止时传 null。
 */
export function setCurrentPomodoroContext(
  ctx:
    | {
        running: boolean
        mode: 'focus' | 'shortBreak' | 'longBreak'
        stickyNoteId: string | null
      }
    | null,
  webContentsId: number,
): void {
  const prev = aiContextByWebContents.get(webContentsId) ?? {}
  if (ctx === null) {
    aiContextByWebContents.set(webContentsId, {
      ...prev,
      pomodoroRunning: null,
      pomodoroMode: null,
      pomodoroStickyNoteId: null,
    })
    return
  }
  aiContextByWebContents.set(webContentsId, {
    ...prev,
    pomodoroRunning: ctx.running,
    pomodoroMode: ctx.mode,
    pomodoroStickyNoteId: ctx.stickyNoteId ?? null,
  })
}

/**
 * stream.ts 调用：返回当前 webContents 的 UI 上下文快照；若不存在返回
 * 空对象。返回的引用是 Map 里的同一对象（只读用途），调用方不要改它。
 */
export function getAiContextByWebContents(webContentsId: number | null): {
  stickyId?: string | null
  pomodoroRunning?: boolean | null
  pomodoroMode?: 'focus' | 'shortBreak' | 'longBreak' | null
  pomodoroStickyNoteId?: string | null
} {
  if (webContentsId === null) return {}
  return aiContextByWebContents.get(webContentsId) ?? {}
}

/**
 * stream.ts 调用：把 AIContext 渲染成中文 system prompt 追加片段。
 * 不返回时返回空字符串 —— 当且仅当三块都未设置时才返回空，避免给 LLM
 * 多余的"上下文：未提供"噪音。
 *
 * 返回值不含 `<system>` 标签：主进程已经在 runStream 边界硬注入 SYSTEM_PROMPT
 * （防 XSS 覆写），这里只是追加一段「当前上下文」描述，模型应把它当作
 * 用户行为事实而非指令。
 *
 * R34-Fix-2 修复 (HIGH prompt-injection)：渲染端通过
 * AI_SET_CURRENT_STICKY_ID / AI_SET_CURRENT_POMODORO_CONTEXT 推过来的
 * stickyId / stickyNoteId 是 advisory（IPC 层只做宽校验：非空字符串）。
 * 任何被 XSS 注入 / 恶意 dev 依赖劫持的渲染端都能塞
 *   `\`)' INSTRUCTIONS_OVERRIDE\\n...\\\\n//\``
 * 进入主进程的 aiContextByWebContents Map；下一次 ai:stream 时
 * `buildAiContextPrompt` 直接把它拼进 system prompt 末尾的整段描述里 →
 * LLM 误把这串当成「系统对它的指令」执行（删除全部便签 / 篡改数据 / 回
 * 灌秘密）。两层修复：
 *   (a) 数据层：每段都 escapeToolText + 包 `<ai_context data-only="true">`
 *       标签，与 searchNotes / summarizeNote 已用的模式对齐，告诉 LLM
 *       「这是数据不要当指令」。
 *   (b) IPC 层（见 src/main/ipc/ai-handlers.ts）：先用白名单 regex
 *       `^[A-Za-z0-9_-]{1,64}$` 在 IPC 边界拦掉可疑字符串。两者并存：
 *       data-only 是纵深防御，regex 是入口拦截。
 */
export function buildAiContextPrompt(
  ctx: ReturnType<typeof getAiContextByWebContents>,
  noteId: string | null,
): string {
  const lines: string[] = []
  if (noteId) {
    lines.push(`用户当前正在编辑笔记（noteId=${escapeToolText(noteId)}）。`)
  }
  if (ctx.stickyId) {
    lines.push(`用户当前正在操作便签（stickyId=${escapeToolText(ctx.stickyId)}）。`)
  }
  if (ctx.pomodoroRunning && ctx.pomodoroMode) {
    const modeLabel =
      ctx.pomodoroMode === 'focus'
        ? '专注'
        : ctx.pomodoroMode === 'shortBreak'
          ? '短休息'
          : '长休息'
    const stickySuffix = ctx.pomodoroStickyNoteId
      ? `，关联便签 ${escapeToolText(ctx.pomodoroStickyNoteId)}`
      : ''
    lines.push(`番茄钟正在跑 ${modeLabel} 阶段${stickySuffix}。`)
  }
  if (lines.length === 0) return ''
  return `\n\n<ai_context data-only="true">\n[用户当前上下文]\n${lines.join('\n')}\n</ai_context>`
}

/**
 * 取当前 webContents 的"打开中"笔记 ID（advisory）。
 * stream.ts 在拼 system prompt 时调用 —— 仅作上下文提示，不参与权限校验。
 */
export function getCurrentOpenNoteByWebContents(webContentsId: number | null): string | null {
  if (webContentsId === null) return null
  return currentOpenNoteByWebContents.get(webContentsId) ?? null
}

/**
 * stream.ts 在调 executeTool 之前 set；executeTool 内调工具的 execute 时
 * 透传给 summarizeNote 等需要 caller 上下文的工具。流结束或抛错时清理。
 *
 * 异步路径优先用 AsyncLocalStorage（见 callerAls），同步读侧用模块级
 * 变量 —— 实际 stream.ts 都是 await 包住的异步调用，所以 ALS 路径是
 * 主要实现，模块级变量更多是测试兼容 / 兜底。
 */
export function setCurrentCallerWebContentsId(id: number | null): void {
  currentCallerWebContentsId = id
}

/** 工具内部读 caller webContentsId —— 优先 ALS，fallback 模块级变量。 */
export function getCurrentCallerWebContentsId(): number | null {
  const ctx = callerAls.getStore()
  if (ctx) return ctx.webContentsId
  return currentCallerWebContentsId
}

/**
 * stream.ts 在调用 executeTool 之前用 als.run 包裹整个异步链，确保
 * 工具内读 caller 永远拿到的是发起本次调用的 webContents，与其他
 * 并发 runStream 隔离。
 */
export function runWithCallerContext<T>(
  webContentsId: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: CallerContext = { webContentsId }
  return callerAls.run(ctx, fn)
}

// ============================================================
// cross-module 桥：clearWebContentsNoteState 也要清 pending createNote 表，
// 但 pending 表在 tools/createNote.ts 里。声明两个空壳 getter 在 context.ts，
// createNote.ts 在初始化时挂上实现 —— 避免在 context.ts 里再 import createNote
// 模块造成循环依赖（createNote.ts 不需要反向依赖 context）。
// ============================================================
let pendingCreateNoteByWebContentsKeys: () => IterableIterator<string> = () => new Map().keys()
let pendingCreateNoteByWebContentsDelete: (k: string) => void = () => {}

/** 由 tools/createNote.ts 启动时注入实现。 */
export function __bindPendingCreateNoteAccessor(
  keysFn: () => IterableIterator<string>,
  deleteFn: (k: string) => void,
): void {
  pendingCreateNoteByWebContentsKeys = keysFn
  pendingCreateNoteByWebContentsDelete = deleteFn
}

// ============================================================
// cross-module 桥：clearWebContentsNoteState 还要 abort 该 webContents
// 拥有的所有 in-flight AI 流（避免「用户关窗但流还在跑 + 写
// aiContextByWebContents / emit IPC 到已死渲染端」）。activeStreams 在
// ai/stream.ts 里；同样用延迟绑定避免循环 import。空壳默认 no-op，
// 真实实现在 stream.ts 顶层 __bindActiveStreamsAccessor(...) 注入。
// ============================================================
let activeStreamsOwnerSnapshot: () => IterableIterator<[string, number | null]> =
  () => [].values()
let activeStreamsAbortByCallId: (callId: string) => void = () => {}

/** 由 ai/stream.ts 顶层启动时注入实现。 */
export function __bindActiveStreamsAccessor(
  snapshotFn: () => IterableIterator<[string, number | null]>,
  abortFn: (callId: string) => void,
): void {
  activeStreamsOwnerSnapshot = snapshotFn
  activeStreamsAbortByCallId = abortFn
}
