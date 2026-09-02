/**
 * 共享 focus trap hook：Tab/Shift+Tab 焦点被关在 root 容器内，
 * 防止 aria-modal 弹窗被键盘 tab 出到背景 UI。
 *
 * R20 修复 (high a11y)：原 ConflictDialog / DashboardEditorModal 都声明
 * aria-modal=true 但没装 Tab 拦截 → 键盘用户 Tab 穿过弹窗落到背景 notes
 * 列表 / chat 输入框，触发误操作。CreateNoteConfirmDialog / CommandBar
 * 各自实现了一遍 focus trap 逻辑，复制粘贴导致 R17 修复后的回归（弹窗 Esc
 * 误关其它 modal 等）难以统一修复。统一收敛到这里。
 *
 * R22 修复 (critical a11y)：原实现每个 modal 都把 Tab handler 挂到 window，
 * 多个 modal 同时激活时（例如 CommandBar 开着、AI 返回 confirm_create 又
 * 弹了 CreateNoteConfirmDialog），所有 handler 都对同一 Tab 事件生效，
 * 各自「看 focus 不在自己 root 内就抢回 first focusable」形成键盘陷阱 —
 * 用户永远停在最顶层 modal 的第一个按钮上，无法 Tab 到 modal 内部其他
 * 控件（放弃 / 让 AI 再调整），同时违反 WCAG 2.1.2 No Keyboard Trap (A)。
 *
 * 修复：用模块级 stack 管理当前激活的 root ref。Tab handler 只在
 * `stack[stack.length - 1] === root` 时生效 —— 顶层 modal 独占 trap，
 * 底层 modal 即使还挂着也主动让位。push 在 active=true 时执行，cleanup
 * 时 pop；多次 push 同一 ref 安全（不会重复入栈）。
 *
 * 用法：
 *   const ref = useRef<HTMLDivElement>(null)
 *   useFocusTrap(ref, open)
 *   <div ref={ref} role="dialog" aria-modal="true">…</div>
 */
import { useEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 当前激活的 focus trap root 栈；最后一个元素是顶层（独占 trap）。 */
const trapStack: HTMLElement[] = []

/** 把 root 推到栈顶（若已在栈中则先移除，避免重复） */
function pushRoot(root: HTMLElement): void {
  const idx = trapStack.indexOf(root)
  if (idx >= 0) trapStack.splice(idx, 1)
  trapStack.push(root)
}

/** 从栈中移除 root（无论其在哪个位置） */
function popRoot(root: HTMLElement): void {
  const idx = trapStack.indexOf(root)
  if (idx >= 0) trapStack.splice(idx, 1)
}

/** 当前是否是顶层 trap root */
function isTopTrap(root: HTMLElement): boolean {
  return trapStack[trapStack.length - 1] === root
}

/**
 * 是否有 modal 在最顶层激活。供全局快捷键 hook（如 useStickyShortcuts）
 * 在打开 dialog / CommandBar 时跳过单字母快捷键，避免焦点落在 modal 内的
 * 普通按钮上时按 `t`/`j`/`k`/`e`/`1`-`4` 仍触发背后的 timeline 操作
 * （用户视角：键盘被「穿透」到背后的 page）。
 *
 * trapStack 与 useFocusTrap 共用同一份栈：只要有 trap 在栈顶（任意 modal）
 * 就视为 modal 模式开启。escape hatch：trapStack 是模块私有，加一层
 * 「即使栈空但 DOM 里有 [role="dialog"][aria-modal="true"]」的兜底，防止
 * 没用 useFocusTrap 的 dialog 漏过。
 */
export function isModalLayerActive(): boolean {
  if (trapStack.length > 0) return true
  if (typeof document === 'undefined') return false
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (!root) return
    pushRoot(root)

    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return
      // 关键：只有顶层 trap 拦截 Tab；底层 modal 即使还挂着也主动让位，
      // 防止多个 trap 同时把焦点抢回各自 first focusable 形成键盘陷阱。
      if (!isTopTrap(root!)) return
      const focusables = Array.from(
        root!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusables.length === 0) {
        // 没有可聚焦元素 —— 阻止 tab 把焦点送出 modal（落到 body）
        e.preventDefault()
        return
      }
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !root!.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last || !root!.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      popRoot(root)
    }
  }, [active, ref])
}
