/**
 * 番茄钟计时面板（Dashboard 嵌入版 · v4）
 *
 * 布局重构（用户需求 v3 + v4）：
 *   - 时钟表**侧边放置**（左侧），不再垂直居顶
 *   - 时长 pill 与开始专注按钮**纵向堆叠**于时钟右侧（v4：专注按钮从右侧并列改为 duration 下方）
 *   - 跳过 / 终止 在右侧第二行（v4：删除了"专注第几轮"mode-pill）
 *   - 今日番茄紧凑列表 + 本月统计单行放在主区域下方
 *
 * 数据订阅：拆字段订阅 + useMemo 合成 displayState，避免每秒 tick 触发整树重渲染。
 *
 * Focus Mode：
 *   - 顶层根据 store.focusMode 渲染 <FocusModeOverlay>。
 *   - 退出时仅切 focusMode=false；不停番茄钟计时（用户可继续专注或暂停）。
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { PomodoroState } from '@shared/ipc/channels'
import { usePomodoroStore } from '../../stores/pomodoro'
import { useAiStore } from '../../stores/ai'
import { aiApi } from '../../lib/ipc'
import { TimerDisplay } from './TimerDisplay'
import { FocusControls } from './FocusControls'
import { TodayPomodoros } from './TodayPomodoros'
import { MonthStats } from './MonthStats'
import { PomodoroQuickSettings } from './PomodoroQuickSettings'
import { FocusModeOverlay } from './FocusModeOverlay'
import { InlineAIButton } from '../ai/InlineAIButton'
import { announce } from '../common/AriaAnnouncer'

// Props 曾经有过 `embedded?: boolean` 等字段；当前仓库内所有 caller
// 都不传任何 prop（dashboard.tsx / PomodoroPanel 全部走嵌入默认态），
// 因此 Props 当前为空。R32-Corr-1 (low dead-code) 把 size/stroke 硬编码
// 为唯一的真值 160/8，移除了三元的 "非嵌入" 死分支。
// 若将来需要全屏独立面板（如未来独立的 /focus 路由），再补 prop 字段，
// 并把下方 Props 改回 `interface Props {...}`；type-changed 即可让所有
// caller 显式确认。R36-Lint-1：保留 interface 但加 disable，
// 因为 `Record<string, never>` 会与 `{action:...}` 交叉类型冲突。
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Props {}

/** 当前面板唯一 size —— 历史 "非嵌入态" 320 直径从未被任何 caller 使用 */
const PANEL_SIZE = 160
const PANEL_STROKE = 8

const MemoTimerDisplay = memo(TimerDisplay)
const MemoFocusControls = memo(FocusControls)
const MemoTodayPomodoros = memo(TodayPomodoros)
const MemoMonthStats = memo(MonthStats)

export function PomodoroTimerPanel(_props: Props = {}) {
  // s.control.running 的订阅统一走下方"AI context + displayState"块的
  // runningV（行 80）—— 早期版本的 running subscription 已删除，避免同一
  // 字段双订阅让 store 通知跑两次 selector / 两次 shallow compare / 两次
  // potential re-render。
  const config = usePomodoroStore((s) => s.config)
  const loaded = usePomodoroStore((s) => s.loaded)

  const start = usePomodoroStore((s) => s.start)
  const pause = usePomodoroStore((s) => s.pause)
  const resume = usePomodoroStore((s) => s.resume)
  const skip = usePomodoroStore((s) => s.skip)
  const stop = usePomodoroStore((s) => s.stop)
  const updateConfig = usePomodoroStore((s) => s.updateConfig)
  const loadConfig = usePomodoroStore((s) => s.loadConfig)
  const loadState = usePomodoroStore((s) => s.loadState)
  const loadToday = usePomodoroStore((s) => s.loadToday)

  // 初次挂载：拉配置 + 当前状态 + 今日记录
  //
  // R-StrictMode 修复：React.StrictMode 在 dev 下会让组件 mount → unmount →
  // mount 一次，setup 里的 fire-and-forget IPC 会发两遍（第一次 cleanup 不
  // 取消 IPC），第二次 IPC 期间用户若触发 start()，第一次 IPC 返回的 idle
  // 状态后到达会覆盖刚启动的 control。用 closure-local `cancelled` 守卫，
  // 卸载时翻 true，让 in-flight 的 load* 响应在落地前被丢弃。
  useEffect(() => {
    let cancelled = false
    const guard = () => cancelled
    void loadConfig(guard)
    void loadState(guard)
    void loadToday(guard)
    return () => {
      cancelled = true
    }
  }, [loadConfig, loadState, loadToday])

  // R-InfLoop 修复：拆字段订阅 + useMemo 合成 displayState
  // R-fix-duplicate-control-subscription (low duplication)：原第 89-90 行
  // 用 aiModeV / aiRunningV 各起一份独立订阅，下面第 138-139 行又用同样
  // selector 起 modeV / runningV —— 同一组件对 s.control.mode / running
  // 建两份订阅，store 通知 + selector 重新计算各跑一遍。modeV / runningV
  // 在下面 useMemo / isIdle 也要用，所以提前声明到本块开头，AI context
  // effect 直接复用。
  const modeV = usePomodoroStore((s) => s.control.mode)
  const runningV = usePomodoroStore((s) => s.control.running)
  const cycleIndexV = usePomodoroStore((s) => s.control.cycleIndex)
  const startedAtV = usePomodoroStore((s) => s.control.startedAt)
  const totalSecV = usePomodoroStore((s) => s.control.totalSec)
  // stickyNoteId 由主进程 timerEngine 在 start(stickyNoteId) 时写入 control 切片，
  // 渲染端订阅后把真实值推到 AI 上下文 —— 之前这里硬编码 null 导致
  // main/ai/tools/context.ts 拼 system prompt 时只能引用空便签 id（见该文件
  // 第 336-339 行的 stickySuffix 分支），LLM 在「我接下来这节做什么」场景
  // 无法精准关联到用户当前正在工作的实体。
  const stickyNoteIdV = usePomodoroStore((s) => s.control.stickyNoteId)
  const remainingSecV = usePomodoroStore((s) => s.timer.remainingSec)
  const elapsedSecV = usePomodoroStore((s) => s.timer.elapsedSec)

  /*
   * AI 上下文同步 —— 把番茄钟的运行状态 / 模式 / 关联便签 id 推到 useAiStore
   * + 主进程。当用户从 Dashboard 进入 AI 对话，stream.ts 会读主进程的 context
   * map，把这些字段注入 system prompt，让 AI 回答能引用"本节番茄钟的状态"。
   *
   * 不订阅每秒 tick：只订阅稳定字段（mode、running、stickyNoteId）。
   *   - remainingSec / elapsedSec 不进 context（每秒变，进 prompt 也是噪音）。
   *     AI 通过"running + startedAt"自行换算。
   *   - stickyNoteId：随阶段切换（focus → break → focus）由主进程清空 / 重设，
   *     渲染端订阅 control.stickyNoteId 拿到真实值（之前硬编码 null 导致
   *     main/ai/tools/context.ts 第 336-339 行的 stickySuffix 分支永远走空）。
   *
   * pomodoro 面板常驻 Dashboard（不卸载），所以不需要清理 effect；用户
   * 切到非 Dashboard 路由时，PomodoroTimerPanel 整体卸载（见下方卸载 effect）。
   */
  const setContext = useAiStore((s) => s.setContext)
  useEffect(() => {
    setContext({
      pomodoroRunning: runningV,
      pomodoroMode: modeV,
      pomodoroStickyNoteId: stickyNoteIdV,
    })
    void aiApi
      .setCurrentPomodoroContext({
        running: runningV,
        mode: modeV,
        stickyNoteId: stickyNoteIdV,
      })
      .catch(() => undefined)
  }, [setContext, modeV, runningV, stickyNoteIdV])

  /*
   * 卸载清理 —— 用户离开 /dashboard 或 /today 路由后，PomodoroTimerPanel
   * 整体卸载。
   *
   * 1) AI 上下文：若不在 unmount 时主动清，主进程的 aiContextByWebContents
   *    仍保留最后的 running/mode；用户在 /ai 路由通过系统托盘 / 快捷键
   *    暂停番茄钟时（store.control.running → false，但本组件已卸载，
   *    effect 不会重跑），stream.ts 拼 system prompt 仍会引用过期的
   *    "番茄钟正在跑 专注 阶段"，让 LLM 基于错误前提作答。
   *    模式参考 NoteEditor.tsx 第 293-299 行（独立卸载 effect 清 useAiStore +
   *    aiApi.setCurrentNoteId(null)）。
   *
   * 2) focusMode：PomodoroTimerPanel 卸载时若 store.focusMode 仍为 true，
   *    下次回到 /dashboard 会立刻渲染 <FocusModeOverlay> 把整屏盖住。
   *    番茄钟计时状态由主进程独立维护，卸载时无需停止；只清"全屏遮罩"位。
   *    （焦点计时和遮罩显示是两件事：计时可能在跑，遮罩却不该跨路由残留。）
   */
  useEffect(() => {
    return () => {
      if (usePomodoroStore.getState().focusMode) {
        usePomodoroStore.getState().setFocusMode(false)
      }
      useAiStore.getState().setContext({
        pomodoroRunning: undefined,
        pomodoroMode: undefined,
        pomodoroStickyNoteId: null,
      })
      void aiApi.setCurrentPomodoroContext(null).catch(() => undefined)
    }
  }, [])

  // R-fix-pomodoro-persist-silent-fail (medium error-handling)：主进程
  // phase 完成 INSERT pomodoros 表失败时通过 POMODORO_PERSIST_FAILED 推送，
  // store 缓存到 persistError。面板订阅它，弹一次性 toast 让用户知情
  // （原本只在 main 进程 log，用户看不到失败现象 → 热力图 / 统计未更新
  // 也以为是软件 bug）。仅渲染端展示失败时不阻塞 UI，只提示一下。
  const persistError = usePomodoroStore((s) => s.persistError)
  const clearPersistError = usePomodoroStore((s) => s.setPersistError)
  useEffect(() => {
    if (!persistError) return
    const phaseLabel =
      persistError.phase === 'focus'
        ? '专注'
        : persistError.phase === 'shortBreak'
          ? '短休息'
          : '长休息'
    announce(
      `本次${phaseLabel}未记录：${persistError.reason}`,
      'assertive',
    )
    // 一次性 toast：8 秒后清掉，避免再次切换组件时旧 toast 重弹。
    const tid = window.setTimeout(() => clearPersistError(null), 8000)
    return () => window.clearTimeout(tid)
  }, [persistError, clearPersistError])

  // R-InfLoop 修复：拆字段订阅 + useMemo 合成 displayState
  // modeV / runningV / cycleIndexV / startedAtV / totalSecV / remainingSecV /
  // elapsedSecV 已在上面 AI context 块声明（提到上方是为消除重复订阅），此处
  // 仅复用 —— 见上方 R-fix-duplicate-control-subscription 注释。

  const displayState = useMemo<PomodoroState>(
    () => ({
      mode: modeV,
      running: runningV,
      cycleIndex: cycleIndexV,
      stickyNoteId: null,
      startedAt: startedAtV,
      totalSec: totalSecV,
      remainingSec: remainingSecV,
      elapsedSec: elapsedSecV,
    }),
    [modeV, runningV, cycleIndexV, startedAtV, totalSecV, remainingSecV, elapsedSecV],
  )

  const isIdle = !runningV
  const customMinutes = config.focusMin

  const handleChangeMinutes = useCallback(
    (m: number) => {
      void updateConfig({ focusMin: m })
    },
    [updateConfig],
  )

  const handlePrimary = useCallback(() => {
    if (runningV) {
      void pause()
    } else if (elapsedSecVRef.current > 0) {
      void resume()
    } else {
      void start()
    }
  }, [runningV, pause, resume, start])

  // R-perf fix (续)：elapsedSecV 每秒 +1，若把它塞进 handlePrimary 的
  // useCallback 依赖，handlePrimary 引用每秒换一次，MemoFocusControls 的
  // React.memo 立刻失效，整个 controls 子树（含 InlineAIButton）每 tick
  // 重渲染一次。用 ref snapshot 持有最新值，handlePrimary 的引用即可稳
  // 定到 running/pause/resume/start 真正变化时（start/pause/resume 本就
  // 是 store action，引用稳定），MemoFocusControls 不再被 1Hz tick 击穿。
  const elapsedSecVRef = useRef(elapsedSecV)
  useEffect(() => {
    elapsedSecVRef.current = elapsedSecV
  }, [elapsedSecV])

  const handleSkip = useCallback(() => {
    void skip()
  }, [skip])

  // R-fix-handle-reset-stop-branch (medium misleading-code)：原版
  // isIdle ? stop() : reset() 两个分支最终都走同一条 IPC POMODORO_STOP
  // （store.ts reset action 与 stop action 实现完全一致，主进程 IPC 通道
  // POMODORO_RESET 内部也是转发到 stop）—— 按钮文案根据 isIdle 切换
  // 「停止 / 重置」，但行为无差。现在只保留 stop，文案仍按 isIdle 切换，
  // 让 UI 与 store 公共 API 都不再误导：UI 不会再有「读『停止』却触发 reset」
  // 的语义错位，store 也不再暴露一个语义重复的 reset action（详见
  // stores/pomodoro.ts reset() 注释删除理由）。
  const handleResetOrStop = useCallback(() => {
    void stop()
  }, [stop])

  // Focus Mode overlay：订阅布尔位 + 提供退出回调
  const focusMode = usePomodoroStore((s) => s.focusMode)
  const setFocusMode = usePomodoroStore((s) => s.setFocusMode)
  const handleExitFocusMode = useCallback(() => {
    // 仅切 UI；计时不停；主进程会在 stop() 时也发 focus-mode-changed，
    // 这里手动退出（不调 stop）也算合法路径
    setFocusMode(false)
  }, [setFocusMode])

  if (!loaded) {
    return (
      <div className="pomodoro-timer-panel is-embedded">
        <div className="empty-tip muted">加载中…</div>
      </div>
    )
  }

  return (
    <div className="pomodoro-timer-panel is-embedded">
      {/* Focus mode 全屏遮罩（在主内容之上，但用 portal 渲染避免被嵌入容器裁剪） */}
      {focusMode && <FocusModeOverlay onExit={handleExitFocusMode} />}
      {/* Row 1 · 主区域：clock 在左，controls 在右 */}
      <div className="pomodoro-timer-main">
        <div className="pomodoro-timer-display-col">
          <MemoTimerDisplay
            state={displayState}
            config={config}
            size={PANEL_SIZE}
            stroke={PANEL_STROKE}
          />
        </div>

        <div className="pomodoro-timer-controls-col">
          {/* 时长 pill + 开始专注按钮 —— 纵向堆叠（专注按钮在 duration 下方） */}
          {/*
           * R-perf fix：之前 `state={displayState}` 把 memo 化的 timer
           * 全字段（remainingSec/elapsedSec 每秒变 → displayState 每秒
           * 换 ref）传给 MemoFocusControls —— 但 FocusControls 接口里
           * `state` 完全未读（解构里压根没有），导致每 1Hz tick 都重渲
           * 染这棵 memo 树。displayState 仅 TimerDisplay 真正使用。
           * 修复：去掉 state prop，让 MemoFocusControls 只对控制类字段
           * （customMinutes / primaryLabel / onPrimary / isIdle）敏感。
           */}
          <MemoFocusControls
            customMinutes={customMinutes}
            onChangeMinutes={handleChangeMinutes}
            primaryLabel={runningV ? '暂停' : elapsedSecV > 0 ? '继续' : '开始专注'}
            onPrimary={handlePrimary}
            isIdle={isIdle}
            orientation="col"
          />

          {/* 跳过 / 终止 —— 不再有 mode-pill */}
          <div className="pomodoro-secondary-controls">
            <button
              type="button"
              className="btn ghost pomodoro-secondary-btn"
              onClick={handleSkip}
              title="跳过当前阶段"
            >
              跳过
            </button>
            <button
              type="button"
              className="btn ghost pomodoro-secondary-btn"
              onClick={handleResetOrStop}
              title={isIdle ? '停止' : '停止当前阶段并回到初始 focus 阶段'}
            >
              {isIdle ? '停止' : '重置'}
            </button>
            {/*
             * AI 触发按钮 —— 放在"跳过 / 重置"右侧。
             *   - target="pomodoro" + id="pomodoro-state"：没有具体实体 id，
             *     但菜单 prompt 里需要引用当前番茄状态字段
             *   - variant="ghost"：保持与跳过 / 重置按钮风格一致
             *   - 上下文同步由本组件 useEffect 完成（推 running / mode /
             *     stickyNoteId 到 useAiStore + 主进程）
             */}
            <InlineAIButton
              target="pomodoro"
              id="pomodoro-state"
              size="sm"
              variant="ghost"
              title="AI 助手（规划本节 / 解释今日统计）"
            />
          </div>
        </div>
      </div>

      {/* Row 2 · 今日番茄紧凑列表（之前在日历面板里的"今日番茄"内容） */}
      <MemoTodayPomodoros />

      {/* Row 3 · 本月统计 —— 单行不换行（来自日历面板的"本月番茄"统计） */}
      <MemoMonthStats />

      {/* 快捷设置（保持在底部） */}
      <PomodoroQuickSettings />
    </div>
  )
}

export default PomodoroTimerPanel
