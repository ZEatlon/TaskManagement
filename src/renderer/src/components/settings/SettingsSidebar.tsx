/**
 * 设置页侧边 tab 导航
 *
 * 一组左侧 200px 的导航项，点击切换右侧内容。
 * 通过 `activeId` 高亮当前 tab，`onSelect` 由父组件处理。
 */

export interface SettingsTabItem {
  /** tab 唯一 id，对应 hash（如 #ai） */
  id: string
  /** 显示名称 */
  label: string
  /** 图标（emoji 即可） */
  icon: string
}

export interface SettingsSidebarProps {
  /** 当前激活 tab id（不含 #） */
  activeId: string
  /** 点击 tab 回调 */
  onSelect: (id: string) => void
  /** tab 配置列表 */
  items: SettingsTabItem[]
}

/**
 * 默认的 8 个 tab 配置（导出供设置页使用）
 *
 * Round 6：删除「快捷键」tab —— dashboard 顶部栏已承载常用快捷入口，
 * 设置入口也可从顶部导航直达，没必要再开一层自定义 UI。
 */
export const SETTINGS_TABS: SettingsTabItem[] = [
  { id: 'general', label: '常规', icon: '⚙' },
  { id: 'library', label: '库', icon: '📚' },
  { id: 'appearance', label: '外观', icon: '🎨' },
  { id: 'notifications', label: '通知', icon: '🔔' },
  { id: 'editor', label: '编辑器', icon: '📝' },
  { id: 'ai', label: 'AI', icon: '🤖' },
  { id: 'git', label: 'Git', icon: '🌿' },
  { id: 'about', label: '关于', icon: 'ℹ' },
]

export function SettingsSidebar({ activeId, onSelect, items }: SettingsSidebarProps) {
  // R13 修复 (medium)：补 ARIA tablist / tab / aria-current 模式，并加
  // Home/End / ArrowUp/Down 键盘导航。键盘 / SR 用户现在能听到"当前选
  // 中的是……"，并用方向键在 tab 间切换。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const order = items.map((i) => i.id)
    const idx = order.indexOf(activeId)
    if (idx < 0) return
    let nextIdx = idx
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      nextIdx = (idx + 1) % order.length
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      nextIdx = (idx - 1 + order.length) % order.length
    } else if (e.key === 'Home') {
      e.preventDefault()
      nextIdx = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      nextIdx = order.length - 1
    } else {
      return
    }
    onSelect(order[nextIdx])
    const next = document.querySelector<HTMLButtonElement>(
      `.settings-tab-list button[data-tab-id="${order[nextIdx]}"]`,
    )
    next?.focus()
  }
  return (
    <nav className="settings-sidebar" aria-label="设置导航">
      <ul
        className="settings-tab-list"
        role="tablist"
        aria-orientation="vertical"
        onKeyDown={handleKeyDown}
      >
        {items.map((item) => {
          const isActive = activeId === item.id
          return (
            <li key={item.id} role="presentation">
              <button
                type="button"
                data-tab-id={item.id}
                role="tab"
                aria-selected={isActive}
                aria-current={isActive ? 'page' : undefined}
                tabIndex={isActive ? 0 : -1}
                className={`settings-tab ${isActive ? 'active' : ''}`}
                onClick={() => onSelect(item.id)}
              >
                <span className="settings-tab-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="settings-tab-label">{item.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
