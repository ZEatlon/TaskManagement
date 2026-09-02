/**
 * 热力图状态（Zustand）
 *
 * 缓存每日完成数（任务完成 + 笔记事件 + 番茄专注，可选叠加）。
 * 提供 fetch(start, end) / fetchNoteEvents() / fetchPomodoros() 方法拉取区间数据并合并到本地缓存。
 *
 * 默认缓存键为任务完成数；可叠加笔记事件 / 番茄专注。
 */
import { create } from 'zustand'
import { completionsApi, noteEventsApi, pomodorosDailyApi } from '../lib/ipc'

interface HeatmapState {
  /** YYYY-MM-DD → count（任务完成） */
  data: Record<string, number>
  /** YYYY-MM-DD → count（笔记事件，可选） */
  noteData: Record<string, number>
  /** YYYY-MM-DD → count（番茄专注完成数 = floor(minutes / 25)，可选） */
  pomodoroData: Record<string, number>
  /** 是否正在加载 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 最后加载的时间戳 */
  lastLoadedAt: number | null

  /** 拉取任务完成数（覆盖式） */
  fetch: (start: string, end: string) => Promise<void>
  /** 拉取笔记事件数（覆盖式） */
  fetchNoteEvents: (start: string, end: string) => Promise<void>
  /** 拉取番茄专注数（覆盖式） */
  fetchPomodoros: (start: string, end: string) => Promise<void>
  /** 清空缓存 */
  reset: () => void
}

/** R6C-3 + R15 修复 (high)：每路 fetcher 独立 seq。共享 seq 会导致切换
 * 数据源（fetch→fetchPomodoros）时，旧 fetch 的响应被新 seq 判定为陈旧丢弃，
 * 热力图维持空数据直到下次用户动作。三路独立 seq 互不干扰。 */
let completionsSeq = 0
let noteEventsSeq = 0
let pomodorosSeq = 0

export const useHeatmapStore = create<HeatmapState>((set) => ({
  data: {},
  noteData: {},
  pomodoroData: {},
  loading: false,
  error: null,
  lastLoadedAt: null,

  async fetch(start, end) {
    const seq = ++completionsSeq
    set({ loading: true, error: null })
    try {
      const data = await completionsApi.daily(start, end)
      if (seq !== completionsSeq) return
      set({ data, loading: false, lastLoadedAt: Date.now() })
    } catch (err) {
      if (seq !== completionsSeq) return
      set({ error: (err as Error).message, loading: false })
    }
  },

  async fetchNoteEvents(start, end) {
    const seq = ++noteEventsSeq
    try {
      const noteData = await noteEventsApi.daily(start, end)
      if (seq !== noteEventsSeq) return
      set({ noteData })
    } catch (err) {
      if (seq !== noteEventsSeq) return
      console.error('[heatmap] fetchNoteEvents failed', err)
    }
  },

  async fetchPomodoros(start, end) {
    const seq = ++pomodorosSeq
    try {
      const minutes = await pomodorosDailyApi.daily(start, end)
      if (seq !== pomodorosSeq) return
      // 主进程返回分钟数；折算成"完成的番茄数"（floor(minutes/25)，最少 1）以便复用现有 level 阈值
      const pomodoroData: Record<string, number> = {}
      for (const [date, m] of Object.entries(minutes)) {
        pomodoroData[date] = Math.max(1, Math.floor(m / 25))
      }
      set({ pomodoroData })
    } catch (err) {
      if (seq !== pomodorosSeq) return
      console.error('[heatmap] fetchPomodoros failed', err)
    }
  },

  reset() {
    set({ data: {}, noteData: {}, pomodoroData: {}, loading: false, error: null, lastLoadedAt: null })
  },
}))

/**
 * 派生选择器：把任务完成数、笔记事件数、番茄专注数合并
 *
 * R16 修复 (low)：@deprecated —— 每次调用返回全新对象，作为 Zustand selector
 * 会触发无限重渲染（默认 Object.is 永远 false）。当前唯一消费者
 *  HeatmapWidget 已在组件内通过 useMemo 自管合并。本导出保留仅为
 *  调试 / 单元测试用，但禁止再作为 useHeatmapStore(selectMergedData) 使用。
 */
export function selectMergedData(state: HeatmapState): Record<string, number> {
  const merged: Record<string, number> = { ...state.data }
  for (const [date, n] of Object.entries(state.noteData)) {
    merged[date] = (merged[date] ?? 0) + n
  }
  for (const [date, n] of Object.entries(state.pomodoroData)) {
    merged[date] = (merged[date] ?? 0) + n
  }
  return merged
}