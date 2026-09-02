/**
 * Dashboard Editor（编辑面板 · 多栏布局版 · v5）
 *
 * 让用户能在 Dashboard 上：
 *   - 拖动 widget 在同一列内重排，或跨列移动
 *   - 通过预设按钮（1 栏 / 2 栏 / 3 栏）快速切换布局
 *   - 添加 / 删除列（删除列时该列 widget 并入前一列）
 *   - 显示 / 隐藏 widget（眼睛图标）
 *
 * 数据模型：`columns: DashboardWidgetKey[][]` + `hidden: DashboardWidgetKey[]`
 * 持久化：localStorage `dashboard.layout.v5`，从 v1 / v2 / v3 / v4 自动迁移。
 *
 * 不引入 dnd-kit 等依赖 —— 用原生 HTML5 drag-and-drop。跨列拖拽的 source 追踪
 * 通过 React state 实现：dragSource = { column, index }。
 *
 * 迁移历史：
 *   v3 → v4：原 `pomodoroPanel` widget 拆分为 `pomodoroCalendar` + `pomodoroTimer`。
 *   v4 → v5：去掉 `pomodoroSettings` widget —— 设置已内嵌到 `pomodoroTimer` 面板
 *            底部一行（见 PomodoroQuickSettings），无需独立 widget。
 */
import { useCallback, useEffect, useState } from 'react'
import { Eye, EyeOff, GripVertical, Plus, X } from 'lucide-react'

export const DASHBOARD_LAYOUT_STORAGE_KEY = 'dashboard.layout.v5'
export const DASHBOARD_LAYOUT_STORAGE_KEY_V4 = 'dashboard.layout.v4'
export const DASHBOARD_LAYOUT_STORAGE_KEY_V3 = 'dashboard.layout.v3'
export const DASHBOARD_LAYOUT_STORAGE_KEY_V2 = 'dashboard.layout.v2'
export const DASHBOARD_LAYOUT_STORAGE_KEY_V1 = 'dashboard.layout.v1'

/**
 * 所有可放置 widget 的稳定 key
 *
 * Round 6：greeting 与 quickActions 已迁出 widget 注册表 —— 它们是 dashboard
 * 顶部的固定 chrome（不受布局编辑影响），不再参与拖动 / 隐藏。
 */
export type DashboardWidgetKey =
  | 'todaySummary'
  | 'statsCards'
  | 'pomodoroCalendar'
  | 'pomodoroTimer'
  | 'heatmap'
  | 'upcoming'
  | 'recentNotes'

/** 全部 widget 列表（用于校验 / 重置） */
export const ALL_WIDGET_KEYS: DashboardWidgetKey[] = [
  'todaySummary',
  'statsCards',
  'pomodoroCalendar',
  'pomodoroTimer',
  'heatmap',
  'upcoming',
  'recentNotes',
]

export interface DashboardLayout {
  /** 多列布局：每个 inner array = 一列，顺序为列内自上而下 */
  columns: DashboardWidgetKey[][]
  /** 隐藏 widget（不出现在任何列里） */
  hidden: DashboardWidgetKey[]
}

/** 默认 3 栏布局（与原始 Dashboard 一致；问候/快捷操作在顶部固定，不计入列） */
export const DEFAULT_LAYOUT: DashboardLayout = {
  columns: [
    ['todaySummary', 'statsCards'],
    ['pomodoroCalendar', 'pomodoroTimer'],
    ['heatmap', 'upcoming', 'recentNotes'],
  ],
  hidden: [],
}

/** 预设：1 栏 / 2 栏 / 3 栏 */
export const PRESETS: Record<'compact' | 'focus' | 'balanced', DashboardLayout> = {
  /** 1 栏：所有 widget 堆在一个列里 */
  compact: {
    columns: [[...ALL_WIDGET_KEYS]],
    hidden: [],
  },
  /** 2 栏：番茄钟独占左大列，概览在右 */
  focus: {
    columns: [
      ['todaySummary', 'statsCards', 'pomodoroCalendar', 'pomodoroTimer'],
      ['heatmap', 'upcoming', 'recentNotes'],
    ],
    hidden: [],
  },
  /** 3 栏：默认 */
  balanced: DEFAULT_LAYOUT,
}

export const WIDGET_LABELS: Record<DashboardWidgetKey, string> = {
  todaySummary: '今日摘要',
  statsCards: '统计卡片',
  pomodoroCalendar: '番茄钟日历',
  pomodoroTimer: '番茄钟计时',
  heatmap: '近期活动热力图',
  upcoming: '即将到期便签',
  recentNotes: '最近编辑笔记',
}

export const PRESET_LABELS: Record<keyof typeof PRESETS, string> = {
  compact: '1 栏紧凑',
  focus: '2 栏专注',
  balanced: '3 栏均衡',
}

/** 列的最大数量（防止界面过于拥挤） */
export const MAX_COLUMNS = 5

// ================ 迁移辅助 ================

/**
 * v2 order 中 'topPanel' 拆为 v3 widget（Round 6 起 greeting 已迁出，剩两个）
 */
const V2_TO_V3_TOP_PANEL: DashboardWidgetKey[] = ['todaySummary', 'statsCards']

function isWidgetKey(k: unknown): k is DashboardWidgetKey {
  return typeof k === 'string' && (ALL_WIDGET_KEYS as string[]).includes(k)
}

/**
 * 把 v2 `{ order, hidden }` 迁移到 v3 `{ columns, hidden }`
 * 策略：v2 order 中所有 widget（topPanel 拆为 3 个）放进单一列
 */
function migrateV2ToV3(raw: string | null): DashboardLayout | null {
  if (!raw) return null
  try {
    const v2 = JSON.parse(raw) as { order?: string[]; hidden?: string[] }
    const column: DashboardWidgetKey[] = []
    const hidden = new Set<DashboardWidgetKey>()
    if (Array.isArray(v2.hidden)) {
      for (const k of v2.hidden) {
        if (k === 'topPanel') {
          for (const w of V2_TO_V3_TOP_PANEL) hidden.add(w)
        } else if (isWidgetKey(k)) {
          hidden.add(k)
        }
      }
    }
    const sourceOrder = Array.isArray(v2.order) ? v2.order : [...ALL_WIDGET_KEYS]
    for (const k of sourceOrder) {
      if (k === 'topPanel') {
        for (const w of V2_TO_V3_TOP_PANEL) {
          if (!hidden.has(w) && !column.includes(w)) column.push(w)
        }
      } else if (isWidgetKey(k)) {
        if (!hidden.has(k) && !column.includes(k)) column.push(k)
      }
    }
    // 补全缺失的 widget（任意位置追加即可，用户可在编辑器里重排）
    for (const w of ALL_WIDGET_KEYS) {
      if (!hidden.has(w) && !column.includes(w)) column.push(w)
    }
    return { columns: [column], hidden: Array.from(hidden) }
  } catch {
    return null
  }
}

/**
 * v1 → v2 时的旧 key 映射（v1 的 order 包含 greeting/todaySummary/statsCards，
 * Round 6 后 greeting 不再是合法 widget key，仅保留 todaySummary/statsCards 用于
 * 「隐藏这些已迁出的旧顶部 widget」语义，避免 sanitizeLayout 把它们当无效 key 还原）
 */
const V1_TO_V3_DEPRECATED_KEYS = new Set<DashboardWidgetKey>(['todaySummary', 'statsCards'])

function migrateV1ToV3(raw: string | null): DashboardLayout | null {
  if (!raw) return null
  try {
    const v1 = JSON.parse(raw) as { order?: string[]; hidden?: string[] }
    const sourceOrder = Array.isArray(v1.order) ? v1.order : []
    // v1 与 v3 widget key 几乎一致（除 v3 没有 topPanel），直接沿用
    const column: DashboardWidgetKey[] = []
    const hidden = new Set<DashboardWidgetKey>()
    if (Array.isArray(v1.hidden)) {
      for (const k of v1.hidden) {
        if (isWidgetKey(k) && !V1_TO_V3_DEPRECATED_KEYS.has(k)) hidden.add(k)
      }
    }
    for (const k of sourceOrder) {
      if (isWidgetKey(k) && !V1_TO_V3_DEPRECATED_KEYS.has(k) && !hidden.has(k) && !column.includes(k)) {
        column.push(k)
      }
    }
    for (const w of ALL_WIDGET_KEYS) {
      if (V1_TO_V3_DEPRECATED_KEYS.has(w)) continue
      if (!hidden.has(w) && !column.includes(w)) column.push(w)
    }
    return { columns: [column], hidden: Array.from(hidden) }
  } catch {
    return null
  }
}

/** 不变量校验：补齐缺失 / 移除重复 / 删除不存在项 */
function sanitizeLayout(layout: Partial<DashboardLayout>): DashboardLayout {
  const seen = new Set<DashboardWidgetKey>()
  const columns: DashboardWidgetKey[][] = []
  if (Array.isArray(layout.columns)) {
    for (const col of layout.columns) {
      if (!Array.isArray(col)) continue
      const cleaned: DashboardWidgetKey[] = []
      for (const k of col) {
        if (!isWidgetKey(k)) continue
        if (seen.has(k)) continue
        seen.add(k)
        cleaned.push(k)
      }
      if (cleaned.length > 0) columns.push(cleaned)
    }
  }
  const hidden: DashboardWidgetKey[] = []
  if (Array.isArray(layout.hidden)) {
    for (const k of layout.hidden) {
      if (!isWidgetKey(k)) continue
      if (seen.has(k)) continue
      if (hidden.includes(k)) continue
      hidden.push(k)
      seen.add(k)
    }
  }
  // 补齐所有未出现的 widget 到第一列；若所有列都空则建一列
  const missing: DashboardWidgetKey[] = []
  for (const w of ALL_WIDGET_KEYS) {
    if (!seen.has(w)) missing.push(w)
  }
  if (missing.length > 0) {
    if (columns.length === 0) columns.push(missing)
    else columns[0].push(...missing)
  }
  return { columns, hidden }
}

/**
 * v3 → v4：把 `'pomodoroPanel'` 拆为 `['pomodoroCalendar', 'pomodoroTimer']`
 * （保留先后顺序：日历在前，计时在后）
 */
function migrateV3ToV4(raw: string | null): DashboardLayout | null {
  if (!raw) return null
  try {
    const v3 = JSON.parse(raw) as { columns?: unknown[]; hidden?: unknown[] }
    const columns: DashboardWidgetKey[][] = []
    if (Array.isArray(v3.columns)) {
      for (const col of v3.columns) {
        if (!Array.isArray(col)) continue
        const expanded: DashboardWidgetKey[] = []
        for (const k of col) {
          if (k === 'pomodoroPanel') {
            // v3 legacy key —— 拆分（保留顺序）
            expanded.push('pomodoroCalendar', 'pomodoroTimer')
          } else if (typeof k === 'string' && (ALL_WIDGET_KEYS as string[]).includes(k)) {
            expanded.push(k as DashboardWidgetKey)
          }
          // 其他无效 key 跳过（让 sanitizeLayout 在必要时补齐）
        }
        columns.push(expanded)
      }
    }
    const hidden: DashboardWidgetKey[] = []
    if (Array.isArray(v3.hidden)) {
      for (const k of v3.hidden) {
        if (k === 'pomodoroPanel') {
          if (!hidden.includes('pomodoroCalendar')) hidden.push('pomodoroCalendar')
          if (!hidden.includes('pomodoroTimer')) hidden.push('pomodoroTimer')
        } else if (typeof k === 'string' && (ALL_WIDGET_KEYS as string[]).includes(k)) {
          hidden.push(k as DashboardWidgetKey)
        }
      }
    }
    return sanitizeLayout({ columns, hidden })
  } catch {
    return null
  }
}

/**
 * v4 → v5：去掉 `'pomodoroSettings'` widget —— 设置已内嵌到 `pomodoroTimer` 面板。
 * 策略：从 columns / hidden 两处都跳过该 key；sanitizeLayout 会在末尾把它补回
 * 缺失的合法 widget，所以这里只是"放弃这个位置"，并不破坏整体。
 */
function migrateV4ToV5(raw: string | null): DashboardLayout | null {
  if (!raw) return null
  try {
    const v4 = JSON.parse(raw) as { columns?: unknown[]; hidden?: unknown[] }
    const columns: DashboardWidgetKey[][] = []
    if (Array.isArray(v4.columns)) {
      for (const col of v4.columns) {
        if (!Array.isArray(col)) continue
        const expanded: DashboardWidgetKey[] = []
        for (const k of col) {
          // v4 legacy key —— 直接跳过（设置内嵌到 timer panel，不需要独立 widget）
          if (k === 'pomodoroSettings') continue
          if (typeof k === 'string' && (ALL_WIDGET_KEYS as string[]).includes(k)) {
            expanded.push(k as DashboardWidgetKey)
          }
        }
        columns.push(expanded)
      }
    }
    const hidden: DashboardWidgetKey[] = []
    if (Array.isArray(v4.hidden)) {
      for (const k of v4.hidden) {
        if (k === 'pomodoroSettings') continue
        if (typeof k === 'string' && (ALL_WIDGET_KEYS as string[]).includes(k)) {
          hidden.push(k as DashboardWidgetKey)
        }
      }
    }
    return sanitizeLayout({ columns, hidden })
  } catch {
    return null
  }
}

export function loadLayout(): DashboardLayout {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT
  // v5 优先
  try {
    const raw = window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DashboardLayout>
      return sanitizeLayout(parsed)
    }
  } catch {
    // 忽略，尝试 v4
  }
  // v4 → v5 迁移（去掉 pomodoroSettings）
  const v5FromV4 = migrateV4ToV5(window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY_V4))
  if (v5FromV4) {
    saveLayout(v5FromV4)
    return v5FromV4
  }
  // v3 → v4（拆 pomodoroPanel） → 再经 v5 迁移
  const v4FromV3 = migrateV3ToV4(window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY_V3))
  if (v4FromV3) {
    const v5FromV3 = migrateV4ToV5(JSON.stringify(v4FromV3))
    if (v5FromV3) {
      saveLayout(v5FromV3)
      return v5FromV3
    }
  }
  // v2 / v1 → v3 → v4 → v5 链路
  const v3FromV2 = migrateV2ToV3(window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY_V2))
  const v3FromV1 = migrateV1ToV3(window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY_V1))
  const legacyIntermediate = v3FromV2 ?? v3FromV1
  if (legacyIntermediate) {
    const v4FromLegacy = migrateV3ToV4(JSON.stringify(legacyIntermediate))
    if (v4FromLegacy) {
      const v5FromLegacy = migrateV4ToV5(JSON.stringify(v4FromLegacy))
      if (v5FromLegacy) {
        saveLayout(v5FromLegacy)
        return v5FromLegacy
      }
    }
  }
  return DEFAULT_LAYOUT
}

export function saveLayout(layout: DashboardLayout): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      DASHBOARD_LAYOUT_STORAGE_KEY,
      JSON.stringify(layout),
    )
  } catch {
    // localStorage 满了或被禁用 —— 静默
  }
}

// ================ 拖拽辅助 ================

interface DragSource {
  column: number
  index: number
  widget: DashboardWidgetKey
}

/** 计算把 source 移到 (targetColumn, targetIndex) 后的新 columns */
export function moveWidget(
  columns: DashboardWidgetKey[][],
  source: DragSource,
  targetColumn: number,
  targetIndex: number,
): DashboardWidgetKey[][] {
  const next = columns.map((col) => [...col])
  // 从 source 列移除
  next[source.column].splice(source.index, 1)
  // 计算插入位置：若目标列被移除后变短，需要调整 targetIndex
  let insertAt = targetIndex
  if (source.column === targetColumn && targetIndex > source.index) {
    insertAt -= 1
  }
  insertAt = Math.max(0, Math.min(insertAt, next[targetColumn].length))
  next[targetColumn].splice(insertAt, 0, source.widget)
  return next
}

// ================ Editor Modal ================

export interface DashboardEditorModalProps {
  layout: DashboardLayout
  onClose: () => void
  onChange: (next: DashboardLayout) => void
}

export function DashboardEditorModal({
  layout,
  onClose,
  onChange,
}: DashboardEditorModalProps) {
  const [draft, setDraft] = useState<DashboardLayout>(() => layout)
  const [dragSource, setDragSource] = useState<DragSource | null>(null)
  const [dropTarget, setDropTarget] = useState<{ column: number; index: number } | null>(null)

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 切换 widget 的隐藏状态：从隐藏 → 显示加回最后一列末尾；显示 → 隐藏 */
  const toggleHidden = useCallback((key: DashboardWidgetKey) => {
    setDraft((prev) => {
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

  /** 删除一列：该列 widget 并入前一列（若是第 1 列则并入第 2 列） */
  const removeColumn = useCallback((columnIdx: number) => {
    setDraft((prev) => {
      if (prev.columns.length <= 1) return prev // 至少保留 1 列
      const columns = prev.columns.map((col) => [...col])
      const widgets = columns.splice(columnIdx, 1)[0] ?? []
      const targetIdx = columnIdx === 0 ? 0 : columnIdx - 1
      // splice 已经把 columns 缩短，targetIdx 重新映射
      const insertAt = columnIdx === 0 ? 0 : columns[targetIdx - 1].length
      const adjustedIdx = columnIdx === 0 ? 0 : columnIdx - 1
      if (widgets.length > 0) {
        columns[adjustedIdx] = [...columns[adjustedIdx], ...widgets]
      }
      // 保险：如果 columns 为空（如只剩 1 列又被删除的情况已拦截），保底
      if (columns.length === 0) columns.push([])
      void insertAt
      return { ...prev, columns }
    })
  }, [])

  /** 添加一列（默认空 widget；hidden 中如果有 widget 可拖入） */
  const addColumn = useCallback(() => {
    setDraft((prev) => {
      if (prev.columns.length >= MAX_COLUMNS) return prev
      return { ...prev, columns: [...prev.columns, []] }
    })
  }, [])

  /** 应用预设 */
  const applyPreset = useCallback((preset: keyof typeof PRESETS) => {
    setDraft(PRESETS[preset])
  }, [])

  /** 提交 */
  const handleSave = useCallback(() => {
    onChange(draft)
    onClose()
  }, [draft, onChange, onClose])

  /** 恢复默认 */
  const handleReset = useCallback(() => {
    setDraft(DEFAULT_LAYOUT)
  }, [])

  // 拖拽：onDragStart
  const handleDragStart = useCallback(
    (e: React.DragEvent, columnIdx: number, index: number, widget: DashboardWidgetKey) => {
      setDragSource({ column: columnIdx, index, widget })
      e.dataTransfer.effectAllowed = 'move'
      // 必须 setData 才能在 Firefox 触发 drag
      try {
        e.dataTransfer.setData('text/plain', widget)
      } catch {
        // 忽略
      }
    },
    [],
  )

  // 拖拽：onDragOver（阻止默认 → 允许 drop）
  const handleDragOver = useCallback(
    (e: React.DragEvent, columnIdx: number, index: number) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget({ column: columnIdx, index })
    },
    [],
  )

  // 拖拽：onDragOver 在列末尾空白处
  const handleColumnDragOver = useCallback((e: React.DragEvent, columnIdx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // 目标 index 暂用列长度（末尾）
    setDropTarget((prev) =>
      prev && prev.column === columnIdx ? prev : { column: columnIdx, index: draft.columns[columnIdx]?.length ?? 0 },
    )
  }, [draft.columns])

  // 拖拽：onDrop 落地
  const handleDrop = useCallback(
    (e: React.DragEvent, columnIdx: number, index: number) => {
      e.preventDefault()
      if (!dragSource) return
      setDraft((prev) => ({
        ...prev,
        columns: moveWidget(prev.columns, dragSource, columnIdx, index),
      }))
      setDragSource(null)
      setDropTarget(null)
    },
    [dragSource],
  )

  // 拖拽：onDragEnd 清理
  const handleDragEnd = useCallback(() => {
    setDragSource(null)
    setDropTarget(null)
  }, [])

  return (
    <div
      className="dashboard-editor-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Dashboard 编辑"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dashboard-editor-modal">
        <header className="dashboard-editor-header">
          <h2>编辑 Dashboard</h2>
          <button
            type="button"
            className="dashboard-editor-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="dashboard-editor-body">
          {/* 预设栏 */}
          <div className="dashboard-editor-presets" role="toolbar" aria-label="布局预设">
            <span className="muted small">预设：</span>
            {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
              <button
                key={p}
                type="button"
                className="btn ghost dashboard-editor-preset"
                onClick={() => applyPreset(p)}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
            <button
              type="button"
              className="btn ghost dashboard-editor-add-col"
              onClick={addColumn}
              disabled={draft.columns.length >= MAX_COLUMNS}
              title={draft.columns.length >= MAX_COLUMNS ? `已达 ${MAX_COLUMNS} 列上限` : '添加一列'}
            >
              <Plus size={14} aria-hidden /> 添加列
            </button>
          </div>

          {/* 多列布局 */}
          <div className="dashboard-editor-cols">
            {draft.columns.map((column, ci) => (
              <div key={ci} className="dashboard-editor-col">
                <header className="dashboard-editor-col-head">
                  <span className="dashboard-editor-col-title">列 {ci + 1}</span>
                  <span className="muted small">{column.length} 个 widget</span>
                </header>
                <ul
                  className="dashboard-editor-list"
                  onDragOver={(e) => handleColumnDragOver(e, ci)}
                  onDrop={(e) => {
                    const targetIdx = dropTarget?.column === ci ? dropTarget.index : column.length
                    handleDrop(e, ci, targetIdx)
                  }}
                >
                  {column.map((key, idx) => {
                    const isHidden = draft.hidden.includes(key)
                    const isDropBefore =
                      dropTarget?.column === ci && dropTarget?.index === idx && dragSource !== null
                    return (
                      <li
                        key={key}
                        className={`dashboard-editor-item ${isHidden ? 'is-hidden' : ''} ${dragSource?.widget === key ? 'is-dragging' : ''} ${isDropBefore ? 'is-drop-target' : ''}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, ci, idx, key)}
                        onDragOver={(e) => handleDragOver(e, ci, idx)}
                        onDrop={(e) => handleDrop(e, ci, idx)}
                        onDragEnd={handleDragEnd}
                      >
                        <GripVertical
                          size={14}
                          aria-hidden
                          className="dashboard-editor-grip"
                        />
                        <span className="dashboard-editor-label">
                          {WIDGET_LABELS[key]}
                        </span>
                        <button
                          type="button"
                          className="dashboard-editor-toggle"
                          onClick={() => toggleHidden(key)}
                          aria-pressed={!isHidden}
                          aria-label={isHidden ? '显示' : '隐藏'}
                          title={isHidden ? '显示' : '隐藏'}
                        >
                          {isHidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                        </button>
                      </li>
                    )
                  })}
                  {column.length === 0 && (
                    <li className="dashboard-editor-empty muted small">（空列）拖入 widget</li>
                  )}
                </ul>
                {draft.columns.length > 1 && (
                  <button
                    type="button"
                    className="btn ghost dashboard-editor-remove-col"
                    onClick={() => removeColumn(ci)}
                    title="删除该列，widget 并入前一列"
                  >
                    删除列
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 隐藏列表 */}
          {draft.hidden.length > 0 && (
            <details className="dashboard-editor-hidden-section">
              <summary className="muted small">已隐藏的 widget（{draft.hidden.length}）</summary>
              <ul className="dashboard-editor-list is-hidden-list">
                {draft.hidden.map((key) => (
                  <li key={key} className="dashboard-editor-item is-hidden">
                    <span className="dashboard-editor-label">{WIDGET_LABELS[key]}</span>
                    <button
                      type="button"
                      className="dashboard-editor-toggle"
                      onClick={() => toggleHidden(key)}
                      aria-label="显示"
                      title="显示"
                    >
                      <Eye size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="muted small dashboard-editor-hint">
            拖动调整顺序；点击眼睛图标隐藏 / 显示；预设切换栏数。
          </p>
        </div>

        <footer className="dashboard-editor-footer">
          <button type="button" className="btn ghost" onClick={handleReset}>
            恢复默认
          </button>
          <div className="dashboard-editor-footer-right">
            <button type="button" className="btn ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={handleSave}>
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default DashboardEditorModal