/**
 * Settings 模块统一导出
 *
 * 顶层路径直接对外暴露主组件，单个 tab 组件亦可按需 import。
 */
export { SettingsLayout } from './SettingsLayout'
export { SettingsSidebar, SETTINGS_TABS } from './SettingsSidebar'
export type { SettingsTabItem } from './SettingsSidebar'
export { SettingField } from './SettingField'
export type { SettingControlType, SettingFieldProps, SelectOption } from './SettingField'

export { GeneralTab } from './tabs/GeneralTab'
export { LibraryTab } from './tabs/LibraryTab'
export { AppearanceTab } from './tabs/AppearanceTab'
export { NotificationsTab } from './tabs/NotificationsTab'
export { EditorTab } from './tabs/EditorTab'
export { AITab } from './tabs/AITab'
export { GitTab } from './tabs/GitTab'
export { AboutTab } from './tabs/AboutTab'
