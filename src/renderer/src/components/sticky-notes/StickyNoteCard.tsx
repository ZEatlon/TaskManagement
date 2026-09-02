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
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  StickyNote,
  StickyNoteUpdate,
  StickyNoteStepPatch,
  Priority,
} from '@shared/types'
import { StickyPriorityBadge } from './StickyPriorityBadge'
import { StickyStepRow } from './StickyStepRow'

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
}

export function StickyNoteCard({
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
  // R11 修复 (medium #23)：原版 useEffect 直接在任何 note.title 变化时
  // setTitleDraft(note.title)，会把用户正在输入的草稿（外部 onUpdate 没回填时
  // note.title 短暂等于旧值 / 用户已敲了几个字但 onBlur 还没触发）整段覆盖掉。
  // 现在用 lastSyncedTitleRef 只在「外部实际触发了 title 更新（与当前 draft
  // 不同源）」或「noteId 切换」时才同步；用户编辑中（titleDraft !== note.title）
  // 且不是用户刚保存的回填 → 不动 draft。
  const lastSyncedTitleRef = useRef(note.title)

  // 同步外部 title：仅当 note.id 变化 / note.title 与上次同步值不同时刷新 draft
  useEffect(() => {
    if (lastSyncedTitleRef.current !== note.title) {
      lastSyncedTitleRef.current = note.title
      setTitleDraft(note.title)
    }
  }, [note.id, note.title])

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
        if (onSoftDelete) {
          onSoftDelete(note)
        } else {
          onDelete(note.id)
        }
      }, 0)
      // 把本地 draft 重置回 note.title，避免 blur 后 input 显示空白
      setTitleDraft(note.title)
    }
  }, [titleDraft, note, onUpdate, onDelete, onSoftDelete])

  const handleTitleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.currentTarget.blur()
      } else if (e.key === 'Escape') {
        // Esc 撤销当前编辑；若标题为空 → 静默删除
        if (!titleDraft.trim()) {
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
  const handleSoftDelete = useCallback(() => {
    // R31-A11yPerf-4 修复 (MEDIUM double-soft-delete)：当 blur 微任务已经
    // 排好删除（deleteRef.pending=true），同卡内的 button onClick 接管：
    // 不再触发第二条 onSoftDelete，让 microtask 那个唯一一次执行。
    if (deleteRef.current.pending && deleteRef.current.noteId === note.id) {
      if (deleteRef.current.timer !== null) {
        window.clearTimeout(deleteRef.current.timer)
        deleteRef.current.timer = null
      }
      deleteRef.current.pending = false
      deleteRef.current.noteId = null
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
      onDelete(note.id)
    }, 200)
  }, [note, onDelete, onSoftDelete])

  useEffect(() => {
    return () => {
      if (softDeleteTimerRef.current !== null) {
        window.clearTimeout(softDeleteTimerRef.current)
        softDeleteTimerRef.current = null
      }
    }
  }, [])

  // 进度统计
  const sortedSteps = note.steps.slice().sort((a, b) => a.order - b.order)
  const doneCount = sortedSteps.filter((s) => s.done).length
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
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article className={classes} aria-label={`便签「${note.title}」`}>
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
}