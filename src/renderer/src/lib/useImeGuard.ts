/**
 * 共享 IME 守卫 —— 中文/日文/韩文输入法在 compositionend 之前按 Enter 时，
 * keyCode === 229 且 nativeEvent.isComposing === true。这两种信号要并联检查，
 * 因为不同浏览器/平台只触发其中一个（Chromium 系偏好 keyCode=229；
 * 较新 WebView 在某些 Android 键盘下只走 isComposing）。
 *
 * 用途：onKeyDown 处理器里在执行 "Enter = 提交" 之类的逻辑前先调一次，
 * 命中则直接 return。否则用户用拼音选词时按 Enter 会同时上屏 + 触发提交，
 * 体验非常糟糕。
 *
 * 此前该 4 行片段被复制粘贴到 InlineAIPicker / MessageInput / CommandBar /
 * StickyStepRow 共 4 处，且需要 `as unknown as { keyCode?: number }` 双断言
 * 绕过 React.KeyboardEvent 类型缺失 keyCode 的限制 —— 任何一处改造
 * （比如改用 KeyboardEvent.isComposing 的标准字段）都要在 4 处同步改，
 * 历史已出现漂移风险。统一收敛到本文件。
 *
 * 用法：
 *   const onKeyDown = (e) => {
 *     if (isImeComposing(e)) return
 *     ...
 *   }
 */
import { useCallback } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * 检测键盘事件是否处于 IME composition 中。
 *
 * 接受原生 KeyboardEvent（window/document 监听）或 React.KeyboardEvent
 * （元素 onKeyDown）—— 后者取 .nativeEvent。
 */
export function isImeComposing(
  e: KeyboardEvent | ReactKeyboardEvent
): boolean {
  // React.KeyboardEvent 上 .nativeEvent 是原生 KeyboardEvent
  const native = 'nativeEvent' in e ? (e.nativeEvent as KeyboardEvent) : e
  // 双断言：React 类型未声明 keyCode，但 DOM KeyboardEvent 在 Chromium/Edge
  // 仍会保留旧字段以兼容输入法组合态检测。
  const keyCode = (native as unknown as { keyCode?: number }).keyCode
  return native.isComposing || keyCode === 229
}

/**
 * 高阶 hook：返回一个已经包好 IME 守卫的 onKeyDown handler。
 *
 * 内部用 useCallback 稳定引用，避免每次 render 生成新函数导致依赖它的
 * useEffect / 子组件 memo 失效 —— 与 useShortcut.ts 的做法保持一致。
 *
 * 用法：
 *   const onKeyDown = useImeGuard((e) => {
 *     if (e.key === 'Enter' && !e.shiftKey) { ... }
 *   })
 */
export function useImeGuard<E extends KeyboardEvent | ReactKeyboardEvent>(
  handler: (e: E) => void
): (e: E) => void {
  return useCallback(
    (e: E) => {
      if (isImeComposing(e)) return
      handler(e)
    },
    [handler]
  )
}