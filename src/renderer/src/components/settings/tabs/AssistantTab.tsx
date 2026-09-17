/**
 * W2-B AI 助手设置 Tab
 *
 * 字段：
 *   - enabled 总开关
 *   - workHours 工作时段（start / end hour）
 *   - frequencyCapPerHour 频率上限（每 category 每小时上限）
 *   - mutedCategories 静音类别（多选 checkbox）
 *   - customHints 自定义文案（按 category 的 textarea）
 *
 * 数据流：assistantApi.getPrefs / setPrefs（直接走 IPC，不进 useSettingsStore，
 * 因为助手偏好和 app.settings 不在同一份 schema 里 —— 由 daemon 单独管理）。
 */
import { useEffect, useState } from 'react'
import { assistantApi } from '../../../lib/ipc'
import { announce } from '../../common/AriaAnnouncer'

type Category =
  | 'focus-streak'
  | 'sedentary-reminder'
  | 'motivational-quote'
  | 'sticky-overdue'
  | 'pomodoro-reflection'
  | 'long-edit-nudge'

interface Prefs {
  enabled: boolean
  workHours: { startHour: number; endHour: number }
  frequencyCapPerHour: number
  mutedCategories: Category[]
  customHints: Partial<Record<Category, string>>
}

const CATEGORY_LABELS: Record<Category, string> = {
  'focus-streak':       '连续专注番茄里程碑',
  'sedentary-reminder': '久坐提醒（每 60 分钟）',
  'motivational-quote': '每日励志名言',
  'sticky-overdue':     '便签超期',
  'pomodoro-reflection':'专注完成时让 AI 反思',
  'long-edit-nudge':    '笔记编辑过久（只计时，不传内容）',
}

const ALL_CATEGORIES: Category[] = [
  'focus-streak',
  'sedentary-reminder',
  'motivational-quote',
  'sticky-overdue',
  'pomodoro-reflection',
  'long-edit-nudge',
]

export function AssistantTab() {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const p = (await assistantApi.getPrefs()) as unknown as Prefs
        if (!cancelled) setPrefs(p)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function persist(next: Prefs): Promise<void> {
    setPrefs(next)
    setSaving(true)
    try {
      const saved = (await assistantApi.setPrefs(next)) as unknown as Prefs
      setPrefs(saved)
      announce('助手偏好已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function toggleMuted(category: Category): void {
    if (!prefs) return
    const muted = prefs.mutedCategories.includes(category)
      ? prefs.mutedCategories.filter((c) => c !== category)
      : [...prefs.mutedCategories, category]
    void persist({ ...prefs, mutedCategories: muted })
  }

  function setCustomHint(category: Category, text: string): void {
    if (!prefs) return
    const next = { ...prefs.customHints }
    if (text.trim()) next[category] = text
    else delete next[category]
    void persist({ ...prefs, customHints: next })
  }

  if (error) {
    return (
      <div className="assistant-tab">
        <div className="error" role="alert">加载助手偏好失败：{error}</div>
      </div>
    )
  }

  if (!prefs) {
    return (
      <div className="assistant-tab">
        <div className="muted">加载中…</div>
      </div>
    )
  }

  return (
    <div className="assistant-tab">
      <h3 className="section-title">AI 助手通知</h3>
      <p className="muted">
        助手按事件触发（专注番茄完成 / 久坐 / 便签超期 / 编辑过久），
        默认只在工作时段内、低频率地推送提示。可在下方关闭某类别或自定义文案。
      </p>

      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(e) => void persist({ ...prefs, enabled: e.target.checked })}
          />
          {' '}启用 AI 助手通知
        </label>
      </div>

      <div className="setting-row">
        <label>工作时段</label>
        <div className="row-inline">
          <input
            type="number"
            min={0}
            max={23}
            value={prefs.workHours.startHour}
            onChange={(e) =>
              void persist({
                ...prefs,
                workHours: {
                  ...prefs.workHours,
                  startHour: clamp(parseInt(e.target.value, 10) || 0, 0, 23),
                },
              })
            }
            aria-label="起始小时"
          />
          <span>:</span>
          <input
            type="number"
            min={0}
            max={23}
            value={prefs.workHours.endHour}
            onChange={(e) =>
              void persist({
                ...prefs,
                workHours: {
                  ...prefs.workHours,
                  endHour: clamp(parseInt(e.target.value, 10) || 0, 0, 23),
                },
              })
            }
            aria-label="结束小时"
          />
          <span className="muted">（支持跨夜，例如 22 → 6）</span>
        </div>
      </div>

      <div className="setting-row">
        <label>频率上限（每类每小时）</label>
        <input
          type="number"
          min={1}
          max={20}
          value={prefs.frequencyCapPerHour}
          onChange={(e) =>
            void persist({
              ...prefs,
              frequencyCapPerHour: clamp(parseInt(e.target.value, 10) || 1, 1, 20),
            })
          }
        />
      </div>

      <h4 className="section-subtitle">类别开关</h4>
      <ul className="assistant-category-list">
        {ALL_CATEGORIES.map((cat) => {
          const muted = prefs.mutedCategories.includes(cat)
          return (
            <li key={cat} className="assistant-category-row">
              <label>
                <input
                  type="checkbox"
                  checked={!muted}
                  onChange={() => toggleMuted(cat)}
                />
                {' '}{CATEGORY_LABELS[cat] ?? cat}
              </label>
              <textarea
                className="custom-hint-input"
                placeholder={`自定义文案（留空用默认）`}
                value={prefs.customHints[cat] ?? ''}
                onChange={(e) => setCustomHint(cat, e.target.value)}
                rows={2}
              />
            </li>
          )
        })}
      </ul>

      {saving && <span className="muted small">保存中…</span>}

      <p className="muted small assistant-privacy-note">
        隐私：助手只读取事件元信息（番茄阶段、便签标题、编辑时长），不会把笔记正文或便签内容发给 AI 模型。
        自定义文案仅在你本人设备本地存储。
      </p>
    </div>
  )
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
