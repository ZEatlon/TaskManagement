/**
 * 即将到期便签
 *
 * 显示未来 7 天内 dueAt 的便签（最多 5 个）。
 * 排序：dueAt 升序 → 优先级降序（P0 > P3）。
 *
 * stickies 与 upcoming 由父组件传入；不传时由组件自行派生。
 */
import { useMemo } from 'react'
import type { Priority, StickyNote } from '@shared/types'
import { StickyNoteCard } from '../sticky-notes/StickyNoteCard'
import type {
  StickyNoteUpdate,
  StickyNoteStepPatch,
} from '@shared/types'

const PRIORITY_RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

/** 把日期格式化为人类可读的相对时间 */
function formatRelative(iso: string): string {
  const target = new Date(iso)
  target.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '明天'
  if (diffDays === 2) return '后天'
  if (diffDays > 0 && diffDays <= 7) return `${diffDays} 天后`
  return target.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function deriveUpcoming(stickies: StickyNote[], limit: number): StickyNote[] {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 7)

  const list: StickyNote[] = []
  for (const n of stickies) {
    if (n.status === 'done' || n.status === 'cancelled') continue
    if (n.archived) continue
    if (!n.dueAt) continue
    const due = new Date(n.dueAt)
    if (due >= start && due <= end) {
      list.push(n)
    }
  }

  list.sort((a, b) => {
    const at = new Date(a.dueAt!).getTime()
    const bt = new Date(b.dueAt!).getTime()
    if (at !== bt) return at - bt
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  })

  return list.slice(0, limit)
}

interface Props {
  /** 当前便签列表 */
  stickies: StickyNote[]
  /** 由父组件派生一次的即将到期便签列表；不传则由本组件基于 stickies 计算 */
  upcoming?: StickyNote[]
  /** 显示上限，默认 5 */
  limit?: number
  /** 便签点击回调 */
  onSelect?: (note: StickyNote) => void
  onUpdate?: (id: string, patch: StickyNoteUpdate) => void
  onDelete?: (id: string) => void
  onAddStep?: (noteId: string, content: string) => void
  onUpdateStep?: (noteId: string, stepId: string, patch: StickyNoteStepPatch) => void
  onRemoveStep?: (noteId: string, stepId: string) => void
  /** 状态变更（H1：done 走 complete / 其它走 setStatus） */
  onStatusChange?: (id: string, status: StickyNote['status']) => void
}

/**
 * 即将到期便签面板 — 沿用 UpcomingTasks 名称空间的展示布局，
 * 但渲染内容已替换为 sticky_note 卡片缩略。
 */
export function UpcomingStickies({
  stickies,
  upcoming: providedUpcoming,
  limit = 5,
  onSelect,
  onUpdate,
  onDelete,
  onAddStep,
  onUpdateStep,
  onRemoveStep,
  onStatusChange,
}: Props) {
  const upcoming = useMemo<StickyNote[]>(
    () => providedUpcoming ?? deriveUpcoming(stickies, limit),
    [stickies, providedUpcoming, limit],
  )

  return (
    <div className="upcoming-tasks">
      <header className="card-header">
        <h3>即将到期</h3>
        <span className="muted">未来 7 天</span>
      </header>

      {upcoming.length === 0 ? (
        <div className="empty-mini">未来 7 天暂无便签 ✨</div>
      ) : (
        <ul className="upcoming-list">
          {upcoming.map((n) => (
            <li key={n.id} className="upcoming-item">
              {/* R17 修复 (high a11y)：原 .upcoming-sticky-wrap 套 role='button'
                  + tabIndex + onClick 把整个便签卡片（内部含多个 button / checkbox
                  —— 删除按钮、步骤勾选框等）变成 ARIA 嵌套交互元素，违反
                  ARIA 1.2 §4.1「interactive descendant of interactive element」
                  规则；SR 会读出混乱的「button → button → 删除对话」树，
                  且键盘焦点管理混乱。改为：在卡片外部渲染独立「打开」按钮
                  （屏幕外可见位置），卡片本身保留中性 role，由卡片内已有的
                  button 负责交互。鼠标点击卡片仍可触发 onSelect（点击区域
                  不含按钮时），键盘 / SR 用户通过 Tab 进入「打开」按钮。
                  ---
                  R18 修复 (high ux)：R17 版本的 wrap 上无条件 onClick={() => onSelect?.(n)}
                  仍然会被卡片内部按钮的 click 事件冒泡触发 —— 用户点 StickyNoteCard
                  里的「删除」按钮，事件先冒泡到 delete handler（弹删除确认），再
                  冒泡到 wrap 上的 onClick（触发 onSelect → 弹编辑对话框）。结果
                  同一时刻打开两个对话框，确认其中一个时另一个还会挂着，UX 错乱。
                  修复：wrap 上的 onClick 只在 target === currentTarget 时触发
                  （即直接点 wrap 空白处 / 卡片非交互区域），让内部 button 的
                  click 冒泡到此直接被忽略。 */}
              <div
                className="upcoming-sticky-wrap"
                onClick={(e) => {
                  if (e.target === e.currentTarget) onSelect?.(n)
                }}
              >
                <StickyNoteCard
                  note={n}
                  onUpdate={onUpdate ?? (() => {})}
                  onDelete={onDelete ?? (() => {})}
                  onAddStep={onAddStep ?? (() => {})}
                  onUpdateStep={onUpdateStep ?? (() => {})}
                  onRemoveStep={onRemoveStep ?? (() => {})}
                  onStatusChange={onStatusChange}
                />
              </div>
              {onSelect && (
                <button
                  type="button"
                  className="upcoming-open-btn"
                  aria-label={`打开便签 ${n.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(n)
                  }}
                >
                  打开
                </button>
              )}
              <span className="upcoming-when">
                {n.dueAt ? `📅 ${formatRelative(n.dueAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* onCreate 占位已移除；如需"新增便签"按钮，由父组件自行渲染 */}
    </div>
  )
}

/** 向后兼容旧名字（先前导出名为 UpcomingTasks） */
export const UpcomingTasks = UpcomingStickies
export default UpcomingStickies
