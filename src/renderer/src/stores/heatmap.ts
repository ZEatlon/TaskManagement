/**
 * 热力图状态（Zustand）
 *
 * 缓存每日任务完成数（YYYY-MM-DD → count），并提供 fetch(start, end) 拉取区间。
 *
 * 注意：之前的 noteData / pomodoroData / fetchNoteEvents / fetchPomodoros /
 * selectMergedData 已删除。理由：
 *   - W3-A 重建后的 Heatmap.tsx 不再使用这些字段 —— note 活跃度改为直接
 *     走 `window.api.invoke('note-event:daily', ...)`（带 200ms debounce +
 *     子集检测），绕开 store 中转。pomodoro 数据源已下线（热力图目前只
 *     显示「任务完成」+「笔记活跃度」两层）。
 *   - 旧版 store 切片 + fetchNoteEvents / fetchPomodoros 的设计意图
 *     （W2-C④「齿轮里切数据源」）在 W3-A 重建后不再有调用方，留着会误导
 *     后续读代码的人以为「pomodoro 数据源被某处用到只是我还没找到」。
 *   - 旧 `selectMergedData` 已 @deprecated + 明确警告「禁止作为
 *     useHeatmapStore selector」，与现在的零调用方一起删除更干净。
 */
import { create } from 'zustand'
import { completionsApi } from '../lib/ipc'

interface HeatmapState {
  /** YYYY-MM-DD → count（任务完成） */
  data: Record<string, number>
  /** 是否正在加载 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 最后加载的时间戳 */
  lastLoadedAt: number | null

  /** 拉取任务完成数（覆盖式） */
  fetch: (start: string, end: string) => Promise<void>
  /** 清空缓存 */
  reset: () => void
}

/** R6C-3 + R15 修复 (high)：seq 用于丢弃过期响应，避免切换数据源或快速
 * scrub 时旧请求覆盖新数据。fetch 是单调用方，单 seq 足够。 */
let completionsSeq = 0

export const useHeatmapStore = create<HeatmapState>((set) => ({
  data: {},
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

  reset() {
    set({ data: {}, loading: false, error: null, lastLoadedAt: null })
  },
}))
