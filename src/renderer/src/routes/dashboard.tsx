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
import { Eye, EyeOff, GripVertical, Pencil, Plus } from '@renderer/lib/icon'
import type { StickyNote, StickyNoteUpdate, StickyNoteStepPatch } from '@shared/types'
import { GreetingCard } from '../components/dashboard/GreetingCard'
import { TodaySummary } from '../components/dashboard/TodaySummary'
import { StatsCards } from '../components/dashboard/StatsCards'
import { aggregateStickies } from '../lib/stickyAggregates'
import { QuickActions } from '../components/dashboard/QuickActions'
import { HeatmapWidget } from '../components/dashboard/HeatmapWidget'
import { RecentNotes } from '../components/dashboard/RecentNotes'
import { AIInsightCard } from '../components/dashboard/AIInsightCard'
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
import { useTodayKey } from '../lib/useDayRollover'

interface DragSource {
  column: number
  index: number
  widget: DashboardWidgetKey
}

/**
 * R-fix-dashboard-handlers-stability (perf, high)：
 * UpcomingStickies 把每个 handler 透传到内部 memo 化的 StickyNoteCard。
 * DashboardRoute 每次 render 都新建这 5 个引用 + inline `onSelect={() => undefined}`，
 * 导致 StickyNoteCard 默认 memo comparator（Object.is）全失败，面板里所有卡片
 * 跟着 re-render。这里把 5 个 handler 提到 module 顶层（闭包里只用了
 * useStickyNotesStore.getState()，store action 引用与状态都稳定，不需要 React
 * 调度感知），并把 NOOP 作为命名常量提供。handler 引用从此跨 render 不变，
 * StickyNoteCard 的 memo 正常生效。
 */
const NOOP = () => undefined
const handleUpdateSticky = (id: string, patch: StickyNoteUpdate): void => {
  void useStickyNotesStore.getState().update(id, patch)
}
const handleDeleteSticky = (id: string): void => {
  void useStickyNotesStore.getState().remove(id)
}
const handleAddStep = (noteId: string, content: string): void => {
  void useStickyNotesStore.getState().addStep(noteId, content)
}
const handleUpdateStep = (noteId: string, stepId: string, patch: StickyNoteStepPatch): void => {
  void useStickyNotesStore.getState().updateStep(noteId, stepId, patch)
}
const handleRemoveStep = (noteId: string, stepId: string): void => {
  void useStickyNotesStore.getState().removeStep(noteId, stepId)
}

export function DashboardRoute() {
  // 数据：便签 / 笔记
  const loadAllFiltered = useStickyNotesStore((s) => s.loadAllFiltered)
  // Perf-fix #3 + R31-corr：byDate 仍是单一数据源，但要同时订阅 `all`。
  // 原版只读 `byDate`，但 `loadAllFiltered` 路径（stores/stickyNotes.ts
  // set({ all: finalAll })）只写 `all` 不改 `byDate` 引用 —— 单订阅
  // `[byDate]` 的 useMemo 拿不到新数据，下游 todayStats / breakdown /
  // renderWidget 全 stale。修复：把 `all` 提到 selector 层，与 byDate
  // 一并订阅；stickies useMemo 同时依赖两者，dep 变化即重算。
  // （两个 selector 各返回引用，sticky mutation 仍只触发一次重渲染 —— 不
  // 会出现「两次 store 比较 + 全部子树重渲染」的反退化问题。）
  const byDate = useStickyNotesStore((s) => s.byDate)
  const allStickies = useStickyNotesStore((s) => s.all)
  const stickiesLoading = useStickyNotesStore((s) => s.loading)

  const notesLoaded = useNotesStore((s) => s.notes.length > 0)
  const notesLoading = useNotesStore((s) => s.loading)
  const fetchNotes = useNotesStore((s) => s.fetch)

  // R5R-4 配套：用 useTodayKey() 替代 useMemo + 空依赖 —— 后者跨午夜后
  // todayKey 永远停留在昨天，导致"逾期未完成"用错基准日计算。
  const todayKey = useTodayKey()

  // R-fix-dashboard-mount-effect (perf, medium)：原 effect 把 loadAllFiltered
  // + fetchNotes 放在同一个 useEffect 里，deps 含 notesLoaded/notesLoading。
  // 首次挂载固定跑 3 次（initial / loading 翻转 / loaded 翻转），每次都发
  // stickyNotesApi.listFiltered IPC。拆成两个 effect：
  //   1) mount-once：只跑一次 loadAllFiltered；fetchNotes 守卫内嵌在这里。
  //   2) 暂留空 —— 后续如需响应外部刷新（IPC 推送等），再单独追加。
  useEffect(() => {
    void loadAllFiltered({ archived: false, limit: 500 })
    if (!notesLoaded && !notesLoading) {
      void fetchNotes()
    }
    // 故意只依赖 mount-once —— loadAllFiltered / fetchNotes 是 store action，
    // 引用稳定；notesLoaded / notesLoading 翻转不再触发额外的 IPC。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 派生 —— 优先用 `all`（loadAllFiltered 写入，已聚合 + 排序），为空时
  // 回退 byDate 扁平化（fetchRange 路径）。两者都已订阅：dep 包含
  // `[byDate, allStickies]`，任一引用变化都重新计算，避免 `loadAllFiltered`
  // 单写 `all` 时 dashboard 拿到陈旧 stickies。
  const stickies: StickyNote[] = useMemo(() => {
    if (allStickies && allStickies.length > 0) return allStickies
    return Object.values(byDate).flat()
  }, [byDate, allStickies])

  // R-perf-dashboard-aggregates (perf, low)：把旧 todayStats + breakdown 两个
  // useMemo 合并为单次 O(N) 遍历。旧版两个 memo 分别迭代 stickies，外加
  // todayStats 每个 sticky 一次 `new Date(n.dueAt).getTime()`；500 条便签
  // 软上限下，每个 keystroke（编辑 step 时）触发 2 次完整迭代 + 500 次 Date
  // 分配。新版走共享 helper `aggregateStickies`，复用 Date.parse 结果。
  const { todayStats, breakdown } = useMemo(
    () => aggregateStickies(stickies, todayKey),
    [stickies, todayKey],
  )

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

  // ===== widget → 组件 映射 =====
  // Round 6：greeting / quickActions 不再是 widget —— 它们作为顶部固定 chrome
  // 渲染在 dashboard-topbar 里，与布局编辑器无关。
  // R-fix-dashboard-handlers-stability：5 个 handler + NOOP 已提升到 module 顶层，
  // 引用稳定，UpcomingStickies 内部的 memo 化 StickyNoteCard 可正确跳过 re-render。
  const renderWidget = (key: DashboardWidgetKey): JSX.Element | null => {
    switch (key) {
      case 'todaySummary':
        return <TodaySummary stickies={stickies} todayStats={todayStats} />
      case 'statsCards':
        return <StatsCards stickies={stickies} breakdown={breakdown} />
      case 'pomodoroCalendar':
        return <PomodoroCalendarPanel embedded />
      case 'pomodoroTimer':
        return <PomodoroTimerPanel />
      case 'heatmap':
        return <HeatmapWidget />
      case 'upcoming':
        return (
          <UpcomingStickies
            stickies={stickies}
            onSelect={NOOP}
            onUpdate={handleUpdateSticky}
            onDelete={handleDeleteSticky}
            onAddStep={handleAddStep}
            onUpdateStep={handleUpdateStep}
            onRemoveStep={handleRemoveStep}
          />
        )
      case 'recentNotes':
        return <RecentNotes />
      case 'aiInsight':
        return <AIInsightCard todayStats={todayStats} />
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