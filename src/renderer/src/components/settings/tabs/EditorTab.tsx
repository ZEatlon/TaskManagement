/**
 * 编辑器设置 Tab
 *
 * 字段：编辑器字号、自动保存间隔、拼写检查（占位）
 * 编辑器相关设置写入 settings.editor 子键，避免污染 app.settings。
 */
import { useEffect, useState } from 'react'
import { SettingField } from '../SettingField'

/** 自动保存选项 */
const AUTOSAVE_OPTIONS = [
  { value: '30', label: '30 秒' },
  { value: '60', label: '1 分钟' },
  { value: '120', label: '2 分钟' },
  { value: 'off', label: '关闭' },
]

/** 编辑器配置（子键存储） */
interface EditorConfig {
  fontSize: number
  autoSave: string
  spellCheck: boolean
}

const DEFAULT_EDITOR: EditorConfig = {
  fontSize: 14,
  autoSave: '60',
  spellCheck: false,
}

export function EditorTab() {
  const [cfg, setCfg] = useState<EditorConfig>(DEFAULT_EDITOR)
  const [loaded, setLoaded] = useState(false)

  /** 启动时拉取编辑器配置（子键：app.editor） */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.api.invoke<string, EditorConfig | null>('setting:get', 'app.editor')
        if (!cancelled) {
          if (raw) setCfg({ ...DEFAULT_EDITOR, ...raw })
          setLoaded(true)
        }
      } catch (_) {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 通用更新：写入内存 + 持久化 */
  async function patch(p: Partial<EditorConfig>) {
    const next = { ...cfg, ...p }
    setCfg(next)
    try {
      await window.api.invoke('setting:set', { key: 'app.editor', value: next })
    } catch (err) {
      console.error('[editor] save failed', err)
    }
  }

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">编辑器</h2>
      <p className="settings-tab-subtitle">笔记编辑器的偏好</p>

      <SettingField
        label="编辑器字号"
        description="Markdown 编辑区文字大小（12-20）"
        type="number"
        value={cfg.fontSize}
        onChange={(v) => {
          const n = Number(v)
          if (Number.isFinite(n)) patch({ fontSize: Math.max(12, Math.min(20, n)) })
        }}
        onBlur={() => patch({ fontSize: cfg.fontSize })}
        min={12}
        max={20}
        step={1}
        disabled={!loaded}
      />

      <SettingField
        label="自动保存间隔"
        description="编辑时定时保存的间隔（off 表示关闭）"
        type="select"
        value={cfg.autoSave}
        onChange={(v) => patch({ autoSave: String(v) })}
        options={AUTOSAVE_OPTIONS}
      />

      {/* 拼写检查 toggle 已移除 —— M6 修复：之前虽然 disabled 但仍然渲染出来，
          用户点开看不到任何反馈还以为是 bug。等实装了再加回来。
          cfg.spellCheck 字段保留在 EditorSettings 与 patch 类型中以保证兼容，
          但 UI 不再暴露入口。 */}
    </div>
  )
}
