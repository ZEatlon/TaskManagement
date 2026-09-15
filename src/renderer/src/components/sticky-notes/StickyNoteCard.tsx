/**
 * 便签卡片 —— post-it 风格单张便签
 *
 * 视觉：
 *   - 背景色按 priority 派生；用户 color 字段覆盖（CSS .color-* 类）
 *   - ::before 折角 + nth-child 轻微旋转
 *   - 折叠式 meta：star / dueAt / tags / estimatedMinutes（默认折叠，hover 展开）
 *   - archived 时整卡灰显 + 「已归档」水印
 *   - status='done' 时半透明
 *   - 删除 = 软删除（180ms 淡出动画 + toast 撤销 5s）
 *
 * 数据：
 *   - 标题 onBlur 自动保存
 *   - 优先级 onChange 自动保存
 *   - star 切换 / archived 切换 / 状态切换 全部走 props 回调
 *   - step CRUD 通过 props 回调
 *   - isNew：新建的便签挂载后聚焦标题 input；聚焦一次后回调消费，状态清掉避免重复聚焦
 *   - 标题失焦时若仍为空 → 自动删除（避免误创建空白便签）
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  StickyNote,
  StickyNoteUpdate,
  StickyNoteStepPatch,
  Priority,
} from '@shared/types'
import { StickyPriorityBadge } from './StickyPriorityBadge'
import { StickyStepRow } from './StickyStepRow'
import { InlineAIButton } from '../ai/InlineAIButton'
import { useAiStore } from '../../stores/ai'
import { aiApi } from '../../lib/ipc'

/**
 * R-fix-IPC-storm (medium #1)：StickyNoteCard mount/unmount 各自向主进程
 * 推一次 setCurrentStickyId / clearStickyIdIfMatches IPC。StickyTimeline
 * 首屏一次性挂 INITIAL_RADIUS=7（15 天窗口）所有卡片时，IPC channel 被
 * 瞬间打满（mount 阶段 N 次 setCurrentStickyId + 卸载阶段 N 次
 * clearStickyIdIfMatches）。store.setContext 已经在 store 内部做了 shallow
 * 去重，但 aiApi.* 走的是 IPC round-trip —— 不在 store 内部，没法靠
 * shallow compare 节省。
 *
 * 修法：模块级 microtask batching —— 同 React commit 内的多次 push / clear
 * 只发最后一次 IPC。store.setContext 仍然每次都同步调用（store 浅比较
 * + Zustand set() 自动短路，廉价得多），保持「最近一次 mount 覆盖
 * stickyId」的既有语义；只是把 IPC round-trip 折叠成 1 次。
 *
 * 注：清空路径依然走主进程 compare-and-clear（aiApi.clearStickyIdIfMatches），
 * 所以即便 batch 把 60 次 clear 折成 1 次且 noteId 不是真正的 owner，
 * 主进程侧也会因为 stickyId 不匹配直接 no-op，不会误清。
 */
let pendingStickyPushId: string | undefined
let stickyPushScheduled = false

function scheduleStickyIdPush(stickyId: string): void {
  pendingStickyPushId = stickyId
  if (stickyPushScheduled) return
  stickyPushScheduled = true
  queueMicrotask(() => {
    stickyPushScheduled = false
    const id = pendingStickyPushId
    pendingStickyPushId = undefined
    if (id === undefined) return
    void aiApi.setCurrentStickyId(id).catch(() => undefined)
  })
}

let pendingStickyClearId: string | undefined
let stickyClearScheduled = false

function scheduleStickyIdClear(noteId: string): void {
  pendingStickyClearId = noteId
  if (stickyClearScheduled) return
  stickyClearScheduled = true
  queueMicrotask(() => {
    stickyClearScheduled = false
    const id = pendingStickyClearId
    pendingStickyClearId = undefined
    if (id === undefined) return
    void aiApi.clearStickyIdIfMatches(id).catch(() => undefined)
  })
}

interface Props {
  note: StickyNote
  /** 新建便签标记：true 时挂载后自动聚焦标题 input */
  isNew?: boolean
  /** isNew 触发一次聚焦后由父组件消费，避免后续 prop 变化重复聚焦 */
  onAutoFocusConsumed?: () => void
  onUpdate: (id: string, patch: StickyNoteUpdate) => void
  onDelete: (id: string) => void
  onAddStep: (noteId: string, content: string) => void
  onUpdateStep: (noteId: string, stepId: string, patch: StickyNoteStepPatch) => void
  onRemoveStep: (noteId: string, stepId: string) => void
  /** 可选：传入删除回调的"软删除协调器"以便发出 toast 撤销 */
  onSoftDelete?: (note: StickyNote) => void
  /**
   * 可选：状态变更协调器 —— 走 setStatus/complete 而不是 update，
   * 保证 status='done' 时正确写入 completions 表。
   */
  onStatusChange?: (id: string, status: StickyNote['status']) => void
  /**
   * R-fix-focus-sticky-noop：AI navigate 跳到这条便签时被设为 true，
   * 卡片加 is-highlight 类（CSS 2.5s pulse）。父组件 2.5s 后自动清掉。
   * 同时给 article 加 data-note-id 属性以便 StickyTimeline 用
   * document.querySelector 定位滚动目标。
   */
  isHighlight?: boolean
}

export const StickyNoteCard = memo(function StickyNoteCard({
  note,
  isNew,
  onAutoFocusConsumed,
  onUpdate,
  onDelete,
  onAddStep,
  onUpdateStep,
  onRemoveStep,
  onSoftDelete,
  onStatusChange,
  isHighlight,
}: Props) {
  const [titleDraft, setTitleDraft] = useState(note.title)
  const [removing, setRemoving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // R31-A11yPerf-4 修复补充：blur→delete 微任务的协调位。
  // pending=true 时表示「下一次 click 是 blur 触发的相邻按钮接管」，
  // 同卡的 button onClick 看到这个位就跳过自己的 onSoftDelete 调用，
  // 避免「blur 删一次 + click 又删一次」的重复 IPC。
  const deleteRef = useRef<{
    pending: boolean
    noteId: string | null
    timer: number | null
  }>({ pending: false, noteId: null, timer: null })
  // R11 修复 (medium #23) + 二次加固：
  // 原版 useEffect 直接在任何 note.title 变化时 setTitleDraft(note.title)，
  // 会把用户正在输入的草稿整段覆盖掉。现在用 lastSyncedTitleRef 只在
  // 「外部实际触发了 title 更新（与当前 draft 不同源）」或「noteId 切换」时
  // 才同步；用户编辑中（titleDraft !== lastSyncedTitleRef.current）一律
  // 不动 draft —— 这样 IPC 推送的远端更新即便 note.title 已被 store 改写，
  // 也无法抹掉用户已经敲进去的字符。
  //
  // 注意：编辑完成（blur 提交 / 放弃）后必须在 handleTitleBlur 里把
  // lastSyncedTitleRef 推进到当前 draft，否则这条基线永远停留在编辑开始
  // 前的旧值，导致后续 IPC 推送被持续当作"用户在编辑中"而丢弃。
  const lastSyncedTitleRef = useRef(note.title)

  // 同步外部 title：仅当 note.id 变化 / note.title 与上次同步值不同 且
  // 用户未在编辑时才刷新 draft。用户编辑中（draft 已偏离 lastSynced 基线）
  // 的外部更新一律丢弃，让用户的 blur 提交作为最终裁决。
  useEffect(() => {
    if (lastSyncedTitleRef.current === note.title) return
    // 用户在编辑中：draft 已偏离 lastSynced 基线，外部更新不能覆盖草稿。
    if (titleDraft !== lastSyncedTitleRef.current) return
    lastSyncedTitleRef.current = note.title
    setTitleDraft(note.title)
  }, [note.id, note.title])

  // AI 上下文同步：把当前便签 ID 推到 useAiStore + 主进程。
  // 卸载 / 切换到别的便签时清空（避免 stale id 误导 updateSticky / searchStickies 等工具）。
  // 注意：同屏可能有多个 StickyNoteCard（时间线 / 当日列表），每个都注册
  // 会互相覆盖。后挂载的覆盖前面的 —— 用户视角下"最近点击 / hover 的便签"
  // 是优先目标。InlineAIButton 主动调 openWithPrompt 时再覆盖一次以确保
  // prompt 里的 id 与上下文匹配。
  const setContext = useAiStore((s) => s.setContext)
  useEffect(() => {
    setContext({ stickyId: note.id })
    // IPC 走 microtask batching（同 task 内多次 mount 只推最后一次），
    // 见文件顶部 scheduleStickyIdPush 注释。setContext 保留同步 —— store
    // 内部 shallow 比较 + Zustand 自动短路远比 IPC round-trip 廉价。
    scheduleStickyIdPush(note.id)
    return () => {
      // 卸载时若当前上下文仍是本便签才清空，否则说明已被其它卡覆盖，
      // 别瞎清。resetContext 是把整个 context 清成 {}，可能误伤其它
      // 上下文字段；这里只清 stickyId，保留 noteId / pomodoro 等。
      const current = useAiStore.getState().context
      if (current.stickyId === note.id) {
        setContext({ stickyId: undefined })
      }
      // 主进程侧：compare-and-clear 守卫 —— 仅当 stickyId 仍等于本卡
      // noteId 时才清空。多张 StickyNoteCard 同挂（A mount → B mount
      // 覆盖 stickyId → A 卸载）时，A 的 cleanup 之前是无脑 set(null)，
      // 会把 B 已经推过来的 stickyId 误清；主进程 LLM 工具调用落到 null
      // fallback 走"no sticky context"，错选实体或拒绝动作。R33 修复。
      // IPC 同样走 microtask batching（同 task 内多次 unmount 只发最后一次
      // clear；主进程侧如果 noteId 不匹配仍然 no-op）。
      scheduleStickyIdClear(note.id)
    }
    // 故意不把 setContext 放进 deps —— store action 引用在 useAiStore
    // 内部稳定，重跑这个 effect 没意义。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])

  // 新建便签：自动聚焦标题一次
  useEffect(() => {
    if (!isNew) return
    // 等下一帧再聚焦，确保 DOM 已就绪 + CSS 类已挂上
    const id = window.setTimeout(() => {
      titleRef.current?.focus()
      // 触发一次聚焦后消费标记，避免后续 isNew 变化时再次触发
      onAutoFocusConsumed?.()
    }, 50)
    return () => window.clearTimeout(id)
  }, [isNew, onAutoFocusConsumed])

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setTitleDraft(e.target.value),
    [],
  )

  const handleTitleBlur = useCallback(() => {
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== note.title) {
      // 保存新标题
      onUpdate(note.id, { title: trimmed })
    } else if (!trimmed) {
      // R31-A11yPerf-4 修复 (MEDIUM double-soft-delete)：原版 blur 时立即
      // 同步调 onSoftDelete —— 但若用户焦点从 title input 转到同卡内
      // 的其他按钮（删除 ✕、星标 ☆、归档、status select），这些按钮
      // 自身的 onClick 也会调 onSoftDelete / onDelete。结果：**一次点
      // 击触发两条 IPC archive**，数据库虽幂等，但 IPC 往返翻倍 +
      // toast 计时被覆盖重置。最坏情况是快速连点造成 IPC 风暴。
      //
      // 修复：把 blur 删除推迟到 setTimeout(0)，让「焦点切换」的 click
      // handler 先跑；同时记录 deleteRef 让后续 click handler 跳过重
      // 复删除。具体顺序：
      //   1) blur 进入 → schedule 微任务延迟
      //   2) 同卡内 button click → 看 deleteRef.pending → 清掉 timeout
      //      并跳过自己的 onSoftDelete（让 microtask 处理）
      //   3) 切到卡外元素 → timeout 触发 onSoftDelete（正确路径）
      if (deleteRef.current.pending) {
        // 已被同卡内其它 handler 接管，blur 不再重复触发。
        return
      }
      deleteRef.current.pending = true
      deleteRef.current.noteId = note.id
      deleteRef.current.timer = window.setTimeout(() => {
        deleteRef.current.pending = false
        deleteRef.current.noteId = null
        deleteRef.current.timer = null
        // R33 修复 (high #1)：即便 cleanup 跑了 mountedRef 也要二次校验，
        // 避免任何逃逸的 timer 在已卸载组件上调用 onSoftDelete / onDelete。
        if (!mountedRef.current) return
        if (onSoftDelete) {
          onSoftDelete(note)
        } else {
          onDelete(note.id)
        }
      }, 0)
      // 把本地 draft 重置回 note.title，避免 blur 后 input 显示空白
      setTitleDraft(note.title)
    }
    // R11 二次加固：blur 时把 lastSyncedTitleRef 推进到当前 draft（裁剪后；
    // 空标题会被软删除分支重置回 note.title，所以这里同样回退到 note.title）。
    // 否则上一次编辑开始前的旧基线会让 effect 持续把后续 IPC 推送当成
    // "用户在编辑中"而丢弃，外部同步永远回不到 input。
    lastSyncedTitleRef.current = trimmed || note.title
  }, [titleDraft, note, onUpdate, onDelete, onSoftDelete])

  const handleTitleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.currentTarget.blur()
      } else if (e.key === 'Escape') {
        // Esc 撤销当前编辑；若标题为空 → 静默删除
        if (!titleDraft.trim()) {
          // R33 修复 (high #1)：Escape 是同步事件，理论上不需要 mounted 守卫；
          // 但若 Esc 触发时父组件正在卸载（罕见，但理论上 React 18 StrictMode
          // 下可能存在），同样要避免回灌。mountedRef 二次校验成本极低。
          if (!mountedRef.current) return
          if (onSoftDelete) {
            onSoftDelete(note)
          } else {
            onDelete(note.id)
          }
        }
        setTitleDraft(note.title)
        e.currentTarget.blur()
      }
    },
    [titleDraft, note, onDelete, onSoftDelete],
  )

  const handlePriorityChange = useCallback(
    (next: Priority) => {
      if (next !== note.priority) onUpdate(note.id, { priority: next })
    },
    [note.id, note.priority, onUpdate],
  )

  const handleToggleStar = useCallback(() => {
    onUpdate(note.id, { starred: !note.starred })
  }, [note.id, note.starred, onUpdate])

  const handleArchiveToggle = useCallback(() => {
    onUpdate(note.id, { archived: !note.archived })
  }, [note.id, note.archived, onUpdate])

  const handleStatusChange = useCallback(
    (status: StickyNote['status']) => {
      if (status === note.status) return
      if (onStatusChange) {
        // 走 status 专用通道（done → complete + completions；其它 → setStatus）
        onStatusChange(note.id, status)
        return
      }
      onUpdate(note.id, { status })
    },
    [note.id, note.status, onStatusChange, onUpdate],
  )

  // R5-23：软删除的 setTimeout 必须挂在 ref 上，组件卸载时 clearTimeout，
  // 否则路由切换 / 父组件重渲染会让 setTimeout 在已卸载组件上触发 onDelete。
  const softDeleteTimerRef = useRef<number | null>(null)
  // R33 修复 (high #1)：组件挂载标志，用于在卸载后阻断 in-flight 的
  // deleteRef 微任务 / softDeleteTimer 回调再次回灌 onDelete / onSoftDelete。
  // 即便卸载 cleanup 没赶上（极端时序：clearTimeout 与 setTimeout 回调之间
  // 切换时钟 / setTimeout 已经派发但 callback 还没跑），mounted=false 也能
  // 阻止 callback 调用 parent 状态，避免 "已卸载组件的 IPC" 现象。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const handleSoftDelete = useCallback(() => {
    // R31-A11yPerf-4 修复 (MEDIUM double-soft-delete)：当 blur 微任务已经
    // 排好删除（deleteRef.pending=true），同卡内的 button onClick 接管：
    // 由 click 同步触发一次 onSoftDelete（用户点 ✕ 即是删除意图），并清掉
    // blur 排好的 setTimeout —— 避免「clearTimeout 之后两条路径都跑了」与
    // 「clearTimeout 之后没人触发删除」的两个极端。前者要靠同步 click 自己
    // 触发来保证不会双触发 IPC；后者（修前的死锁）则由本次同步触发修复。
    if (deleteRef.current.pending && deleteRef.current.noteId === note.id) {
      if (deleteRef.current.timer !== null) {
        window.clearTimeout(deleteRef.current.timer)
        deleteRef.current.timer = null
      }
      deleteRef.current.pending = false
      deleteRef.current.noteId = null
      // R33 修复 (high #1)：mounted 守卫，避免逃逸 click 在已卸载组件上
      // 回灌 onDelete / onSoftDelete。
      if (!mountedRef.current) return
      if (onSoftDelete) {
        onSoftDelete(note)
      } else {
        onDelete(note.id)
      }
      return
    }
    if (onSoftDelete) {
      onSoftDelete(note)
      return
    }
    setRemoving(true)
    if (softDeleteTimerRef.current !== null) {
      window.clearTimeout(softDeleteTimerRef.current)
    }
    softDeleteTimerRef.current = window.setTimeout(() => {
      softDeleteTimerRef.current = null
      // R33 修复 (high #1)：mountedRef 二次校验，避免逃逸 timer 在已卸载组件
      // 上回灌 onDelete / onSoftDelete。
      if (!mountedRef.current) return
      onDelete(note.id)
    }, 200)
  }, [note, onDelete, onSoftDelete])

  useEffect(() => {
    return () => {
      if (softDeleteTimerRef.current !== null) {
        window.clearTimeout(softDeleteTimerRef.current)
        softDeleteTimerRef.current = null
      }
      // R33 修复 (high #1)：handleTitleBlur 在第 165 行 schedule 的
      // deleteRef.current.timer 之前从未在卸载时被清掉。若组件在
      // blur → 0ms 微任务 之间被卸载（路由切换 / 父组件移除该卡 /
      // 其它 tab 强删等），微任务仍会触发并把 onSoftDelete(note) /
      // onDelete(note.id) 投递给已经不在树上的 note → 多余 IPC +
      // 已卸载卡 toast + closure 持有的 setTimeout/note 引用泄漏。
      // 卸载时一并清理 deleteRef 的 timer 与协调位。
      if (deleteRef.current.timer !== null) {
        window.clearTimeout(deleteRef.current.timer)
        deleteRef.current.timer = null
      }
      deleteRef.current.pending = false
      deleteRef.current.noteId = null
    }
  }, [])

  // 进度统计 —— 用 useMemo 包住，避免无关字段变更触发整卡的 M log M
  // 排序 + M filter + M slice。依赖只有 note.steps，note 其它字段（status /
  // priority / starred / title 等）变更不会让这里重算。
  const sortedSteps = useMemo(
    () => note.steps.slice().sort((a, b) => a.order - b.order),
    [note.steps],
  )
  const doneCount = useMemo(
    () => sortedSteps.reduce((n, s) => (s.done ? n + 1 : n), 0),
    [sortedSteps],
  )
  const totalCount = sortedSteps.length

  // 派生 CSS 类
  const classes = [
    'sticky-note-card',
    `priority-${note.priority}`,
    note.color ? `color-${note.color}` : '',
    note.status === 'done' ? 'is-done' : '',
    note.archived ? 'is-archived' : '',
    removing ? 'is-removing' : '',
    isNew ? 'is-new' : '',
    // R-fix-focus-sticky-noop：AI navigate 命中时高亮 2.5s
    isHighlight ? 'is-highlight' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article
      className={classes}
      // R-fix-focus-sticky-noop：暴露 noteId 让 StickyTimeline 在收到
      // taskpilot:focus-sticky 时通过 querySelector 定位到具体这张卡，
      // 然后 scrollIntoView({block:'center'})。这是避开「把 sticky note
      // store 注入 navigateBridge」反向依赖的最简做法。
      data-note-id={note.id}
      aria-label={`便签「${note.title}」`}
    >
      <div className="sticky-note-header">
        <div className="priority-area">
          <StickyPriorityBadge
            priority={note.priority}
            onChange={handlePriorityChange}
          />
        </div>
        <input
          ref={titleRef}
          type="text"
          className="sticky-note-title"
          value={titleDraft}
          onChange={handleTitleChange}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKey}
          placeholder={isNew ? '输入便签标题…' : '便签标题...'}
          aria-label="便签标题"
        />
        <button
          type="button"
          className="sticky-note-star"
          onClick={handleToggleStar}
          title={note.starred ? '取消星标' : '标记星标'}
          aria-label={note.starred ? '取消星标' : '标记星标'}
        >
          {note.starred ? '★' : '☆'}
        </button>
        {/*
          * AI 触发按钮 —— 放在删除按钮左侧。
          *   - InlineAIButton 自身带 stopPropagation 的 onMouseDown，
          *     不会触发上层卡片的"被点击"逻辑
          *   - 浮层用 fixed 定位，不受 sticky-note-card 的 overflow 影响
          *   - 不影响原有快捷键（焦点仍在 title input / star / remove 上）
          */}
        <InlineAIButton
          target="sticky"
          id={note.id}
          size="sm"
          title="AI 助手（拆解 / 优先级 / 润色）"
        />
        <button
          type="button"
          className="sticky-note-remove"
          onClick={handleSoftDelete}
          title="删除便签"
          aria-label="删除便签"
        >
          ✕
        </button>
      </div>

      {/* meta 行：状态 + 截止 + 标签 + 预估（默认收起，hover 显示） */}
      <div className="sticky-note-meta">
        <select
          className="sticky-note-status"
          value={note.status}
          onChange={(e) => handleStatusChange(e.target.value as StickyNote['status'])}
          aria-label="便签状态"
        >
          <option value="todo">待办</option>
          <option value="in_progress">进行中</option>
          <option value="done">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
        {note.dueAt && (
          <span className="sticky-note-due" title={note.dueAt}>
            📅 {new Date(note.dueAt).toLocaleDateString('zh-CN')}
          </span>
        )}
        {note.estimatedMinutes != null && note.estimatedMinutes > 0 && (
          <span className="sticky-note-est">⏱ {note.estimatedMinutes} 分钟</span>
        )}
        {note.tags.length > 0 && (
          <span className="sticky-note-tags-count">
            🏷 {note.tags.length}
          </span>
        )}
        <button
          type="button"
          className="sticky-note-archive"
          onClick={handleArchiveToggle}
          title={note.archived ? '取消归档' : '归档'}
          aria-label={note.archived ? '取消归档便签' : '归档便签'}
          aria-pressed={note.archived}
        >
          {note.archived ? '取消归档' : '归档'}
        </button>
      </div>

      {sortedSteps.length > 0 && (
        <ul className="sticky-step-list">
          {sortedSteps.map((step, idx) => (
            <StickyStepRow
              key={step.id}
              step={step}
              index={idx}
              onChange={(patch) => onUpdateStep(note.id, step.id, patch)}
              onRemove={() => onRemoveStep(note.id, step.id)}
              onAdd={() => onAddStep(note.id, '')}
              siblings={sortedSteps}
              onReorder={(draggedStepId, targetStepId) => {
                // 把 draggedStep 插入到 targetStep 之前，并批量重排兄弟 steps 的 order。
                const ordered = sortedSteps
                  .filter((s) => s.id !== draggedStepId)
                  .sort((a, b) => a.order - b.order)
                const targetIdx = ordered.findIndex((s) => s.id === targetStepId)
                if (targetIdx < 0) return
                const dragged = sortedSteps.find((s) => s.id === draggedStepId)
                if (!dragged) return
                const next = [...ordered]
                next.splice(targetIdx, 0, dragged)
                next.forEach((s, i) => {
                  if (s.order !== i) onUpdateStep(note.id, s.id, { order: i })
                })
              }}
            />
          ))}
        </ul>
      )}

      <div className="sticky-step-meta">
        <button
          type="button"
          className="sticky-step-add"
          onClick={() => onAddStep(note.id, '')}
          aria-label="添加步骤"
        >
          + 添加步骤
        </button>
        <span
          className="sticky-step-progress"
          role="progressbar"
          aria-valuenow={doneCount}
          aria-valuemin={0}
          aria-valuemax={totalCount}
          aria-valuetext={
            totalCount > 0 ? `${doneCount} / ${totalCount} 步骤已完成` : '无步骤'
          }
        >
          {totalCount > 0 ? `${doneCount}/${totalCount}` : '无步骤'}
        </span>
      </div>
    </article>
  )
})