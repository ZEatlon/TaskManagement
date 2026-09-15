/**
 * 便签时间线键盘快捷键
 *
 * Round 5 重构：每个快捷键改用 SHORTCUT_DEFS 注册表 + useShortcut hook。
 * - 默认绑定见 lib/shortcuts.ts SHORTCUT_DEFS
 * - 用户在「设置 → 快捷键」修改后，hook 自动读取 override
 * - 与 useFocusTrap.isModalLayerActive() 集成：modal 打开时仅允许 mod 组合穿透
 *
 * 用法：useStickyShortcuts({ onNew, onSearch, onJumpToday, onScrollDay, onSetPriority,
 *                            onArchiveFocused, onDuplicateFocused, focusedId })
 *
 * 所有 handler 可选；不传则跳过对应快捷键。
 *
 * 设计要点（保持原 useStickyShortcuts 行为）：
 *   - 输入焦点保护：单字母快捷键在 input / textarea 内放行（hook 内部默认）
 *   - mod+N 等修饰键组合：即便在输入内也允许（allowInInputs: true）
 *   - Esc 总是放行（由具体 component 处理，不在本 hook）
 */
import { useShortcut, useShortcutBinding } from '../../lib/useShortcut'
import { findShortcutDef } from '../../lib/shortcuts'
import type { Priority } from '@shared/types'

export interface StickyShortcutHandlers {
  /** mod+n —— 在今日页聚焦标题输入框（保留原 /today 'n' 行为） */
  onNewLocal?: () => void
  /** n —— 任意页面触发全局 QuickCapture 浮层 */
  onNewGlobal?: () => void
  onSearch?: () => void
  onJumpToday?: () => void
  /** delta = +1 表下一天；-1 表上一天 */
  onScrollDay?: (delta: 1 | -1) => void
  /** 当前焦点 sticky 的 ID（按 1/2/3/4 时使用） */
  focusedId?: string | null
  onSetPriority?: (id: string, priority: Priority) => void
  onArchiveFocused?: (id: string) => void
  onDuplicateFocused?: (id: string) => void
}

const PRIORITY_KEYS: Record<string, Priority> = {
  '1': 'p0',
  '2': 'p1',
  '3': 'p2',
  '4': 'p3',
}

export function useStickyShortcuts(h: StickyShortcutHandlers): void {
  // 必须无条件调用所有 hook（rules-of-hooks）
  //
  // R-FIX-3：之前 `findShortcutDef(...)!` 在 SHORTCUT_DEFS 条目被删 /
  // 改名（例如 `'sticky.newGlobal'` 重命名为 `'sticky.quickCapture'`）
  // 时会 throw TypeError，导致整个 useStickyShortcuts 调用方组件
  // unmount —— 用户失去整个 sticky 页面，不只是快捷键。改为不报错：
  // 缺失时 useShortcut 直接 no-op（见 lib/useShortcut.ts），并在 dev
  // 控制台 warn 一次，方便定位 refactor 后没改全 call site 的情况。
  const defStickyNew = findShortcutDef('sticky.new')
  const defStickyNewGlobal = findShortcutDef('sticky.newGlobal')
  const defStickyDup = findShortcutDef('sticky.duplicate')
  if (import.meta.env.DEV) {
    for (const [id, def] of [
      ['sticky.new', defStickyNew],
      ['sticky.newGlobal', defStickyNewGlobal],
      ['sticky.duplicate', defStickyDup],
    ] as const) {
      if (!def) {
        // eslint-disable-next-line no-console
        console.warn(
          `[useStickyShortcuts] shortcut "${id}" missing from SHORTCUT_DEFS — hook degraded to no-op for this binding. Update lib/shortcuts.ts or this call site.`,
        )
      }
    }
  }

  // mod+N：新建便签（即便在 input 内也允许 → allowInInputs: true）
  useShortcut(defStickyNew, () => h.onNewLocal?.(), { allowInInputs: true })

  // n：全局唤起 QuickCapture 浮层（不需 allowInInputs：hook 默认会在
  // input/textarea 内忽略；浮层本身也是 input 也要抢焦点，所以走默认即可）
  useShortcut(defStickyNewGlobal, () => h.onNewGlobal?.())

  // sticky.search 的 "/" 走单字母绑定（focusedId 不强制）
  useShortcutBinding('/', () => h.onSearch?.())

  // sticky.today 't'
  useShortcutBinding('t', () => h.onJumpToday?.())

  // sticky.next-day 'j' / sticky.prev-day 'k'
  useShortcutBinding('j', () => h.onScrollDay?.(1))
  useShortcutBinding('k', () => h.onScrollDay?.(-1))

  // sticky.archive 'e'（需要 focusedId；handler 内做空值检查）
  useShortcutBinding('e', () => {
    if (h.focusedId) h.onArchiveFocused?.(h.focusedId)
  })

  // mod+shift+d：复制便签到今日
  useShortcut(defStickyDup, () => {
    if (h.focusedId) h.onDuplicateFocused?.(h.focusedId)
  }, { allowInInputs: true })

  // 1/2/3/4：设置焦点 sticky 的优先级（动态 key，不进 SHORTCUT_DEFS）
  useShortcutBinding('1', () => {
    if (h.focusedId) h.onSetPriority?.(h.focusedId, PRIORITY_KEYS['1']!)
  })
  useShortcutBinding('2', () => {
    if (h.focusedId) h.onSetPriority?.(h.focusedId, PRIORITY_KEYS['2']!)
  })
  useShortcutBinding('3', () => {
    if (h.focusedId) h.onSetPriority?.(h.focusedId, PRIORITY_KEYS['3']!)
  })
  useShortcutBinding('4', () => {
    if (h.focusedId) h.onSetPriority?.(h.focusedId, PRIORITY_KEYS['4']!)
  })
}