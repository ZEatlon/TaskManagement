/**
 * 外观设置 Tab
 *
 * 字段：主题预览（auto / light / dark 三色板）、强调色（蓝/绿/紫/橙）
 * 主题变更走 app store，强调色写入 settings store 的 accentColor 字段。
 *
 * a11y：两个 radiogroup 均实现 WAI-ARIA roving tabindex 模式，
 *      通过方向键/Home/End 在选项间循环，Tab 键进出组只消耗一次焦点。
 */
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useSettingsStore } from '../../../stores/settings'
import { useAppStore } from '../../../stores/app'
import { SettingField } from '../SettingField'

/** 主题模式的固定顺序，用于在 radiogroup 中定位索引 */
const THEME_MODES = ['auto', 'light', 'dark'] as const
type ThemeMode = (typeof THEME_MODES)[number]

/** 强调色选项 */
const ACCENT_OPTIONS: { value: string; label: string; color: string }[] = [
  { value: '#58a6ff', label: '海蓝', color: '#58a6ff' },
  { value: '#3fb950', label: '森林绿', color: '#3fb950' },
  { value: '#a371f7', label: '紫罗兰', color: '#a371f7' },
  { value: '#f0883e', label: '落日橙', color: '#f0883e' },
]

/**
 * Roving tabindex + 方向键循环。
 * 处理 ArrowRight/Down（下一项）、ArrowLeft/Up（上一项）、Home、End，
 * 焦点移动后立即激活对应选项，并阻止默认滚动。
 */
function cycleRadioGroup(
  e: KeyboardEvent<HTMLDivElement>,
  container: HTMLDivElement,
  activeIndex: number,
  count: number,
  activate: (index: number) => void
): void {
  if (count <= 0) return
  let next = activeIndex
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (activeIndex + 1) % count
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (activeIndex - 1 + count) % count
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    default:
      return
  }
  e.preventDefault()
  const radios = container.querySelectorAll<HTMLElement>('[role="radio"]')
  radios[next]?.focus()
  activate(next)
}

export function AppearanceTab() {
  const theme = useSettingsStore((s) => s.theme)
  const accentColor = useSettingsStore((s) => s.accentColor)
  const updateSettings = useSettingsStore((s) => s.update)
  const setTheme = useAppStore((s) => s.setTheme)

  const themeGroupRef = useRef<HTMLDivElement>(null)
  const accentGroupRef = useRef<HTMLDivElement>(null)

  /** 主题切换：写入 settings + 同步应用到 app store */
  function handleThemePick(mode: ThemeMode) {
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

  const themeIndex = THEME_MODES.indexOf(theme as ThemeMode)
  const accentIndex = ACCENT_OPTIONS.findIndex((o) => o.value === accentColor)

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">外观</h2>
      <p className="settings-tab-subtitle">主题与配色</p>

      <SettingField label="主题预览" description="三套主题色板示例（点击立即应用）" type="custom">
        <div
          className="theme-swatches"
          role="radiogroup"
          aria-label="主题"
          ref={themeGroupRef}
          onKeyDown={(e) => {
            const el = themeGroupRef.current
            if (!el) return
            cycleRadioGroup(e, el, themeIndex < 0 ? 0 : themeIndex, THEME_MODES.length, (i) =>
              handleThemePick(THEME_MODES[i])
            )
          }}
        >
          <Swatch
            label="自动"
            mode="auto"
            active={theme === 'auto'}
            tabIndex={theme === 'auto' ? 0 : -1}
            onClick={() => handleThemePick('auto')}
            top="#5b9bff"
            mid="#22272e"
            bottom="#0f1115"
          />
          <Swatch
            label="浅色"
            mode="light"
            active={theme === 'light'}
            tabIndex={theme === 'light' ? 0 : -1}
            onClick={() => handleThemePick('light')}
            top="#0969da"
            mid="#eaeef2"
            bottom="#ffffff"
          />
          <Swatch
            label="深色"
            mode="dark"
            active={theme === 'dark'}
            tabIndex={theme === 'dark' ? 0 : -1}
            onClick={() => handleThemePick('dark')}
            top="#58a6ff"
            mid="#1a1d23"
            bottom="#0f1115"
          />
        </div>
      </SettingField>

      <SettingField label="强调色" description="按钮、链接、高亮等使用的主色" type="custom">
        <div
          className="accent-options"
          role="radiogroup"
          aria-label="强调色"
          ref={accentGroupRef}
          onKeyDown={(e) => {
            const el = accentGroupRef.current
            if (!el) return
            cycleRadioGroup(e, el, accentIndex < 0 ? 0 : accentIndex, ACCENT_OPTIONS.length, (i) =>
              handleAccent(ACCENT_OPTIONS[i].color)
            )
          }}
        >
          {ACCENT_OPTIONS.map((opt) => {
            const active = accentColor === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                className={`accent-option ${active ? 'active' : ''}`}
                onClick={() => handleAccent(opt.color)}
                title={opt.label}
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                aria-label={`${opt.label}强调色${active ? '（当前选中）' : ''}`}
              >
                <span className="accent-circle" style={{ background: opt.color }} />
                <span className="accent-label">{opt.label}</span>
              </button>
            )
          })}
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
  tabIndex,
  onClick,
  top,
  mid,
  bottom,
}: {
  label: string
  mode: string
  active: boolean
  tabIndex: number
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
      role="radio"
      aria-checked={active}
      tabIndex={tabIndex}
      aria-label={`${label}主题${active ? '（当前选中）' : ''}`}
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