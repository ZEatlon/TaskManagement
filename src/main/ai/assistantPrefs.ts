/**
 * W2-B 助手偏好存取层
 *
 * 存储：app.assistant —— 与 app.settings / app.git 同级的 app.* key。
 * schema 校验：DEFAULT_ASSISTANT_PREFS 做形状检查，缺字段补默认；多余字段丢弃。
 *
 * 与 useSettingsStore（renderer 端）的关系：
 *   - 渲染端通过 assistant:prefs:get/set IPC 拉取/写入
 *   - daemon 在事件触发时直接读这里（不绕 renderer）
 *   - 两端都以 settingsRepo 为真源，不维护单独的 in-memory 缓存
 */
import { settingsRepo } from '../db/repositories/settings'
import {
  DEFAULT_ASSISTANT_PREFS,
  type AssistantCategory,
  type AssistantPrefs,
} from './assistantRules'

/** 偏好存储 key —— app.* 命名空间 */
export const ASSISTANT_PREFS_KEY = 'app.assistant'

/** 校验 prefs 形状，把缺字段补默认、多余字段剔除。
 *  显式 enum 校验（category 在 mutedCategories / customHints 中必须是合法值）
 *  —— 防止渲染端旧版 schema 写入导致 daemon 把无效 category 写进 lastFiredMs 索引。 */
const VALID_CATEGORIES = new Set<AssistantCategory>([
  'focus-streak',
  'sedentary-reminder',
  'motivational-quote',
  'sticky-overdue',
  'pomodoro-reflection',
  'long-edit-nudge',
])

function coercePrefs(raw: unknown): AssistantPrefs {
  const fallback = { ...DEFAULT_ASSISTANT_PREFS }
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>

  const enabled = typeof r.enabled === 'boolean' ? r.enabled : fallback.enabled
  const wh = r.workHours
  const workHours =
    wh && typeof wh === 'object'
      ? {
          startHour:
            typeof (wh as Record<string, unknown>).startHour === 'number'
              ? ((wh as Record<string, number>).startHour as number)
              : fallback.workHours.startHour,
          endHour:
            typeof (wh as Record<string, unknown>).endHour === 'number'
              ? ((wh as Record<string, number>).endHour as number)
              : fallback.workHours.endHour,
        }
      : fallback.workHours
  const cap = typeof r.frequencyCapPerHour === 'number' && r.frequencyCapPerHour > 0
    ? Math.min(20, Math.floor(r.frequencyCapPerHour))
    : fallback.frequencyCapPerHour
  const mutedRaw = Array.isArray(r.mutedCategories) ? r.mutedCategories : []
  const mutedCategories = mutedRaw.filter(
    (c): c is AssistantCategory => typeof c === 'string' && VALID_CATEGORIES.has(c as AssistantCategory),
  )
  const customRaw =
    r.customHints && typeof r.customHints === 'object'
      ? (r.customHints as Record<string, unknown>)
      : {}
  const customHints: Partial<Record<AssistantCategory, string>> = {}
  for (const [k, v] of Object.entries(customRaw)) {
    if (VALID_CATEGORIES.has(k as AssistantCategory) && typeof v === 'string') {
      customHints[k as AssistantCategory] = v
    }
  }
  return { enabled, workHours, frequencyCapPerHour: cap, mutedCategories, customHints }
}

/** 读取偏好 —— 无值时返回默认。 */
export async function loadAssistantPrefs(): Promise<AssistantPrefs> {
  const all = await settingsRepo.getAll()
  return coercePrefs(all[ASSISTANT_PREFS_KEY])
}

/** 写偏好 —— 渲染端通过 IPC 触发；写入前 coerce 防脏数据。 */
export async function saveAssistantPrefs(prefs: AssistantPrefs): Promise<AssistantPrefs> {
  const safe = coercePrefs(prefs)
  await settingsRepo.set(ASSISTANT_PREFS_KEY, safe)
  return safe
}

/** daemon 内部用：在偏好变更时拿到新 prefs 并广播（暂未用到广播，留接口）。 */
export type AssistantPrefsChangeListener = (prefs: AssistantPrefs) => void

const listeners = new Set<AssistantPrefsChangeListener>()

export function onAssistantPrefsChange(l: AssistantPrefsChangeListener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function emitAssistantPrefsChange(prefs: AssistantPrefs): void {
  for (const l of listeners) l(prefs)
}
