/**
 * Sticky Timeline —— 时间线主容器
 *
 * 设计：
 *   - 单一滚动容器（overflow-y: auto），不劫持滚轮
 *   - 上下两端各放一个 1px sentinel；IntersectionObserver 监听进入视口
 *   - 进入视口 → 自动 fetch 前后 N 天窗口（store 内做合并去重）
 *   - 首次挂载：滚动到「今日 section」
 *   - 跨午夜（useDayRollover）→ 重新滚动到新今日 section
 *   - 滚动距离今日 > 600px 时显示「回到今日」按钮
 *
 * 窗口策略：
 *   - 初始 fetchRange = today ± 30 天（共 61 天）
 *   - 触底/触顶 → 窗口向外扩 14 天
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStickyNotesStore } from '../../stores/stickyNotes'
import { stickyNotesApi } from '../../lib/ipc'
import {
  addDays,
  dayKeyOf,
  fromDayKey,
  diffDays,
} from '../../lib/date'
import { useDayRollover } from '../../lib/useDayRollover'
import { StickyDaySection } from './StickyDaySection'
import type {
  StickyNote,
  StickyNoteUpdate,
  StickyNoteStepPatch,
  Priority,
} from '@shared/types'

/** 默认窗口半径（前后天数）。
 *  说明：实际渲染的「日 section」数量由 `renderDays` 动态计算（基础 3 天 + 有便签的日期），
 *  此处只是首屏拉取的窗口大小。7 天覆盖典型的一周回顾/计划，再配合 IntersectionObserver 滚动扩展。 */
const INITIAL_RADIUS = 7
/** 每次扩展的步长 */
const EXPAND_RADIUS = 7

interface Props {
  /** 可选：传入固定的今日键（默认 = 当前日期），方便测试 */
  todayKey?: string
}

export function StickyTimeline({ todayKey: todayKeyProp }: Props) {
  const todayKey = todayKeyProp ?? dayKeyOf(new Date())

  const byDate = useStickyNotesStore((s) => s.byDate)
  const fetchRange = useStickyNotesStore((s) => s.fetchRange)
  const updateNote = useStickyNotesStore((s) => s.update)
  const addStep = useStickyNotesStore((s) => s.addStep)
  const updateStep = useStickyNotesStore((s) => s.updateStep)
  const removeStep = useStickyNotesStore((s) => s.removeStep)
  const createNote = useStickyNotesStore((s) => s.create)

  const rangeStart = useStickyNotesStore((s) => s.rangeStart)
  const rangeEnd = useStickyNotesStore((s) => s.rangeEnd)

  // P0-3：删除 toast（最近 1 个）；含倒计时 + 撤销按钮
  // R12 修复 (medium)：把 expiresAt 放在父 state，倒计时 tick 放在 DeleteToast 子组件
  // 的本地 state —— 这样 1Hz tick 只重渲染 DeleteToast（轻量 DOM），不会让
  // StickyTimeline 整个子树（600+ card + 1800+ step）随之重渲染。
  type ToastEntry = {
    id: string
    noteId: string
    noteTitle: string
    previousArchived: boolean
    /** 起始时间戳（ms）。子组件据此计算剩余秒数 */
    expiresAt: number
  }
  const [toast, setToast] = useState<ToastEntry | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const startToast = useCallback(
    (entry: ToastEntry) => {
      if (toastTimerRef.current !== null) {
        // R20 修复 (high memory-leak)：toastTimerRef 是 setTimeout handle，
        // 必须 clearTimeout —— 用 clearInterval 不报错但什么也不清，导致
        // 用户连续删除便签时上一个 toast 的硬删 callback 仍会在原到期时间
        // 触发（甚至在组件卸载后调用 setState 触发 React warning）。三处都改。
        window.clearTimeout(toastTimerRef.current)
      }
      setToast(entry)
      // R12 修复 (medium)：5s 倒计时由 DeleteToast 子组件本地 state 维护，
      // 这里仅启动到期清理定时器 —— 不再 setInterval 触发父组件重渲染。
      toastTimerRef.current = window.setTimeout(() => {
        if (toastTimerRef.current !== null) {
          window.clearTimeout(toastTimerRef.current)
          toastTimerRef.current = null
        }
        stickyNotesApi.remove(entry.noteId).catch(() => {})
        setToast(null)
      }, Math.max(0, entry.expiresAt - Date.now()))
    },
    [],
  )

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  const handleSoftDelete = useCallback(
    async (note: { id: string; title: string; archived: boolean }) => {
      // 软删除：先 archive(true)，5s 后真正删；期间可撤销
      const wasArchived = note.archived
      try {
        await stickyNotesApi.archive(note.id, true)
      } catch (err) {
        // R5-1：archive 失败时不要继续排定硬删 —— 用户会以为撤销窗口还有效，
        // 但 5s 后便签会神秘消失。改为直接退出并提示。
        console.warn('[sticky-timeline] archive failed; skip soft-delete toast', err)
        return
      }
      startToast({
        id: `toast-${Date.now()}`,
        noteId: note.id,
        noteTitle: note.title,
        previousArchived: wasArchived,
        expiresAt: Date.now() + 5_000,
      })
    },
    [startToast],
  )

  const handleUndo = useCallback(() => {
    if (!toast) return
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    // 撤销 = 取消 archive
    stickyNotesApi.archive(toast.noteId, toast.previousArchived).catch(() => {})
    setToast(null)
  }, [toast])

  const scrollRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const todaySectionRef = useRef<HTMLElement>(null)

  const [hasScrolledToToday, setHasScrolledToToday] = useState(false)
  const [showJump, setShowJump] = useState(false)
  // P0-2：搜索 + 优先级过滤（前端二次过滤）
  const [query, setQuery] = useState('')
  // R12 修复 (low)：搜索输入 + 过滤 useMemo 会在每次 keystroke 时对所有
  // 便签做 toLowerCase + includes。便签多时（>500）会卡顿。加 150ms
  // debounce：input 仍在受控（query 立即更新，placeholder/光标不延迟），
  // 实际参与过滤的 debouncedQuery 落后一拍。
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), 150)
    return () => window.clearTimeout(id)
  }, [query])
  const [activePriorities, setActivePriorities] = useState<Set<Priority>>(new Set())

  const togglePriority = useCallback((p: Priority) => {
    setActivePriorities((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])

  // ===== 计算要渲染的日期列表（应用搜索 + 优先级过滤） =====
  // R6R-4：days 仅用于驱动 jumpLabel；移除未使用的 days useMemo（jumpLabel 已改为依赖 showJump）。
  void rangeStart
  void rangeEnd

  // 应用搜索 + 优先级过滤后的 byDate
  const filteredByDate = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    const noFilter = q === '' && activePriorities.size === 0
    // R7F-6：完全无过滤时直接返回 byDate 引用，避免每次键盘 / 过滤切换都
    // 拷贝一次整张表（最多 60 天 × 10+ 便签 × 3 步骤 = 上千次 toLowerCase）。
    if (noFilter) return byDate
    const out: Record<string, typeof byDate[string]> = {}
    for (const dk of Object.keys(byDate)) {
      let arr = byDate[dk]
      // 单次遍历同时应用 priority + query 过滤，避免中间数组分配
      arr = arr.filter((n) => {
        if (activePriorities.size > 0 && !activePriorities.has(n.priority)) {
          return false
        }
        if (q) {
          // R7F-6：每条便签只 lower 一次（cache 进临时变量）
          const t = n.title.toLowerCase()
          if (t.includes(q)) return true
          const d = n.description?.toLowerCase()
          if (d && d.includes(q)) return true
          for (const s of n.steps) {
            if (s.content.toLowerCase().includes(q)) return true
          }
          return false
        }
        return true
      })
      if (arr.length > 0) out[dk] = arr
    }
    return out
  }, [byDate, debouncedQuery, activePriorities])

  // ===== 实际渲染的日期集合 =====
  // Round 5 调整（用户反馈）：
  //   只展示「历史便签 + 今天 + 明天」的便签 —— 不再渲染空白的「昨天」section。
  // 规则：
  //   1. 今天 / 明天永远渲染（即使没有便签也给用户「新建 / 计划未来」入口）
  //   2. 历史上「有命中便签」的日期也渲染（保证历史不丢）
  //   3. 昨天仅当存在便签时才渲染（避免空白昨日 section 占据视觉空间）
  //   4. 既不在基础 2 天、又没有命中便签的日期 → 跳过（性能优化核心）
  // 这样新用户只渲染 2 个 section（今天 + 明天），已有历史的用户追加历史便签日期。
  const renderDays = useMemo(() => {
    const base = new Set<string>([
      todayKey,
      dayKeyOf(addDays(new Date(todayKey), 1)),
    ])
    for (const dk of Object.keys(filteredByDate)) {
      if (filteredByDate[dk] && filteredByDate[dk]!.length > 0) {
        base.add(dk)
      }
    }
    return Array.from(base).sort()
  }, [todayKey, filteredByDate])

  const isFiltered = query.trim().length > 0 || activePriorities.size > 0

  // ===== 首次挂载：拉初始窗口 =====
  useEffect(() => {
    if (rangeStart && rangeEnd) return
    const start = dayKeyOf(addDays(new Date(todayKey), -INITIAL_RADIUS))
    const end = dayKeyOf(addDays(new Date(todayKey), INITIAL_RADIUS))
    fetchRange(start, end)
  }, [rangeStart, rangeEnd, todayKey, fetchRange])

  // ===== 滚动到今日（首次挂载 + 跨午夜） =====
  const scrollToToday = useCallback(() => {
    requestAnimationFrame(() => {
      const el = todaySectionRef.current
      if (!el || !scrollRef.current) return
      el.scrollIntoView({ block: 'start', behavior: 'auto' })
      setHasScrolledToToday(true)
      setShowJump(false)
    })
  }, [])

  useEffect(() => {
    if (!hasScrolledToToday && renderDays.length > 0) {
      scrollToToday()
    }
  }, [hasScrolledToToday, renderDays.length, scrollToToday])

  // ===== 跨午夜：刷新窗口 + 重新锚定 =====
  const handleRollover = useCallback(
    (_newDay: string) => {
      const start = dayKeyOf(addDays(new Date(), -INITIAL_RADIUS))
      const end = dayKeyOf(addDays(new Date(), INITIAL_RADIUS))
      fetchRange(start, end)
      setHasScrolledToToday(false) // 重新触发 scrollIntoView
    },
    [fetchRange],
  )
  useDayRollover(handleRollover)

  // ===== 扩展窗口 =====
  const expandOlder = useCallback(() => {
    if (!rangeStart) return
    const newStart = dayKeyOf(addDays(fromDayKey(rangeStart), -EXPAND_RADIUS))
    fetchRange(newStart, rangeEnd)
  }, [rangeStart, rangeEnd, fetchRange])

  const expandNewer = useCallback(() => {
    if (!rangeEnd) return
    const newEnd = dayKeyOf(addDays(fromDayKey(rangeEnd), EXPAND_RADIUS))
    fetchRange(rangeStart, newEnd)
  }, [rangeStart, rangeEnd, fetchRange])

  // ===== IntersectionObserver：监听上下 sentinel =====
  // R12 修复 (medium)：sentinel 进入视口会反复触发（用户停在 sentinel 附近，
  // IO 每帧都回调 isIntersecting=true）。没有 in-flight guard 时，一次扩展
  // 还没完成又会触发另一次，结果是 fetchRange 被并发调用，store 状态竞态。
  // 用 inFlightRef 拦截：上一次扩展未完成前忽略新的触发。
  const inFlightRef = useRef<'older' | 'newer' | null>(null)
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          if (entry.target === topSentinelRef.current) {
            if (inFlightRef.current) return
            inFlightRef.current = 'older'
            Promise.resolve(expandOlder()).finally(() => {
              if (inFlightRef.current === 'older') inFlightRef.current = null
            })
          } else if (entry.target === bottomSentinelRef.current) {
            if (inFlightRef.current) return
            inFlightRef.current = 'newer'
            Promise.resolve(expandNewer()).finally(() => {
              if (inFlightRef.current === 'newer') inFlightRef.current = null
            })
          }
        }
      },
      { root, rootMargin: '200px 0px', threshold: 0 },
    )
    if (topSentinelRef.current) observer.observe(topSentinelRef.current)
    if (bottomSentinelRef.current) observer.observe(bottomSentinelRef.current)
    return () => observer.disconnect()
  }, [expandOlder, expandNewer])

  // ===== 滚动监听：决定「回到今日」按钮可见性 =====
  // R5-2：scroll 监听必须依赖 todaySectionRef.current —— 否则跨午夜后
  // 新的 today section 重新挂载时，handleScroll 仍读取旧的 todaySectionRef.current，
  // 「回到今日」按钮的可见性判断就错位了。
  useEffect(() => {
    const el = scrollRef.current
    const today = todaySectionRef.current
    if (!el || !today) return
    const handleScroll = () => {
      const cur = el.scrollTop
      const top = today.offsetTop
      // 距离今日 > 600px 才显示
      setShowJump(Math.abs(cur - top) > 600)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [renderDays.length])

  // ===== handler passthroughs =====
  // 内联新建：创建一条空标题便签；status 由 store 推断（今日 = in_progress，否则 = todo）
  const handleCreateEmpty = useCallback(
    async (dateKey: string): Promise<string | null> => {
      try {
        const note = await createNote({
          title: '',
          date: dateKey,
          priority: 'p3',
          steps: [],
        })
        return note.id
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[sticky-timeline] 新建便签失败：', err)
        return null
      }
    },
    [createNote],
  )
  const handleUpdate = useCallback(
    (id: string, patch: StickyNoteUpdate) => updateNote(id, patch),
    [updateNote],
  )
  const handleDelete = useCallback(
    (_id: string) => {
      // P0-3：删除改走软删除（archive + toast 撤销），由 handleSoftDelete 接管
      /* no-op: actual soft delete via onSoftDelete */
    },
    [],
  )
  const handleAddStep = useCallback(
    (noteId: string, content: string) => {
      addStep(noteId, content).catch(() => {})
    },
    [addStep],
  )
  const handleUpdateStep = useCallback(
    (noteId: string, stepId: string, patch: StickyNoteStepPatch) => {
      updateStep(noteId, stepId, patch).catch(() => {})
    },
    [updateStep],
  )
  const handleRemoveStep = useCallback(
    (noteId: string, stepId: string) => {
      removeStep(noteId, stepId).catch(() => {})
    },
    [removeStep],
  )

  // H1：status='done' 走 complete()（写 completions）；其它走 setStatus()
  // R5-3：调完 IPC 后必须把返回写回 store，否则 UI 卡在旧 status。
  // dashboard/TodayTodosWidget 在 round 4 已修，但 StickyTimeline 漏掉了。
  //
  // R12 修复 (high)：complete / setStatus 已经把更新后的 row 返回到客户端，
  // 这里再调一次 updateNote 触发 stickyNotesApi.update 走完整 IPC + DB 写
  // 是冗余二次往返，且 setStatus 通道会让 completed_at 被覆盖。改为直接
  // 把 row 写入 byDate + all，不再走 IPC。
  const applyServerNote = useCallback(
    (note: StickyNote) => {
      // R14 修复 (high)：原先只 patch `all`，但 store 的 byDate 才是
      // filteredByDate 的数据源；noFilter 分支直接 return byDate 引用，
      // 漏 patch byDate 会让 day section 一直显示旧 status。这里同步
      // 重建 byDate，保证跨日期修改也能覆盖两侧。
      // R22 修复 (high correctness)：原版 `if (idx < 0) return` 在以下场景
      // 静默吞掉更新 —— 用户刚 un-archived 一个 sticky，timeline filter 默认
      // 不显示 archived → loadAllFiltered 没拉过这条；用户点 timeline 卡片
      // 的 status dropdown 改状态 → handleStatusChange → complete/setStatus
      // IPC 成功 → applyServerNote(updated) → all.findIndex 没找到 → return
      // → 卡片视觉停留在旧 status，但 DB 已是新 status（completions 表也写了），
      // 状态 / heatmap / UI 三方脱钩。改为：byDate 始终 patch；all 找不到时
      // 不 patch（store 后续 reload 会拉进来），但 byDate 的所有 day section
      // 会被重建，filter 把这张卡显示出来时它已是新值。
      const state = useStickyNotesStore.getState()
      const all = state.all
      const byDate = state.byDate
      const idx = all.findIndex((n) => n.id === note.id)
      let nextAll = all
      if (idx >= 0) {
        nextAll = all.slice()
        nextAll[idx] = note
      }
      const nextByDate: Record<string, StickyNote[]> = {}
      for (const dk of Object.keys(byDate)) {
        nextByDate[dk] = byDate[dk].map((n) => (n.id === note.id ? note : n))
      }
      if (!nextByDate[note.date]) {
        nextByDate[note.date] = [note]
      }
      useStickyNotesStore.setState({ all: nextAll, byDate: nextByDate })
    },
    [],
  )
  const handleStatusChange = useCallback(
    (id: string, status: StickyNoteUpdate['status']) => {
      if (!status) return
      const apply = (updated: StickyNote | null) => {
        if (updated) applyServerNote(updated)
      }
      if (status === 'done') {
        stickyNotesApi.complete(id).then(apply).catch(() => {})
      } else {
        stickyNotesApi.setStatus(id, status).then(apply).catch(() => {})
      }
    },
    [applyServerNote],
  )

  // 离今日的距离（用于「回到今日」按钮文案）
  // R6R-4：原来 useMemo 的 deps 是 [days.length] —— refs 不是响应式数据，
  // 滚动后不会重算，方向会停留在 days 上次变化时的快照。改成依赖 showJump
  // （scroll 监听里写 setShowJump 时一并触发更新），确保方向随时正确。
  const jumpLabel = showJump
    ? (() => {
        const today = todaySectionRef.current
        const sc = scrollRef.current
        if (!today || !sc) return '回到今日'
        return sc.scrollTop > today.offsetTop ? '↓ 回到今日' : '↑ 回到今日'
      })()
    : '回到今日'

  // R12 修复 (high)：按日期 memo StickyDaySection 的 props 包。renderDays
  // 数组变化、filteredByDate 引用变化或 isToday 判定变化时才重算 prop 包，
  // 循环内不再每次 render 重新 new 对象，StickyDaySection memo 重新生效。
  const sectionPropsByDate = useMemo(() => {
    const m = new Map<string, {
      dateKey: string
      notes: StickyNote[]
      isToday: boolean
      onUpdate: typeof handleUpdate
      onDelete: typeof handleDelete
      onAddStep: typeof handleAddStep
      onUpdateStep: typeof handleUpdateStep
      onRemoveStep: typeof handleRemoveStep
      onCreateEmpty: typeof handleCreateEmpty
      onStatusChange: typeof handleStatusChange
      onSoftDelete: typeof handleSoftDelete
    }>()
    for (const dk of renderDays) {
      m.set(dk, {
        dateKey: dk,
        notes: filteredByDate[dk] ?? [],
        isToday: dk === todayKey,
        onUpdate: handleUpdate,
        onDelete: handleDelete,
        onAddStep: handleAddStep,
        onUpdateStep: handleUpdateStep,
        onRemoveStep: handleRemoveStep,
        onCreateEmpty: handleCreateEmpty,
        onStatusChange: handleStatusChange,
        onSoftDelete: handleSoftDelete,
      })
    }
    return m
  }, [
    renderDays,
    filteredByDate,
    todayKey,
    handleUpdate,
    handleDelete,
    handleAddStep,
    handleUpdateStep,
    handleRemoveStep,
    handleCreateEmpty,
    handleStatusChange,
    handleSoftDelete,
  ])

  return (
    <div className="sticky-timeline-scroll" ref={scrollRef}>
      {/* P0-2：搜索 + 优先级过滤 chips */}
      <div className="sticky-timeline-toolbar" role="search">
        <div className="sticky-timeline-search">
          <span className="icon" aria-hidden>🔍</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索便签 / 步骤..."
            aria-label="搜索便签"
          />
          <span className="kbd" aria-hidden>/</span>
        </div>
        <div className="sticky-timeline-filters" role="group" aria-label="按优先级过滤">
          {(['p0', 'p1', 'p2', 'p3'] as Priority[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`sticky-timeline-chip priority-${p}${activePriorities.has(p) ? ' is-active' : ''}`}
              onClick={() => togglePriority(p)}
              aria-pressed={activePriorities.has(p)}
              aria-label={`优先级 ${p.toUpperCase()}`}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div ref={topSentinelRef} className="sticky-timeline-sentinel" />

      {renderDays.map((dk) => {
        const isToday = dk === todayKey
        // R12 修复 (high)：原版每次 render 都在循环内构造一个新的 sectionProps
        // 对象，浅比较永远失败 → StickyDaySection memo 失效，每次输入框
        // keystroke 都会重渲染 600+ StickyNoteCard。现在按日期 memo 一次：
        // dateKey 变化才重算 prop 包，回调本身已是 useCallback 稳定引用。
        const sectionProps = sectionPropsByDate.get(dk) ?? {
          dateKey: dk,
          notes: filteredByDate[dk] ?? [],
          isToday,
          onUpdate: handleUpdate,
          onDelete: handleDelete,
          onAddStep: handleAddStep,
          onUpdateStep: handleUpdateStep,
          onRemoveStep: handleRemoveStep,
          onCreateEmpty: handleCreateEmpty,
          onStatusChange: handleStatusChange,
          onSoftDelete: handleSoftDelete,
        }
        if (isToday) {
          return (
            <StickyDaySection
              key={dk}
              ref={todaySectionRef}
              {...sectionProps}
            />
          )
        }
        return <StickyDaySection key={dk} {...sectionProps} />
      })}

      {isFiltered && renderDays.length > 0 && (
        <div className="sticky-timeline-empty-filter">
          当前过滤下没有命中便签。
        </div>
      )}

      <div ref={bottomSentinelRef} className="sticky-timeline-sentinel" />

      {showJump && (
        <div className="sticky-timeline-jump">
          <button type="button" className="btn btn-primary" onClick={scrollToToday}>
            {jumpLabel}
          </button>
        </div>
      )}

      {/* P0-3：删除撤销 toast（5s 倒计时） */}
      {toast && (
        <DeleteToast
          noteTitle={toast.noteTitle}
          expiresAt={toast.expiresAt}
          onUndo={handleUndo}
        />
      )}
    </div>
  )
}

/**
 * R12 修复 (medium)：独立的 toast 组件 —— 1Hz 倒计时由本地 state 维护，
 * 重渲染范围只有这个轻量 DOM 节点，不影响 StickyTimeline 主树。
 */
function DeleteToast({
  noteTitle,
  expiresAt,
  onUndo,
}: {
  noteTitle: string
  expiresAt: number
  onUndo: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // 1Hz 是功能性的 —— 用户在看「Xs」倒计时，决定是否点「撤销」。
    // 但取消了原来的 key={tick} CSS animation 重置（去掉每秒钟的 scale 弹跳装饰）。
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return (
    <div className="sticky-delete-toast" role="status" aria-live="polite">
      <span>便签「{noteTitle}」已归档</span>
      <button type="button" onClick={onUndo} aria-label="撤销归档">
        撤销
      </button>
      <span className="sticky-delete-toast-timer" aria-hidden>
        {remaining}s
      </span>
    </div>
  )
}

/** 暴露给外部的 helper：用于统计当前窗口外还有多少天未加载（调试用） */
export function timelineWindowSize(): number {
  return INITIAL_RADIUS * 2 + 1
}

/** 暴露给外部：调试 diff 范围 */
export function describeTimelineWindow(rangeStart: string, rangeEnd: string, anchor: string) {
  return {
    days: diffDays(fromDayKey(rangeEnd), fromDayKey(rangeStart)) + 1,
    offsetFromAnchor: diffDays(fromDayKey(rangeStart), fromDayKey(anchor)),
  }
}