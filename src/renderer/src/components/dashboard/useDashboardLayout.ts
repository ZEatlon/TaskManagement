/**
 * Dashboard 布局 hook
 *
 * 把 localStorage 持久化抽象成一个 React 状态：
 *   const { layout, setLayout, resetLayout } = useDashboardLayout()
 *
 * - 默认布局来自 DEFAULT_LAYOUT
 * - 写入 setLayout 会同步到 localStorage
 * - 读不到 v2 数据时自动尝试从 v1 迁移（见 [DashboardEditorModal.tsx](DashboardEditorModal.tsx)）
 */
import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_LAYOUT,
  DASHBOARD_LAYOUT_STORAGE_KEY,
  loadLayout,
  saveLayout,
  type DashboardLayout,
} from './DashboardEditorModal'

export function useDashboardLayout() {
  const [layout, setLayoutState] = useState<DashboardLayout>(() => loadLayout())

  // 跨标签页同步：当其它标签修改了 localStorage，本标签也要 reload
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === DASHBOARD_LAYOUT_STORAGE_KEY) {
        setLayoutState(loadLayout())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setLayout = useCallback((next: DashboardLayout) => {
    setLayoutState(next)
    saveLayout(next)
  }, [])

  const resetLayout = useCallback(() => {
    setLayoutState(DEFAULT_LAYOUT)
    saveLayout(DEFAULT_LAYOUT)
  }, [])

  return { layout, setLayout, resetLayout }
}

export default useDashboardLayout