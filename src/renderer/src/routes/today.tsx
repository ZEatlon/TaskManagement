/**
 * 今日页 —— 统一为便签时间线
 *
 * 历史上该页曾支持 sticky / tasks 双视图 + 任务子 tab。
 * 统一任务 → sticky 后，本页只保留 StickyTimeline。
 */
import { useCallback, useEffect } from 'react'
import { StickyTimeline, useStickyShortcuts } from '../components/sticky-notes'
import { useStickyNotesStore } from '../stores/stickyNotes'
import { dayKeyOf } from '../lib/date'

export function TodayRoute() {
  const fetchAround = useStickyNotesStore((s) => s.fetchAround)

  // R6C-1：原本在渲染体里直接调用 ensureLoaded()，导致 Zustand 订阅触发
  // StickyTimeline 重渲染时也连带重渲染本组件，每次重渲染都触发一次 fetchAround，
  // 累积成大量并发 IPC。改为 useEffect 一次性触发。
  const ensureLoaded = useCallback(() => {
    void fetchAround(dayKeyOf(new Date()), 7, 7)
  }, [fetchAround])
  useEffect(() => {
    ensureLoaded()
  }, [ensureLoaded])

  // P0-1：启用键盘快捷键（n = 新建便签；/ 或 Cmd/Ctrl+K = 聚焦时间线搜索）
  useStickyShortcuts({
    onNew: () => {
      const titleEl = document.querySelector<HTMLInputElement>(
        '.sticky-note-editor-title, .sticky-note-title',
      )
      titleEl?.focus()
    },
    onJumpToday: () => {
      const todayHeader = document.querySelector<HTMLElement>('.sticky-day-section.is-today')
      todayHeader?.scrollIntoView({ behavior: 'auto', block: 'start' })
    },
    onSearch: () => {
      // Bug B 修复：原本 onSearch 未传，导致 `/` 与 `Cmd/Ctrl+K` 在今日页为 no-op；
      // 现在聚焦到时间线顶部的搜索 input（已有的 client-side 过滤框）。
      const el = document.querySelector<HTMLInputElement>('.sticky-timeline-search input')
      el?.focus()
      el?.select()
    },
  })

  return (
    <div className="today-page">
      {/* Round 4 v2：删除 H1 + 副标题（page-header 已空） */}

      <div className="today-page-body sticky-view">
        <StickyTimeline />
      </div>
    </div>
  )
}

export default TodayRoute
