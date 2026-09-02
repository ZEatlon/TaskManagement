/**
 * 树形结构展开状态
 *
 * - 用于文件夹（folder）展开 / 折叠。Folder 是不是展开由 user 决定，
 *   系统不应自动展开。刷新后通过 localStorage 恢复。
 * - key 形如：
 *     `folder:<id>` —— 普通文件夹展开
 *     `tag:<name>` —— 标签 chip 选择（虽然当前版本 chip 选择器是 toggle 形式不需要持久化）
 *     未来加更多可展开树节点时复用同一 set。
 *
 * 用法：
 *   - 命令式（事件处理器内）：`useTreeExpansionStore.getState().isExpanded(key)`
 *   - 响应式（组件订阅）：`useTreeExpanded(key)` ← 走 Zustand 订阅，展开状态变化触发重渲染
 *
 * 注意：旧的 `useTreeExpansionStore((s) => s.isExpanded)` 模式返回稳定的函数引用，
 * Zustand 不会在 expanded 集合变化时通知 —— 必须用 `useTreeExpanded(key)` 才能正确响应。
 */
import { create } from 'zustand'

const STORAGE_KEY = 'tp.treeExpansion.v1'

interface TreeExpansionState {
  expanded: Set<string>
  isExpanded: (key: string) => boolean
  toggle: (key: string) => void
  set: (key: string, expanded: boolean) => void
}

function loadInitial(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.filter((x) => typeof x === 'string'))
    return new Set()
  } catch {
    return new Set()
  }
}

function persist(set: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {
    /* 配额满 / 隐私模式 → 静默忽略 */
  }
}

export const useTreeExpansionStore = create<TreeExpansionState>((set, get) => ({
  expanded: loadInitial(),

  isExpanded(key) {
    return get().expanded.has(key)
  },

  toggle(key) {
    const cur = get().expanded
    const next = new Set(cur)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    persist(next)
    set({ expanded: next })
  },

  set(key, expanded) {
    const cur = get().expanded
    const next = new Set(cur)
    if (expanded) {
      next.add(key)
    } else {
      next.delete(key)
    }
    persist(next)
    set({ expanded: next })
  },
}))

/**
 * 响应式订阅：给定 key，返回该 key 是否展开，状态变化触发组件重渲染。
 * 走 Zustand 订阅器，selector 返回 boolean：Zustand 用 Object.is 比较，
 * 展开状态变化时该 boolean 翻转 → 组件重渲染。
 *
 * 性能要点：每次渲染都新建 Set 对象，但 selector 只读取 `s.expanded.has(key)`，
 * 输出 boolean 是原始类型 → Object.is 比较无开销。展开集合有 N 个 key 时，
 * 单 key 切换只会让订阅了该 key 的组件重渲染，不会触发其他 key 的订阅者。
 */
export function useTreeExpanded(key: string): boolean {
  return useTreeExpansionStore((s) => s.expanded.has(key))
}