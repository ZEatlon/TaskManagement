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
 *
 * R-FIX-3 重构：useShortcut / useShortcutBinding 共享同一份监听逻辑，
 * 区别仅在 binding 解析（SHORTCUT_DEFS[id] vs 直接传 binding）。
 * 抽出 useShortcutInternal 统一挂 window keydown，新增模态闸门 /
 * 输入焦点保护等全局选项时只改一处。
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

/**
 * 检测事件目标是否是可编辑元素（input / textarea / select / contenteditable）。
 *
 * 公开为导出符号：QuickCaptureOverlay 等其他需要"输入框中不抢快捷键"判断的地方
 * 复用同一份实现，避免两份拷贝各自漂移（e.g. 一边加入 aria-readonly 另一边漏掉）。
 */
export function isEditableTarget(t: EventTarget | null): boolean {
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

/**
 * 内部 hook：挂 window keydown，命中 binding 后穿过模态闸门 / when 条件
 * / 输入焦点保护，触发 handler。
 *
 * `binding` 为 null 时不挂监听（用于 useShortcut 在 def 缺失时降级）。
 * `bindingKey` 是 useEffect 依赖键 —— useShortcutBinding 传 binding 字符串本身，
 * useShortcut 传 `${def.id}|${def.defaultBinding}` 让 store 覆盖改动时重新解析。
 */
function useShortcutInternal(
  binding: string | null,
  bindingKey: string,
  handler: (e: KeyboardEvent) => void,
  opts: UseShortcutOptions,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!binding) return
    const onKey = (e: KeyboardEvent) => {
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
  }, [binding, bindingKey, opts.allowInInputs])
}

/**
 * 通过 ShortcutDef 注册快捷键 —— 自动读 settings.shortcutOverrides 覆盖。
 *
 * R-FIX-3：def 缺失时（SHORTCUT_DEFS 条目被删 / 改名）不挂监听，
 * 调用方无需再写 `findShortcutDef(...)!` 的非空断言（之前非空断言失败
 * 会 throw 挂掉整页）。允许 undefined 让组件安全降级。
 */
export function useShortcut(
  def: ShortcutDef | undefined,
  handler: (e: KeyboardEvent) => void,
  opts: UseShortcutOptions = {},
): void {
  // 用 bindingKey 触发依赖变更；store 覆盖改动时（def.id 改变
  // 或 defaultBinding 改了）都会重新解析。store 内的 override 本身
  // 在 onKey 闭包里通过 useSettingsStore.getState() 读取，避免每次
  // override 改动都重挂监听。
  const binding = useShortcutBinding_resolve(def)
  // 注：store override 读取放在 onKey 内部；bindingKey 用 def 静态字段即可。
  useShortcutInternal(
    binding,
    def ? `${def.id}|${def.defaultBinding}` : 'none',
    handler,
    opts,
  )
}

/**
 * 直接传 binding 字符串（不查 SHORTCUT_DEFS）的便利 hook。
 */
export function useShortcutBinding(
  binding: string,
  handler: (e: KeyboardEvent) => void,
  opts: UseShortcutOptions = {},
): void {
  useShortcutInternal(binding, binding, handler, opts)
}

/**
 * 解析 useShortcut 的当前生效 binding（含用户覆盖）。
 * 拆出来仅为了让 useShortcut 体内逻辑读起来是「解析 → 挂监听」两步。
 */
function useShortcutBinding_resolve(def: ShortcutDef | undefined): string | null {
  if (!def) return null
  // 在渲染阶段读一次当前 override 作为初始值；后续 override 改动
  // 通过 onKey 内 useSettingsStore.getState() 即时响应（不重挂监听），
  // 避免 override 抖动导致监听器反复 unmount/mount。
  const overrides = useSettingsStore.getState().shortcutOverrides
  return overrides?.[def.id] || def.defaultBinding
}
