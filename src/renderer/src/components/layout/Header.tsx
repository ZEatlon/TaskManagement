/**
 * 顶部导航栏
 * 当前显示应用名 + 实时时钟（用于 P0-模块 10 热力图基础）
 */
import { Link, useRouterState } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../stores/app'
import { useAiStore } from '../../stores/ai'
import { MiniPomodoro } from '../pomodoro/MiniPomodoro'
import { WindowControls } from './WindowControls'
import { BrandMark } from '../brand/BrandMark'
import { findShortcutDef, formatShortcutForOS } from '../../lib/shortcuts'
import { useSettingsStore } from '../../stores/settings'

/**
 * R20 修复 (medium performance)：把 Header 内嵌的 setInterval(now, 1s)
 * 抽到独立的 Clock 子组件。父 Header 不会每秒 re-render（包含 BrandMark /
 * WindowControls / MiniPomodoro 等较重子组件），每秒只有 Clock 自己重渲染。
 */
function Clock(): JSX.Element {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    // UI 清理 (no-motion)：每秒重绘无意义且与「去动效」目标冲突。改为对齐整分钟后每分钟一次。
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    let intervalId: number | undefined
    const timeoutId = window.setTimeout(() => {
      setNow(new Date())
      intervalId = window.setInterval(() => setNow(new Date()), 60_000)
    }, msToNextMinute)
    return () => {
      window.clearTimeout(timeoutId)
      if (intervalId !== undefined) window.clearInterval(intervalId)
    }
  }, [])
  const formatted = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  // R21 修复 (medium a11y)：原版 `aria-label="当前时间"` 会**覆盖** visible
  // 文本 —— screen reader 只读 aria-label 不读 children，导致 sighted user
  // 看到「2026/09/01 周一 14:23:45」但 SR 听到「当前时间」丢失精度。
  // 修复：去掉 aria-label；role="timer" 已经能让 SR 周期性播报文本变化
  // （NVDA / JAWS 在 role=timer 元素值变更时自动 announce），所以直接暴露
  // 文本就是最完整、最一致的可达性方案。
  return (
    <span className="clock" role="timer">
      {formatted}
    </span>
  )
}

export function Header() {
  const [isMaximized, setIsMaximized] = useState(false)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const toggleCommandBar = useAiStore((s) => s.toggleCommandBar)
  // Round 5：快捷键显示按当前平台 + 用户覆盖渲染。Win/Linux 显示 Ctrl K，
  // macOS 显示 ⌘K。同时 title 也跟着改，避免 tooltip 与显示字符错位。
  const shortcutOverrides = useSettingsStore((s) => s.shortcutOverrides)
  const commandBarBinding = useMemo(() => {
    const def = findShortcutDef('command-bar.toggle')
    if (!def) return 'mod+k'
    return shortcutOverrides?.[def.id] || def.defaultBinding
  }, [shortcutOverrides])
  const commandBarLabel = formatShortcutForOS(commandBarBinding)
  // R27-A11Y 修复 (medium WCAG 2.4.8 / 4.1.2)：TanStack Link activeProps
  // 仅切 CSS class，不设 ARIA 状态；屏幕阅读器用户无法感知哪个 nav 项是
  // 当前页。修复：从 useRouterState 拿当前 pathname，对每个 nav Link
  // 判断是否激活，是则补 aria-current="page"。strict 模式下仅当
  // pathname 严格相等才算激活；非 strict（如 /today 子路由）则前缀匹配。
  const currentPath = useRouterState({ select: (s) => s.location.pathname })

  // 订阅主进程的窗口最大化状态变化，用于顶部栏在最大化时的视觉微调
  useEffect(() => {
    let alive = true
    window.api.window
      .isMaximized()
      .then((v) => {
        if (alive) setIsMaximized(v)
      })
      .catch(() => {
        /* ignore */
      })
    const off = window.api.window.onMaximizeChanged((_e, v) => {
      setIsMaximized(v)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // 在 Windows / Linux 上，titleBarStyle: 'hidden' 不会自动支持双击最大化；
  // 我们手动接管 drag 区域上的双击事件，复刻 macOS 行为。
  const isMac = window.api.platform === 'darwin'
  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (isMac) return // macOS hiddenInset 自带双击行为
    // 命中 WindowControls 区域则不处理（避免和 close/min/max 冲突）
    const target = e.target as HTMLElement
    if (target.closest('.window-controls')) return
    void window.api.window.toggleMaximize()
  }

  return (
    <header
      className={`app-header${isMaximized ? ' is-window-maximized' : ''}`}
      onDoubleClick={handleHeaderDoubleClick}
    >
      <div className="header-left">
        <span className="app-brand">
          <BrandMark size={22} className="app-brand-icon" title="TaskPilot" />
          <span className="app-brand-text">TaskPilot</span>
        </span>
        <nav className="header-nav">
          <Link
            to="/"
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
            activeOptions={{ exact: true }}
            aria-current={currentPath === '/' ? 'page' : undefined}
          >
            仪表盘
          </Link>
          <Link
            to="/today"
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
            aria-current={currentPath.startsWith('/today') ? 'page' : undefined}
          >
            便签
          </Link>
          <Link
            to="/notes"
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
            aria-current={currentPath.startsWith('/notes') ? 'page' : undefined}
          >
            笔记
          </Link>
          <Link
            to="/settings"
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
            title="设置"
            aria-current={currentPath.startsWith('/settings') ? 'page' : undefined}
          >
            <span aria-hidden="true">⚙</span> 设置
          </Link>
          <Link
            to="/ai"
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
            aria-current={currentPath.startsWith('/ai') ? 'page' : undefined}
          >
            AI 助手
          </Link>
        </nav>
      </div>
      <div className="header-right">
        <MiniPomodoro />
        <button
          className="ai-sparkle-btn"
          onClick={() => void toggleCommandBar()}
          title={`打开 AI 命令栏 (${commandBarLabel})`}
          aria-label="打开 AI 命令栏"
        >
          <span className="ai-sparkle-glyph">✨</span>
          <span className="ai-sparkle-kbd">{commandBarLabel}</span>
        </button>
        <Link
          to="/settings"
          className="theme-toggle"
          title="设置"
          aria-label="打开设置"
          style={{ textDecoration: 'none', textAlign: 'center', lineHeight: '20px' }}
        >
          ⚙
        </Link>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          // R20 修复 (medium a11y)：原仅 title，screen reader 不一定读；
          // aria-label + aria-pressed 让键盘 / SR 用户明确知道当前状态与
          // 切换方向。
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-pressed={theme === 'dark'}
          title="切换主题"
        >
          {theme === 'dark' ? '🌙' : '☀'}
        </button>
        <Clock />
        <WindowControls />
      </div>
    </header>
  )
}