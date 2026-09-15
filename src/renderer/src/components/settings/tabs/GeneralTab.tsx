/**
 * 常规设置 Tab
 *
 * 字段：语言、主题、密度、默认字号
 * 所有变更立即写入 settings store（由 update 方法持久化）
 */
import { useSettingsStore } from '../../../stores/settings'
import { useAppStore } from '../../../stores/app'
import { SettingField } from '../SettingField'
import { LOCALE_OPTIONS, toLocaleValue } from '@shared/i18n/locales'

/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

/** 密度选项 */
const DENSITY_OPTIONS = [
  { value: 'compact', label: '紧凑' },
  { value: 'comfortable', label: '舒适' },
]

/** 语言选项：来自 shared/i18n/locales.ts 的单一来源。
 *  当前只暴露 zh-CN，但元数据走 typed const，加新 locale 不用改本组件。
 *  展开为可变数组 —— SettingField.options 是 mutable SelectOption[]，
 *  而 LOCALE_OPTIONS 是 as const 派生的 readonly tuple。 */
const LANGUAGE_OPTIONS: { value: string; label: string }[] = [...LOCALE_OPTIONS]

export function GeneralTab() {
  // R37-perf-2：替代全 store 订阅 —— 任何 settings 字段变更都会触发重渲染，
  // 但本 tab 只读 4 个字段。只订阅这 4 个避免无关字段（如 accentColor）写
  // 触发的无谓重渲染。
  const language = useSettingsStore((s) => s.language)
  const theme = useSettingsStore((s) => s.theme)
  const density = useSettingsStore((s) => s.density)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const update = useSettingsStore((s) => s.update)
  const setTheme = useAppStore((s) => s.setTheme)
  const setDensity = useAppStore((s) => s.setDensity)
  const setFontSize = useAppStore((s) => s.setFontSize)

  /**
   * 主题写入 settings store 的同时同步到 app store
   *（app store 才会真正改 document[data-theme]）
   */
  function handleThemeChange(next: string | number | boolean) {
    const value = String(next) as 'auto' | 'light' | 'dark'
    update({ theme: value })
    if (value === 'auto' || value === 'light' || value === 'dark') {
      // auto 模式下回退到 dark（auto 检测能力稍后接入）
      setTheme(value === 'light' ? 'light' : 'dark')
    }
  }

  function handleDensityChange(next: string | number | boolean) {
    const value = String(next) as 'compact' | 'comfortable'
    update({ density: value })
    setDensity(value)
  }

  function handleLanguageChange(next: string | number | boolean) {
    // narrowing 走 toLocaleValue —— 未知值回退到默认 locale，避免
    // `as 'zh-CN'` 把任意字符串塞进 settings store 留下脏数据。
    update({ language: toLocaleValue(next) })
  }

  function handleFontSizeChange(next: string | number | boolean) {
    const n = Number(next)
    if (Number.isFinite(n)) {
      const clamped = Math.max(12, Math.min(18, n))
      update({ fontSize: clamped })
      setFontSize(clamped)
    }
  }

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">常规</h2>
      <p className="settings-tab-subtitle">基础偏好，影响整个应用</p>

      <SettingField
        label="语言"
        description="界面显示语言（暂仅提供简体中文，未来扩展见 src/shared/i18n/locales.ts）"
        type="select"
        value={language}
        onChange={handleLanguageChange}
        options={LANGUAGE_OPTIONS}
      />

      <SettingField
        label="主题"
        description="选择 UI 配色，跟随系统会随操作系统切换"
        type="select"
        value={theme}
        onChange={handleThemeChange}
        options={THEME_OPTIONS}
      />

      <SettingField
        label="密度"
        description="紧凑模式减少列表项间距"
        type="select"
        value={density}
        onChange={handleDensityChange}
        options={DENSITY_OPTIONS}
      />

      <SettingField
        label="默认字号"
        description="任务/笔记等的默认正文字号（12-18）"
        type="number"
        value={fontSize}
        onChange={handleFontSizeChange}
        onBlur={() => update({ fontSize })}
        min={12}
        max={18}
        step={1}
      />
    </div>
  )
}
