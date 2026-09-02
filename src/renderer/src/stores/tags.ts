/**
 * 标签状态管理
 */
import { create } from 'zustand'
import type { Tag } from '@shared/types'
import { tagsApi } from '../lib/ipc'

interface TagsState {
  tags: Tag[]
  loading: boolean
  error: string | null
  fetch: () => Promise<void>
  create: (input: { name: string; parentId?: string | null; color?: string | null }) => Promise<Tag>
  update: (id: string, patch: Partial<Tag>) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useTagsStore = create<TagsState>((set, get) => ({
  tags: [],
  loading: false,
  error: null,

  async fetch() {
    set({ loading: true, error: null })
    try {
      const tags = await tagsApi.list()
      set({ tags, loading: false })
    } catch (err) {
      // R6S-4：之前吞错没有任何信号，UI 永远以为 tag list 是空的。
      // 现在记到 error 字段，调用方可以选择展示或重试。
      set({ loading: false, error: (err as Error).message })
    }
  },

  async create(input) {
    const tag = await tagsApi.create(input)
    set({ tags: [...get().tags, tag] })
    return tag
  },

  async update(id, patch) {
    const updated = await tagsApi.update(id, patch)
    if (updated) {
      set({
        tags: get().tags.map((t) => (t.id === id ? updated : t)),
      })
    }
  },

  async remove(id) {
    await tagsApi.delete(id)
    set({
      tags: get().tags.filter((t) => t.id !== id),
    })
  },
}))

/** 嵌套结构构造 */
export interface TagNode extends Tag {
  children: TagNode[]
}

export function buildTagTree(tags: Tag[]): TagNode[] {
  const map = new Map<string, TagNode>()
  for (const t of tags) {
    map.set(t.id, { ...t, children: [] })
  }
  const roots: TagNode[] = []
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}