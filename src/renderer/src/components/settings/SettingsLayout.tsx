/**
 * 设置页布局
 *
 * 左侧 200px SettingsSidebar + 右侧内容区（最大宽度 800px）。
 * 通过 `activeId` 与 `onTabChange` 维护当前 tab；切换时滚动到顶部。
 */
import { useEffect, type ReactNode } from 'react'
import { SettingsSidebar, SETTINGS_TABS } from './SettingsSidebar'

export interface SettingsLayoutProps {
  /** 当前激活的 tab id（不含 #） */
  activeId: string
  /** tab 切换回调，参数为新 tab id（不含 #） */
  onTabChange: (id: string) => void
  /** 右侧内容 */
  children: ReactNode
}

/**
 * 设置页左右布局
 */
export function SettingsLayout({ activeId, onTabChange, children }: SettingsLayoutProps) {
  // 切换 tab 时把右侧内容区滚回顶部
  useEffect(() => {
    const el = document.querySelector('.settings-content')
    if (el) el.scrollTop = 0
  }, [activeId])

  return (
    <div className="settings-layout">
      <SettingsSidebar activeId={activeId} onSelect={onTabChange} items={SETTINGS_TABS} />
      {/*
        R33-A11y-Tab-Panel 修复 (medium aria-controls-missing)：
        右侧内容区承担唯一可见的 tabpanel。id 与 SettingsSidebar 各 tab 的
        aria-controls="settings-panel" 对应；aria-labelledby 动态绑定当前激活
        tab 的 id（与 tab 的 id="settings-tab-<activeId>" 匹配），让 SR 在
        进入 panel 时播报「tab panel, <当前 tab 名称>」。tabIndex={0} 让
        panel 可获焦，符合 WAI-ARIA APG Tabs pattern。
      */}
      <section
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeId}`}
        tabIndex={0}
        className="settings-content"
      >
        <div className="settings-content-inner">{children}</div>
      </section>
    </div>
  )
}
