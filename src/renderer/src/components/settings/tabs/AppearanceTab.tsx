/**
 * 外观设置 Tab
 *
 * 字段：主题预览（auto / light / dark 三色板）、强调色（蓝/绿/紫/橙）
 * 主题变更走 app store，强调色写入 settings store 的 accentColor 字段。
 */
import { useSettingsStore } from '../../../stores/settings'
import { useAppStore } from '../../../stores/app'
import { SettingField } from '../SettingField'

/** 强调色选项 */
const ACCENT_OPTIONS: { value: string; label: string; color: string }[] = [
  { value: '#58a6ff', label: '海蓝', color: '#58a6ff' },
  { value: '#3fb950', label: '森林绿', color: '#3fb950' },
  { value: '#a371f7', label: '紫罗兰', color: '#a371f7' },
  { value: '#f0883e', label: '落日橙', color: '#f0883e' },
]

export function AppearanceTab() {
  const theme = useSettingsStore((s) => s.theme)
  const updateSettings = useSettingsStore((s) => s.update)
  const setTheme = useAppStore((s) => s.setTheme)

  /** 主题切换：写入 settings + 同步应用到 app store */
  function handleThemePick(mode: 'auto' | 'light' | 'dark') {
    void updateSettings({ theme: mode })
    if (mode === 'light' || mode === 'dark') {
      setTheme(mode)
    } else {
      // auto：暂时维持深色（后续接入系统偏好）
      setTheme('dark')
    }
  }

  /** 强调色：直接修改 CSS 变量，并把值写回 settings（accentColor 字段） */
  function handleAccent(color: string) {
    document.documentElement.style.setProperty('--accent', color)
    document.documentElement.style.setProperty('--accent-hover', color)
    // 走强类型 settings store，持久化在 SETTINGS_KEY_APP 之下
    void updateSettings({ accentColor: color })
  }

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">外观</h2>
      <p className="settings-tab-subtitle">主题与配色</p>

      <SettingField label="主题预览" description="三套主题色板示例（点击立即应用）" type="custom">
        <div className="theme-swatches">
          <Swatch
            label="自动"
            mode="auto"
            active={theme === 'auto'}
            onClick={() => handleThemePick('auto')}
            top="#5b9bff"
            mid="#22272e"
            bottom="#0f1115"
          />
          <Swatch
            label="浅色"
            mode="light"
            active={theme === 'light'}
            onClick={() => handleThemePick('light')}
            top="#0969da"
            mid="#eaeef2"
            bottom="#ffffff"
          />
          <Swatch
            label="深色"
            mode="dark"
            active={theme === 'dark'}
            onClick={() => handleThemePick('dark')}
            top="#58a6ff"
            mid="#1a1d23"
            bottom="#0f1115"
          />
        </div>
      </SettingField>

      <SettingField label="强调色" description="按钮、链接、高亮等使用的主色" type="custom">
        <div className="accent-options">
          {ACCENT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="accent-option"
              onClick={() => handleAccent(opt.color)}
              title={opt.label}
              aria-label={opt.label}
            >
              <span className="accent-circle" style={{ background: opt.color }} />
              <span className="accent-label">{opt.label}</span>
            </button>
          ))}
        </div>
      </SettingField>
    </div>
  )
}

/** 单个主题色板卡片 */
function Swatch({
  label,
  mode,
  active,
  onClick,
  top,
  mid,
  bottom,
}: {
  label: string
  mode: string
  active: boolean
  onClick: () => void
  top: string
  mid: string
  bottom: string
}) {
  return (
    <button
      type="button"
      className={`theme-swatch ${active ? 'active' : ''}`}
      onClick={onClick}
      data-mode={mode}
    >
      <div className="swatch-colors" style={{ background: bottom }}>
        <div className="swatch-strip" style={{ background: mid, borderColor: mid }}>
          <span className="dot" style={{ background: top }} />
        </div>
      </div>
      <span className="swatch-label">{label}</span>
    </button>
  )
}
