/**
 * Dashboard 主页（v5 · 直接拖动编辑 + 固定顶部栏）
 *
 * Round 6 重构：
 *   - 问候卡片（GreetingCard）+ 快捷操作（QuickActions）已从 widget 注册表里移除，
 *     作为顶部固定 chrome 始终渲染，不参与拖动 / 隐藏。
 *   - 顶部栏三段式：左侧 greeting（问候+时钟）｜ 中部 quick actions（一行三按钮）｜ 右侧 edit 按钮
 *   - 进入编辑模式后：编辑按钮消失，取而代之出现「编辑工具栏」（预设 + 添加列 + 取消/保存）
 *     —— 工具栏仍位于顶部栏下方，避免与 greeting/quick actions 挤一行。
 *
 * 数据模型：
 *   - `columns: DashboardWidgetKey[][]`  +  `hidden: DashboardWidgetKey[]`
 *   - 持久化：localStorage `dashboard.layout.v5`
 *
 * 编辑态用 draft layout 与已保存的 layout 隔离；保存才写 localStorage。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, GripVertical, Pencil, Plus } from 'lucide-react'
import type { StickyNote, StickyNoteUpdate, StickyNoteStepPatch } from '@shared/types'
import { GreetingCard } from '../components/dashboard/GreetingCard'
import { TodaySummary, type TodayStats } from '../components/dashboard/TodaySummary'
import { StatsCards, type StickyStatusBreakdown } from '../components/dashboard/StatsCards'
import { QuickActions } from '../components/dashboard/QuickActions'
import { HeatmapWidget } from '../components/dashboard/HeatmapWidget'
import { RecentNotes } from '../components/dashboard/RecentNotes'
import { UpcomingStickies } from '../components/dashboard/UpcomingStickies'
import { PomodoroCalendarPanel } from '../components/pomodoro/PomodoroCalendarPanel'
import { PomodoroTimerPanel } from '../components/pomodoro/PomodoroTimerPanel'
import {
  PRESETS,
  PRESET_LABELS,
  WIDGET_LABELS,
  MAX_COLUMNS,
  moveWidget,
  type DashboardWidgetKey,
  type DashboardLayout,
} from '../components/dashboard/DashboardEditorModal'
import { useDashboardLayout } from '../components/dashboard/useDashboardLayout'
import { useStickyNotesStore } from '../stores/stickyNotes'
import { useNotesStore } from '../stores/notes'
import { dayKeyOf } from '../lib/date'

interface DragSource {
  column: number
  index: number
  widget: DashboardWidgetKey
}

export function DashboardRoute() {
  // 数据：便签 / 笔记
  const loadAllFiltered = useStickyNotesStore((s) => s.loadAllFiltered)
  // Perf-fix #3：只订阅 byDate —— `all` 走 getState() 命令式读。
  // 原版同时订阅两个字段 → 任何 sticky mutation 都触发两次 store 比较 +
  // dashboard 子树全部重渲染。loadAllFiltered 把 all 灌到 store 时会同步
  // 写 byDate，因此 byDate 是 single source of truth。
  const byDate = useStickyNotesStore((s) => s.byDate)
  const stickiesLoading = useStickyNotesStore((s) => s.loading)

  const notesLoaded = useNotesStore((s) => s.notes.length > 0)
  const notesLoading = useNotesStore((s) => s.loading)
  const fetchNotes = useNotesStore((s) => s.fetch)

  const todayKey = useMemo(() => dayKeyOf(new Date()), [])

  useEffect(() => {
    void loadAllFiltered({ archived: false, limit: 500 })
    if (!notesLoaded && !notesLoading) {
      void fetchNotes()
    }
  }, [loadAllFiltered, fetchNotes, notesLoaded, notesLoading])

  // 派生 —— `all` 走 getState()（不订阅），与上面 selector 收敛一致。
  const stickies: StickyNote[] = useMemo(() => {
    const allFallback = useStickyNotesStore.getState().all
    if (allFallback && allFallback.length > 0) return allFallback
    return Object.values(byDate).flat()
  }, [byDate])

  const todayStats: TodayStats = useMemo(() => {
    let todayStickies = 0
    let todayDoneSteps = 0
    let overdue = 0
    const todayStart = new Date(`${todayKey}T00:00:00.000`).getTime()
    for (const n of stickies) {
      if (n.date === todayKey) todayStickies++
      if (n.date === todayKey) {
        todayDoneSteps += n.steps.filter((s) => s.done).length
      }
      if (n.status !== 'done' && n.dueAt) {
        const due = new Date(n.dueAt).getTime()
        if (due < todayStart) overdue++
      }
    }
    return { todayStickies, todayDoneSteps, overdue }
  }, [stickies, todayKey])

  const breakdown: StickyStatusBreakdown = useMemo(() => {
    let todo = 0
    let inProgress = 0
    let done = 0
    for (const n of stickies) {
      if (n.archived) continue
      if (n.status === 'todo') todo++
      else if (n.status === 'in_progress') inProgress++
      else if (n.status === 'done') done++
    }
    return { todo, inProgress, done, total: stickies.filter((n) => !n.archived).length }
  }, [stickies])

  // ===== 布局与编辑状态 =====
  const { layout: savedLayout, setLayout } = useDashboardLayout()
  const [draft, setDraft] = useState<DashboardLayout | null>(null)
  const editing = draft !== null
  const currentLayout = draft ?? savedLayout

  const [dragSource, setDragSource] = useState<DragSource | null>(null)
  const [dropTarget, setDropTarget] = useState<{ column: number; index: number } | null>(null)

  // 编辑态：Esc 取消
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDraft(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editing])

  // ===== 便签 CRUD（UpcomingStickies 用）=====
  const handleUpdateSticky = (id: string, patch: StickyNoteUpdate) => {
    void useStickyNotesStore.getState().update(id, patch)
  }
  const handleDeleteSticky = (id: string) => {
    void useStickyNotesStore.getState().remove(id)
  }
  const handleAddStep = (noteId: string, content: string) => {
    void useStickyNotesStore.getState().addStep(noteId, content)
  }
  const handleUpdateStep = (noteId: string, stepId: string, patch: StickyNoteStepPatch) => {
    void useStickyNotesStore.getState().updateStep(noteId, stepId, patch)
  }
  const handleRemoveStep = (noteId: string, stepId: string) => {
    void useStickyNotesStore.getState().removeStep(noteId, stepId)
  }

  // ===== widget → 组件 映射 =====
  // Round 6：greeting / quickActions 不再是 widget —— 它们作为顶部固定 chrome
  // 渲染在 dashboard-topbar 里，与布局编辑器无关。
  const renderWidget = (key: DashboardWidgetKey): JSX.Element | null => {
    switch (key) {
      case 'todaySummary':
        return <TodaySummary stickies={stickies} todayStats={todayStats} />
      case 'statsCards':
        return <StatsCards stickies={stickies} breakdown={breakdown} />
      case 'pomodoroCalendar':
        return <PomodoroCalendarPanel embedded />
      case 'pomodoroTimer':
        return <PomodoroTimerPanel embedded />
      case 'heatmap':
        return <HeatmapWidget />
      case 'upcoming':
        return (
          <UpcomingStickies
            stickies={stickies}
            onSelect={() => undefined}
            onUpdate={handleUpdateSticky}
            onDelete={handleDeleteSticky}
            onAddStep={handleAddStep}
            onUpdateStep={handleUpdateStep}
            onRemoveStep={handleRemoveStep}
          />
        )
      case 'recentNotes':
        return <RecentNotes />
      default:
        return null
    }
  }

  // ===== 编辑动作 =====
  const enterEdit = useCallback(() => {
    setDraft(savedLayout)
  }, [savedLayout])

  const cancelEdit = useCallback(() => {
    setDraft(null)
    setDragSource(null)
    setDropTarget(null)
  }, [])

  const saveEdit = useCallback(() => {
    if (draft) setLayout(draft)
    setDraft(null)
    setDragSource(null)
    setDropTarget(null)
  }, [draft, setLayout])

  const applyPreset = useCallback((preset: keyof typeof PRESETS) => {
    setDraft(PRESETS[preset])
  }, [])

  const addColumn = useCallback(() => {
    setDraft((prev) => {
      if (!prev || prev.columns.length >= MAX_COLUMNS) return prev
      return { ...prev, columns: [...prev.columns, []] }
    })
  }, [])

  const removeColumn = useCallback((columnIdx: number) => {
    setDraft((prev) => {
      if (!prev) return prev
      if (prev.columns.length <= 1) return prev
      const columns = prev.columns.map((col) => [...col])
      const widgets = columns.splice(columnIdx, 1)[0] ?? []
      const adjustedIdx = columnIdx === 0 ? 0 : columnIdx - 1
      if (widgets.length > 0) {
        columns[adjustedIdx] = [...columns[adjustedIdx], ...widgets]
      }
      return { ...prev, columns }
    })
  }, [])

  const toggleHidden = useCallback((key: DashboardWidgetKey) => {
    setDraft((prev) => {
      if (!prev) return prev
      const isHidden = prev.hidden.includes(key)
      if (isHidden) {
        // 显示：加入最后一列末尾
        const columns = prev.columns.map((col) => [...col])
        if (columns.length === 0) columns.push([key])
        else columns[columns.length - 1].push(key)
        return {
          columns,
          hidden: prev.hidden.filter((k) => k !== key),
        }
      }
      // 隐藏：从所在列移除
      const columns = prev.columns.map((col) => col.filter((k) => k !== key))
      return {
        columns,
        hidden: [...prev.hidden, key],
      }
    })
  }, [])

  // ===== 拖拽事件 =====
  const handleDragStart = useCallback(
    (e: React.DragEvent, columnIdx: number, index: number, widget: DashboardWidgetKey) => {
      setDragSource({ column: columnIdx, index, widget })
      e.dataTransfer.effectAllowed = 'move'
      try {
        e.dataTransfer.setData('text/plain', widget)
      } catch {
        // 忽略
      }
    },
    [],
  )

  // 单元格级 dragover/drop：必须 stopPropagation 阻止冒泡到父列，
  // 否则 onDrop 会触发两次（cell 自己 + column），导致 widget 复制。
  const handleDragOver = useCallback(
    (e: React.DragEvent, columnIdx: number, index: number) => {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget({ column: columnIdx, index })
    },
    [],
  )

  const handleColumnDragOver = useCallback(
    (e: React.DragEvent, columnIdx: number) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget((prev) =>
        prev && prev.column === columnIdx
          ? prev
          : { column: columnIdx, index: currentLayout.columns[columnIdx]?.length ?? 0 },
      )
    },
    [currentLayout.columns],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent, columnIdx: number, index: number) => {
      e.preventDefault()
      e.stopPropagation()
      if (!dragSource) return
      setDraft((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          columns: moveWidget(prev.columns, dragSource, columnIdx, index),
        }
      })
      setDragSource(null)
      setDropTarget(null)
    },
    [dragSource],
  )

  const handleDragEnd = useCallback(() => {
    setDragSource(null)
    setDropTarget(null)
  }, [])

  // ===== 派生：可见 widget 数量 =====
  const visibleCount = useMemo(() => {
    const hidden = new Set(currentLayout.hidden)
    return currentLayout.columns.reduce((acc, col) => acc + col.filter((k) => !hidden.has(k)).length, 0)
  }, [currentLayout])

  return (
    <div className={`page dashboard-page ${editing ? 'is-editing' : ''}`}>
      {/* 顶部固定栏：greeting · quick actions · edit 按钮（最右） */}
      <header className="dashboard-topbar" role="banner">
        <div className="dashboard-topbar-greeting">
          <GreetingCard />
        </div>
        <div className="dashboard-topbar-actions">
          <QuickActions />
        </div>
        <div className="dashboard-topbar-edit">
          {!editing ? (
            <button
              type="button"
              className="btn ghost dashboard-edit-btn"
              onClick={enterEdit}
              title="编辑 Dashboard（拖动 widget / 切换列数 / 隐藏）"
            >
              <Pencil size={14} aria-hidden /> 编辑
            </button>
          ) : (
            // 编辑态下：编辑按钮位置展示「编辑中」徽标，避免误以为可重复进入
            <span className="dashboard-topbar-editing-badge" aria-live="polite">
              编辑中…
            </span>
          )}
        </div>
      </header>

      {/* 编辑态：编辑工具栏（预设 + 添加列 + 取消/保存） */}
      {editing && (
        <div className="dashboard-edit-toolbar" role="toolbar" aria-label="Dashboard 编辑">
          <div className="dashboard-edit-toolbar-presets">
            <span className="muted small">预设：</span>
            {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
              <button
                key={p}
                type="button"
                className="btn ghost dashboard-edit-preset"
                onClick={() => applyPreset(p)}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
            <button
              type="button"
              className="btn ghost dashboard-edit-add-col"
              onClick={addColumn}
              disabled={currentLayout.columns.length >= MAX_COLUMNS}
              title={currentLayout.columns.length >= MAX_COLUMNS ? `已达 ${MAX_COLUMNS} 列上限` : '添加一列'}
            >
              <Plus size={14} aria-hidden /> 添加列
            </button>
          </div>
          <div className="dashboard-edit-toolbar-actions">
            <button type="button" className="btn ghost" onClick={cancelEdit}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={saveEdit}>
              保存
            </button>
          </div>
        </div>
      )}

      {/* 主体：动态多栏布局 */}
      <div
        className="dashboard-cols"
        style={{ ['--col-count' as string]: String(currentLayout.columns.length) }}
      >
        {currentLayout.columns.map((column, ci) => (
          <div
            key={ci}
            className="dashboard-col dashboard-col-stack"
            onDragOver={editing ? (e) => handleColumnDragOver(e, ci) : undefined}
            onDrop={
              editing
                ? (e) => {
                    const targetIdx =
                      dropTarget?.column === ci ? dropTarget.index : column.length
                    handleDrop(e, ci, targetIdx)
                  }
                : undefined
            }
          >
            {column.map((key, idx) => {
              if (currentLayout.hidden.includes(key)) return null
              const isDragging = dragSource?.widget === key
              const isDropBefore =
                editing && dropTarget?.column === ci && dropTarget?.index === idx && dragSource !== null
              const cellClass = [
                'dashboard-cell',
                `dashboard-cell-${key}`,
                editing ? 'is-editable' : '',
                isDragging ? 'is-dragging' : '',
                isDropBefore ? 'is-drop-target' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <div
                  key={key}
                  className={cellClass}
                  draggable={editing}
                  onDragStart={editing ? (e) => handleDragStart(e, ci, idx, key) : undefined}
                  onDragOver={editing ? (e) => handleDragOver(e, ci, idx) : undefined}
                  onDrop={editing ? (e) => handleDrop(e, ci, idx) : undefined}
                  onDragEnd={editing ? handleDragEnd : undefined}
                  aria-grabbed={isDragging}
                >
                  {editing && (
                    <>
                      <span
                        className="dashboard-cell-handle"
                        aria-hidden
                        title="拖动调整位置"
                      >
                        <GripVertical size={14} />
                      </span>
                      <button
                        type="button"
                        className="dashboard-cell-toggle"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleHidden(key)
                        }}
                        aria-label="隐藏 widget"
                        title="隐藏"
                      >
                        <EyeOff size={14} aria-hidden />
                      </button>
                    </>
                  )}
                  <div className="dashboard-cell-body">{renderWidget(key)}</div>
                </div>
              )
            })}
            {editing && currentLayout.columns.length > 1 && (
              <button
                type="button"
                className="btn ghost dashboard-col-stack-remove-col"
                onClick={() => removeColumn(ci)}
                title="删除该列，widget 并入前一列"
              >
                删除列
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 编辑态：隐藏 widget 列表 */}
      {editing && currentLayout.hidden.length > 0 && (
        <details className="dashboard-edit-hidden-tray" open>
          <summary className="muted small">
            已隐藏的 widget（{currentLayout.hidden.length}）— 点击眼睛还原
          </summary>
          <ul className="dashboard-edit-hidden-list">
            {currentLayout.hidden.map((key) => (
              <li key={key} className="dashboard-edit-hidden-item">
                <span>{WIDGET_LABELS[key]}</span>
                <button
                  type="button"
                  className="dashboard-cell-toggle"
                  onClick={() => toggleHidden(key)}
                  aria-label="显示 widget"
                  title="显示"
                >
                  <Eye size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 加载提示 */}
      {stickiesLoading && stickies.length === 0 && (
        <div className="dashboard-loading muted small">便签加载中…</div>
      )}

      {/* 空态 */}
      {visibleCount === 0 && !stickiesLoading && !editing && (
        <div className="dashboard-loading muted small">
          所有 widget 已隐藏。点击「编辑」恢复。
        </div>
      )}
    </div>
  )
}

export default DashboardRoute