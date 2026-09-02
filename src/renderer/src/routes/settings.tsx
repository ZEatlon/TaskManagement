/**
 * 设置主页
 *
 * 左侧 SettingsSidebar + 右侧 7 个 tab 内容（懒加载直接 import 即可，体量小）。
 * 支持 hash 锚点：/settings#ai 直接激活 AI tab。切换 tab 时同步 hash。
 *
 * Round 6：「快捷键」tab 已下线，set 列表收敛到 7 项。
 */
import { useEffect, useState, type ComponentType } from 'react'
import { SettingsLayout } from '../components/settings/SettingsLayout'
import { SETTINGS_TABS } from '../components/settings/SettingsSidebar'
import { GeneralTab } from '../components/settings/tabs/GeneralTab'
import { LibraryTab } from '../components/settings/tabs/LibraryTab'
import { AppearanceTab } from '../components/settings/tabs/AppearanceTab'
import { NotificationsTab } from '../components/settings/tabs/NotificationsTab'
import { EditorTab } from '../components/settings/tabs/EditorTab'
import { AITab } from '../components/settings/tabs/AITab'
import { GitTab } from '../components/settings/tabs/GitTab'
import { AboutTab } from '../components/settings/tabs/AboutTab'

/** 取当前 hash 对应的 tab id，找不到则回退到第一个 */
function readHashTab(): string {
  if (typeof window === 'undefined') return SETTINGS_TABS[0]?.id ?? 'general'
  const raw = window.location.hash.replace(/^#/, '').trim()
  const found = SETTINGS_TABS.find((t) => t.id === raw)
  return found ? found.id : SETTINGS_TABS[0]?.id ?? 'general'
}

/** tab id → 组件映射 */
const TAB_RENDERERS: Record<string, ComponentType> = {
  general: GeneralTab,
  library: LibraryTab,
  appearance: AppearanceTab,
  notifications: NotificationsTab,
  editor: EditorTab,
  ai: AITab,
  git: GitTab,
  about: AboutTab,
}

export function SettingsRoute() {
  const [activeId, setActiveId] = useState<string>(() => readHashTab())

  /** 监听 hash 变化（用户通过外部链接打开） */
  useEffect(() => {
    const onHash = () => setActiveId(readHashTab())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /** 切换 tab → 更新 hash（不触发滚动） */
  function handleTabChange(id: string) {
    setActiveId(id)
    const target = `#${id}`
    if (window.location.hash !== target) {
      // replaceState 避免污染历史栈
      window.history.replaceState(null, '', target)
    }
  }

  const Renderer: ComponentType = TAB_RENDERERS[activeId] ?? GeneralTab

  return (
    <div className="settings-page">
      <SettingsLayout activeId={activeId} onTabChange={handleTabChange}>
        <Renderer />
      </SettingsLayout>
    </div>
  )
}
