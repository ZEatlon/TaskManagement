/**
 * 全局底部状态栏
 *
 * 显示在所有页面底部，集中展示：
 * - 当前路由 / 标题
 * - 今日便签 / 今日已完成 / 进行中便签 / 笔记总数 / 库位置
 * - 同步状态指示
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useStickyNotesStore } from '../../stores/stickyNotes'
import { useNotesStore } from '../../stores/notes'
import { useSettingsStore } from '../../stores/settings'
import { dayKeyOf } from '../../lib/date'

interface RouteMeta {
  label: string
  icon: string
}

const ROUTE_META: Record<string, RouteMeta> = {
  '/': { label: 'Dashboard', icon: '◐' },
  '/today': { label: '今日', icon: '☀' },
  '/notes': { label: '笔记', icon: '✎' },
  '/pomodoro': { label: '番茄钟', icon: '⏱' },
  '/settings': { label: '设置', icon: '⚙' },
  '/ai': { label: 'AI 助手', icon: '✦' },
}

function lookupRouteMeta(pathname: string): RouteMeta {
  if (ROUTE_META[pathname]) return ROUTE_META[pathname]
  for (const key of Object.keys(ROUTE_META)) {
    if (key !== '/' && pathname.startsWith(key + '/')) return ROUTE_META[key]
  }
  return { label: pathname.replace(/^\//, '') || 'TaskPilot', icon: '·' }
}

export function StatusBar() {
  const loc = useLocation()
  // Perf-fix #4：只订阅 byDate —— `all` 走 getState() 命令式读。
  // 原版同时订阅两个字段 → 任何 sticky mutation（每步勾选 / 状态切换 /
  // 编辑）都触发两次 store 比较 + 整树 StatusBar 重渲染。byDate 是
  // single source of truth（每次 mutation 都会同步更新两个字段），
  // 用 getState() 拿 `all` 做兜底遍历不会丢数据但不再订阅。
  const byDate = useStickyNotesStore((s) => s.byDate)
  const notes = useNotesStore((s) => s.notes)
  const libraryPath = useSettingsStore((s) => s.libraryPath)

  // R11 修复 (low #4)：原版 useMemo([]) 一次性固化 todayKey，用户在 23:55 打开
  // App 到 00:30 后仍把「昨天」当今天 → 状态栏显示「今日便签 N」用的是昨天的
  // 数字，跨日便签统计错位。改用 state + 跨午夜定时器，与 FocusCalendar.today
  // 保持一致的更新策略。
  const [todayKey, setTodayKey] = useState<string>(() => dayKeyOf(new Date()))
  useEffect(() => {
    let timer: number | null = null
    function scheduleNextMidnightRefresh() {
      const now = new Date()
      const next = new Date(now)
      next.setHours(24, 0, 5, 0)
      const ms = Math.max(1000, next.getTime() - now.getTime())
      timer = window.setTimeout(() => {
        setTodayKey(dayKeyOf(new Date()))
        scheduleNextMidnightRefresh()
      }, ms)
    }
    scheduleNextMidnightRefresh()
    function onVisibility() {
      if (document.visibilityState === 'visible') setTodayKey(dayKeyOf(new Date()))
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  const todayStickies = useMemo(
    () => byDate[todayKey] ?? [],
    [byDate, todayKey],
  )
  const todayDone = useMemo(
    () => todayStickies.filter((n) => n.status === 'done').length,
    [todayStickies],
  )
  const totalActive = useMemo(() => {
    // R12 修复 (low)：原版每次 render 都重建 Map 但其实只关心数量，O(N)
    // 重建不合理。直接 id Set 去重。
    //
    // Perf-fix #4：`all` 改走 getState() 兜底 —— 不再订阅，避免每次 sticky
    // mutation 都让 StatusBar 重渲染（store invariant：每次 mutation
    // 都同时更新 byDate + all，因此 byDate 触发时 byDate 一定已是最新）。
    const seen = new Set<string>()
    let count = 0
    const countIfActive = (n: { id: string; archived?: boolean; status?: string }) => {
      if (seen.has(n.id)) return
      seen.add(n.id)
      if (!n.archived && n.status !== 'done' && n.status !== 'cancelled') count++
    }
    for (const list of Object.values(byDate)) for (const n of list) countIfActive(n)
    const allFallback = useStickyNotesStore.getState().all
    for (const n of allFallback) countIfActive(n)
    return count
  }, [byDate])

  // R5-25：原本的 30s setInterval 只 setTick 然后 void tick，tick 永远不被读取。
  // 删掉这段死代码。如果后续要在 StatusBar 显示分钟级时间，需要再单独加 useNow 之类。
  const meta = lookupRouteMeta(loc.pathname)

  // 库路径缩写：超过 50 字符截断中间
  const truncatedPath = useMemo(() => {
    if (!libraryPath) return ''
    if (libraryPath.length <= 50) return libraryPath
    const head = libraryPath.slice(0, 22)
    const tail = libraryPath.slice(-22)
    return `${head}…${tail}`
  }, [libraryPath])

  return (
    <footer className="status-bar" role="contentinfo">
      <div className="status-bar-left">
        <span className="status-bar-route" title={loc.pathname}>
          <span className="status-bar-route-icon" aria-hidden>
            {meta.icon}
          </span>
          <span className="status-bar-route-label">{meta.label}</span>
        </span>
        <span className="status-bar-sep" />
        {libraryPath && (
          <span className="status-bar-path" title={libraryPath}>
            <span className="status-bar-path-icon" aria-hidden>
              📁
            </span>
            <code>{truncatedPath}</code>
          </span>
        )}
        <span className="status-bar-sep" />
        <span className="status-bar-item" title={`今日 ${todayStickies.length} 张便签`}>
          <span className="status-bar-num">{todayStickies.length}</span>
          <span className="status-bar-label">今日便签</span>
        </span>
        <span className="status-bar-item" title={`今日已完成 ${todayDone} 张`}>
          <span className="status-bar-num success">{todayDone}</span>
          <span className="status-bar-label">已完成</span>
        </span>
        <span className="status-bar-item" title={`进行中 ${totalActive} 张`}>
          <span className="status-bar-num">{totalActive}</span>
          <span className="status-bar-label">进行中</span>
        </span>
      </div>

      <div className="status-bar-center">{null}</div>

      <div className="status-bar-right">
        <span className="status-bar-item subtle">
          <span className="status-bar-label">笔记</span>
          <span className="status-bar-num">{notes.length}</span>
        </span>
        <span className="status-bar-sep" />
        <span className="status-bar-indicator" data-state="ok" title="运行正常">
          <span className="dot" /> 就绪
        </span>
      </div>
    </footer>
  )
}
