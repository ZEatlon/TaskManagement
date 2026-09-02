/**
 * 通用快捷键 hook —— 替代每个组件手写 keydown 监听。
 *
 * 用法：
 *   useShortcut(SHORTCUT_DEFS[0]!, (e) => { ... })
 *
 * 特性：
 * - 自动从 useSettingsStore.shortcutOverrides 读取用户覆盖，无覆盖时用 defaultBinding
 * - 与 useFocusTrap.isModalLayerActive() 集成：modal 打开时只允许 mod 快捷键
 * - allowInInputs=true 时即使焦点在 input/textarea 也会触发（用于新建便签等）
 * - handler 用 ref 锁定，避免每次 render 重新挂载监听器
 */

import { useEffect, useRef } from 'react'
import { matchShortcut, type ShortcutDef } from './shortcuts'
import { useSettingsStore } from '../stores/settings'
import { isModalLayerActive } from './useFocusTrap'

export interface UseShortcutOptions {
  /**
   * 条件闭包；返回 false 时本次按键跳过（不阻止默认行为）。
   * 默认总是 true。
   */
  when?: () => boolean
  /**
   * 焦点在 input / textarea / contenteditable 时是否仍然触发。
   * - false（默认）：跳过（避免吞掉用户输入）
   * - true：触发（用于「mod+N 新建便签」这种全局行为）
   */
  allowInInputs?: boolean
  /**
   * 触发时是否 preventDefault（默认 true，避免触发浏览器默认行为如打开查找栏）。
   */
  preventDefault?: boolean
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  return false
}

/**
 * 把 KeyboardEvent 中的 mod 快捷键判别为「即使 modal 开着也要响应」。
 * mod 修饰键类快捷键（带 ctrl / meta）始终穿透 modal（浏览器 / Electron
 * 默认就会拦下 mod 组合，让普通 modal 焦点层不能吞掉它）。
 */
function hasModKey(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey
}

export function useShortcut(
  def: ShortcutDef,
  handler: (e: KeyboardEvent) => void,
  opts: UseShortcutOptions = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  // 从 settings store 取当前生效的 binding；store 未加载时用 default
  // 用 subscribe 而不是 getSnapshot，避免每次 render 都重新挂监听。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const overrides = useSettingsStore.getState().shortcutOverrides
      const binding = overrides?.[def.id] || def.defaultBinding
      if (!matchShortcut(e, binding)) return

      // modal 开启时：仅允许 mod 组合穿透（与原 useStickyShortcuts 行为对齐）
      const modalActive = isModalLayerActive()
      if (modalActive && !hasModKey(e)) return

      // 条件闭包
      if (opts.when && !opts.when()) return

      // 输入焦点保护
      if (!opts.allowInInputs && isEditableTarget(e.target)) return

      if (opts.preventDefault !== false) {
        e.preventDefault()
      }
      handlerRef.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, def.defaultBinding, opts.allowInInputs])
}

/** 直接传 binding 字符串（不查 SHORTCUT_DEFS）的便利 hook */
export function useShortcutBinding(
  binding: string,
  handler: (e: KeyboardEvent) => void,
  opts: UseShortcutOptions = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchShortcut(e, binding)) return
      const modalActive = isModalLayerActive()
      if (modalActive && !hasModKey(e)) return
      if (opts.when && !opts.when()) return
      if (!opts.allowInInputs && isEditableTarget(e.target)) return
      if (opts.preventDefault !== false) e.preventDefault()
      handlerRef.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, opts.allowInInputs])
}