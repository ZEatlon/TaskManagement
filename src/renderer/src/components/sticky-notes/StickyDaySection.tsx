/**
 * 单日 section —— sticky header + 便签列表
 *
 * 设计：
 *   - 每张便签本身就是编辑器（标题 input 内联编辑、步骤内联编辑）
 *   - "+ 新建便签" → 直接在 store 中创建一条空标题便签，新卡片自动聚焦标题 input
 *   - 标题为空时失焦 → 自动删除该空便签（避免误创建空白便签）
 *
 * 结构：
 *   <section ref={sectionRef}>
 *     <header sticky> 日期 + 添加便签按钮 </header>
 *     <grid> 便签卡 × N </grid>
 *   </section>
 */
import { forwardRef, memo, useCallback, useState } from 'react'
import type {
  StickyNote,
  StickyNoteUpdate,
  StickyNoteStepPatch,
} from '@shared/types'
import { StickyNoteCard } from './StickyNoteCard'
import { formatDayHeader } from '../../lib/formatDate'

interface Props {
  dateKey: string
  notes: StickyNote[]
  isToday: boolean
  onUpdate: (id: string, patch: StickyNoteUpdate) => void
  onDelete: (id: string) => void
  onAddStep: (noteId: string, content: string) => void
  onUpdateStep: (noteId: string, stepId: string, patch: StickyNoteStepPatch) => void
  onRemoveStep: (noteId: string, stepId: string) => void
  /**
   * 内联新建：创建一条空标题便签并返回新 id；父组件负责把新 id 透传给新卡片用于自动聚焦。
   * 之所以独立于 onCreate，是因为新便签没有用户填的字段、默认 status 也由 store 推断。
   */
  onCreateEmpty: (dateKey: string) => Promise<string | null> | string | null
  /** 可选：状态变更协调器（H1：done 必须走 complete 而不是 update） */
  onStatusChange?: (id: string, status: StickyNote['status']) => void
  /** 可选：软删除协调器（P0-3：archive + toast 撤销） */
  onSoftDelete?: (note: StickyNote) => void
}

/**
 * R7F-4 修复：用 React.memo 包裹 StickyDaySection。
 *
 * 父组件 StickyTimeline 在每次键盘搜索 / 过滤切换 / store 更新时都会重渲
 * 所有日 section，sectionProps 是 fresh object literal。每个未被 memo 的
 * section 都会重新 reconcile 自己所有 StickyNoteCard（即使 notes 引用未变）。
 *
 * 默认 React.memo 用 Object.is 比较 props。notes 是 store 派生的稳定数组
 * （immer/store 内部冻结），其余函数 prop 来自 useCallback / 父级 useMemo。
 * StickyNoteCard 仍会因 notes 变化而更新 —— 这是正常的，单卡更新链路已通。
 */
function StickyDaySectionInner(
  {
    dateKey,
    notes,
    isToday,
    onUpdate,
    onDelete,
    onAddStep,
    onUpdateStep,
    onRemoveStep,
    onCreateEmpty,
    onStatusChange,
    onSoftDelete,
  }: Props,
  ref: React.ForwardedRef<HTMLElement>,
) {
  // 记录上一次新建的便签 id → 用于新卡片挂载时自动聚焦标题
  const [newNoteId, setNewNoteId] = useState<string | null>(null)

  const handleCreateEmpty = useCallback(async () => {
    const id = await onCreateEmpty(dateKey)
    if (id) setNewNoteId(id)
  }, [dateKey, onCreateEmpty])

  // 新便签 id 变化后，约 1s 清掉状态，避免后续重新挂载时仍触发聚焦
  // （用 ref / state 都可，这里用 timeout 简化）
  const handleAutoFocusConsumed = useCallback(() => {
    setNewNoteId(null)
  }, [])

  return (
    <section
      ref={ref}
      className={`sticky-day-section${isToday ? ' is-today' : ''}`}
      data-date={dateKey}
    >
      <header className="sticky-day-header">
        <div className="day-label">
          <span className="day-text">{formatDayHeader(dateKey)}</span>
          <span className="day-count">{notes.length} 张便签</span>
        </div>
        <button
          type="button"
          className="add-note-btn"
          onClick={() => void handleCreateEmpty()}
        >
          + 新建便签
        </button>
      </header>

      {notes.length === 0 ? (
        <div className="sticky-day-empty">这一天还没有便签，点上方按钮开始创建 ✨</div>
      ) : (
        <div className="sticky-day-notes">
          {notes.map((n) => (
            <StickyNoteCard
              key={n.id}
              note={n}
              isNew={n.id === newNoteId}
              onAutoFocusConsumed={handleAutoFocusConsumed}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onAddStep={onAddStep}
              onUpdateStep={onUpdateStep}
              onRemoveStep={onRemoveStep}
              onStatusChange={onStatusChange}
              onSoftDelete={onSoftDelete}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export const StickyDaySection = memo(forwardRef<HTMLElement, Props>(StickyDaySectionInner))