/**
 * W2-A③ NoteFoldersSidebar 拆分 —— 自定义 hooks
 *
 * 把 reloadTreeNotes 抽到 useNotesByFolder：
 *   - 单 IPC 调用 listByFolders 拉所有 folder 的笔记
 *   - 副作用：folders 列表变化时自动重拉（depth: 1）
 *   - 返回 Map<folderId, NoteMeta[]>，key = null 表示未分类
 *
 * reloadTreeNotes 原本是 NoteFoldersSidebar 内联函数，依赖 `folders` 引用；
 * 现在 hook 化后闭包能正确捕获最新 folders（每轮 effect 重新跑）。
 */
import { useEffect, useState } from 'react'
import type { NoteMeta } from '@shared/types'
import { noteFoldersApi } from '../../../lib/ipc'

/** key = folderId；null = 未分类 */
export type NotesByFolderMap = Map<string | null, NoteMeta[]>

/**
 * 拉所有 folder 下的笔记摘要（默认 archived=false + 每 folder 最多 10 条）。
 *
 * 失败时返回空 Map —— 调用方继续渲染，UI 不需要为单次 IPC 失败抛错。
 */
export function useNotesByFolder(folders: Array<{ id: string }>): NotesByFolderMap {
  const [notesByFolder, setNotesByFolder] = useState<NotesByFolderMap>(new Map())

  useEffect(() => {
    let cancelled = false
    async function reload() {
      const m: NotesByFolderMap = new Map()
      try {
        // R-findByFolders (low perf)：原版 N 次 listByFolder = N 轮 IPC +
        // N 次 SELECT * WHERE folder_id = ?。用户有 20 个文件夹时 sidebar
        // 要 21 轮 round-trip 才响应（每轮 1-3ms ≈ 20-60ms）。批量接口
        // listByFolders 单 IPC + 单 SQL（folder_id IN (...) + folder_id IS NULL
        // 复合谓词），把 round-trip 压到 1 次。
        const folderIds: Array<string | null> = [null, ...folders.map((f) => f.id)]
        const grouped = await noteFoldersApi.listByFolders(folderIds, {
          archived: false,
          limit: 10,
        })
        if (cancelled) return
        // IPC 返回 Record<string, NoteMeta[]>（key 'null' 表示未分类）
        for (const id of folderIds) {
          const key = id === null ? 'null' : id
          m.set(id, grouped[key] ?? [])
        }
      } catch {
        // 失败：保留空 map，UI 仍然显示文件夹
      }
      if (!cancelled) setNotesByFolder(m)
    }
    void reload()
    return () => {
      cancelled = true
    }
  }, [folders])

  return notesByFolder
}

/** 监听 window-level dragend，确保 ESC / 拖到无效位置 / drop 失败时
 *  能立刻清掉 hover 状态。dragend 只在 source 元素触发，因此放在 source 的
 *  父级 (window) 上监听最稳。 */
export function useWindowDragEndClear(setHoverDrop: (id: undefined) => void): void {
  useEffect(() => {
    function onWindowDragEnd() {
      setHoverDrop(undefined)
    }
    window.addEventListener('dragend', onWindowDragEnd)
    return () => window.removeEventListener('dragend', onWindowDragEnd)
  }, [setHoverDrop])
}
