/**
 * 自动保存 hook（模块 7）
 *
 * 行为：
 *   - 监听"内容变化"事件（通过 scheduleSave 触发）
 *   - debounce 到指定间隔后把内容写入 IndexedDB 草稿
 *   - 暴露 pendingDraft 状态（是否有未保存草稿）
 *   - 提供 restoreDraft / clearDraft / hasDraft 辅助
 *
 * 用法：
 *   const { scheduleSave, restoreDraft, clearDraft, hasDraft, pendingDraft } = useAutosave({
 *     notePath: currentPath,
 *     kind: 'markdown',
 *     debounceMs: 1000,
 *     onSaved: (entry) => { ... },
 *   })
 *
 *   useEffect(() => { scheduleSave(content) }, [content])
 *
 * 当内容已经持久化到磁盘（成功保存 note）后，调用 clearDraft()。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  draftIdFor,
  loadDraft,
  saveDraft,
  deleteDraft,
  type DraftEntry,
} from './draftStore'

export interface UseAutosaveOptions {
  /** 笔记路径；null = 新笔记草稿 */
  notePath: string | null
  /** 内容类型 */
  kind: 'markdown' | 'html' | 'json'
  /** debounce 间隔（毫秒），默认 1000 */
  debounceMs?: number
  /** 保存成功回调 */
  onSaved?: (entry: DraftEntry) => void
  /** 跳过自动保存（例如正在从磁盘读入内容时） */
  skip?: boolean
}

export interface UseAutosaveResult {
  /** 调度一次保存（debounced） */
  scheduleSave: (content: string) => void
  /** 立即刷新（不等待 debounce） */
  flush: (content: string) => Promise<void>
  /** 加载草稿（如果存在） */
  restoreDraft: () => Promise<DraftEntry | null>
  /** 删除草稿（保存到磁盘成功后调用） */
  clearDraft: () => Promise<void>
  /** 是否有草稿（异步查询，state 中缓存） */
  hasDraft: boolean
  /** 草稿信息（state 中缓存） */
  pendingDraft: DraftEntry | null
  /** 当前 draftId */
  draftId: string
  /** 重新检查草稿 */
  refresh: () => Promise<void>
}

export function useAutosave(opts: UseAutosaveOptions): UseAutosaveResult {
  const { notePath, kind, debounceMs = 1000, onSaved, skip = false } = opts
  const draftId = draftIdFor(notePath)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestContentRef = useRef<string>('')
  const skipRef = useRef(skip)
  skipRef.current = skip
  // H17 修复：writeNow 串行化的 in-flight 句柄。
  const writeInFlightRef = useRef<Promise<void>>(Promise.resolve())

  const [pendingDraft, setPendingDraft] = useState<DraftEntry | null>(null)

  // 切换 notePath 时重新查询
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const d = await loadDraft(draftId)
      if (!cancelled) setPendingDraft(d)
    })()
    return () => {
      cancelled = true
    }
  }, [draftId])

  // 销毁时清掉 timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const refresh = useCallback(async () => {
    const d = await loadDraft(draftId)
    setPendingDraft(d)
  }, [draftId])

  const writeNow = useCallback(
    async (content: string) => {
      if (skipRef.current) return
      const entry: DraftEntry = {
        id: draftId,
        content,
        updatedAt: new Date().toISOString(),
        notePath,
        kind,
      }
      // H17 修复 (high data-integrity)：原版没有写互斥 —— debounce timer
      // 触发 writeNow(A) 还没 await saveDraft 完成时，flush(B)（Ctrl+S
      // 或路由切换）并发调 writeNow(B) 并 await saveDraft(B) 先返回，
      // setPendingDraft 两次更新顺序变成 A → B（最新），看起来没问题；
      // 但 saveDraft 内部 IPC 是带顺序的（main process 序列化），A 落
      // B 之后会把 A 的 older content 覆盖 B 的 newer content，磁盘上
      // 留下旧版本。
      // 修复：用 writeInFlight 串行化所有 writeNow 调用，每次进入时
      // await 之前的 in-flight，再把自己的写入串到队列末尾。最新
      // content 总是最后写，保证落盘顺序 = 调用顺序。
      const prev = writeInFlightRef.current
      let release: () => void = () => {}
      writeInFlightRef.current = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await prev
        if (skipRef.current) return
        const ok = await saveDraft(entry)
        if (ok) {
          setPendingDraft(entry)
          onSaved?.(entry)
        }
      } finally {
        release()
      }
    },
    [draftId, notePath, kind, onSaved],
  )

  const flush = useCallback(
    async (content: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      latestContentRef.current = content
      await writeNow(content)
    },
    [writeNow],
  )

  const scheduleSave = useCallback(
    (content: string) => {
      latestContentRef.current = content
      if (skipRef.current) return
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        void writeNow(latestContentRef.current)
      }, debounceMs)
    },
    [debounceMs, writeNow],
  )

  const restoreDraft = useCallback(async () => {
    const d = await loadDraft(draftId)
    setPendingDraft(d)
    return d
  }, [draftId])

  const clearDraft = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await deleteDraft(draftId)
    setPendingDraft(null)
  }, [draftId])

  return {
    scheduleSave,
    flush,
    restoreDraft,
    clearDraft,
    hasDraft: pendingDraft !== null,
    pendingDraft,
    draftId,
    refresh,
  }
}
