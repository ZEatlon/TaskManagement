/**
 * 根路由布局
 *
 * 启动决策（模块 9）：
 *   1. 加载 settings（包含 libraryPath）
 *   2. 若 libraryPath 为空 → 全屏显示 FirstRunWizard
 *   3. 若 libraryPath 有值但目录不可访问 → 弹出 LibraryMissingDialog
 *   4. 一切就绪 → 渲染主界面（Header + Outlet）
 */
import { useEffect, useState } from 'react'
import { Outlet } from '@tanstack/react-router'
import { Header } from '../components/layout/Header'
import { StatusBar } from '../components/layout/StatusBar'
import { useSettingsStore } from '../stores/settings'
import { FirstRunWizard } from '../components/library/FirstRunWizard'
import { LibraryMissingDialog } from '../components/library/LibraryMissingDialog'
import { CommandBar } from '../components/ai/CommandBar'
import { CreateNoteConfirmDialog } from '../components/ai/CreateNoteConfirmDialog'

type BootState =
  | { kind: 'loading' }
  | { kind: 'first-run' }
  | { kind: 'missing'; path: string }
  | { kind: 'ready' }

export function RootRoute() {
  const loadSettings = useSettingsStore((s) => s.load)
  const loaded = useSettingsStore((s) => s.loaded)
  const checkLibraryReady = useSettingsStore((s) => s.checkLibraryReady)

  const [boot, setBoot] = useState<BootState>({ kind: 'loading' })
  /** 用户手动关闭 missing 弹窗后，用于本次会话的 "忽略标记" */
  const [missingDismissed, setMissingDismissed] = useState(false)

  // 启动时加载 settings + 检测 libraryPath
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await loadSettings()
      const { path, exists } = await checkLibraryReady()
      if (cancelled) return
      if (!path) {
        setBoot({ kind: 'first-run' })
      } else if (!exists) {
        setBoot({ kind: 'missing', path })
      } else {
        setBoot({ kind: 'ready' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadSettings, checkLibraryReady])

  // 启动期
  if (boot.kind === 'loading' || !loaded) {
    return (
      <div className="boot-loading">
        <div className="spinner" />
        <p>TaskPilot 启动中…</p>
      </div>
    )
  }

  // 首次启动：全屏向导
  if (boot.kind === 'first-run') {
    return <FirstRunWizard onComplete={() => setBoot({ kind: 'ready' })} />
  }

  // 库目录丢失：弹窗（除非用户主动关闭）
  if (boot.kind === 'missing' && !missingDismissed) {
    return (
      <>
        <div className="app-shell is-dimmed" aria-hidden>
          <Header />
          <main className="app-main">
            <div className="page-placeholder">
              <h1>库目录不可访问</h1>
              <p className="muted">正在等待您处理…</p>
            </div>
          </main>
        </div>
        <LibraryMissingDialog
          missingPath={boot.path}
          onClose={() => setMissingDismissed(true)}
          onReselect={(newPath) => {
            setBoot({ kind: 'ready' })
            void newPath
          }}
        />
      </>
    )
  }

  // 正常主界面
  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <Outlet />
      </main>
      <StatusBar />
      {/* 全局 AI 命令栏（Cmd+K 触发）+ createNote 确认弹窗（仅在 /ai 页触发但挂全局以避免切换时丢失） */}
      <CommandBar />
      <CreateNoteConfirmDialog />
    </div>
  )
}
