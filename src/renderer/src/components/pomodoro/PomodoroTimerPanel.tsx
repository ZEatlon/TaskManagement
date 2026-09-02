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
 */
import { memo, useCallback, useEffect, useMemo } from 'react'
import type { PomodoroState } from '@shared/ipc/channels'
import { usePomodoroStore } from '../../stores/pomodoro'
import { TimerDisplay } from './TimerDisplay'
import { FocusControls } from './FocusControls'
import { TodayPomodoros } from './TodayPomodoros'
import { MonthStats } from './MonthStats'
import { PomodoroQuickSettings } from './PomodoroQuickSettings'

interface Props {
  /** 嵌入态：true 时减小 timer 直径并隐藏外框 */
  embedded?: boolean
}

const MemoTimerDisplay = memo(TimerDisplay)
const MemoFocusControls = memo(FocusControls)
const MemoTodayPomodoros = memo(TodayPomodoros)
const MemoMonthStats = memo(MonthStats)

export function PomodoroTimerPanel({ embedded = true }: Props) {
  const running = usePomodoroStore((s) => s.control.running)
  const config = usePomodoroStore((s) => s.config)
  const loaded = usePomodoroStore((s) => s.loaded)

  const start = usePomodoroStore((s) => s.start)
  const pause = usePomodoroStore((s) => s.pause)
  const resume = usePomodoroStore((s) => s.resume)
  const skip = usePomodoroStore((s) => s.skip)
  const reset = usePomodoroStore((s) => s.reset)
  const stop = usePomodoroStore((s) => s.stop)
  const updateConfig = usePomodoroStore((s) => s.updateConfig)
  const loadConfig = usePomodoroStore((s) => s.loadConfig)
  const loadState = usePomodoroStore((s) => s.loadState)
  const loadToday = usePomodoroStore((s) => s.loadToday)

  // 初次挂载：拉配置 + 当前状态 + 今日记录
  useEffect(() => {
    void loadConfig()
    void loadState()
    void loadToday()
  }, [loadConfig, loadState, loadToday])

  // R-InfLoop 修复：拆字段订阅 + useMemo 合成 displayState
  const modeV = usePomodoroStore((s) => s.control.mode)
  const runningV = usePomodoroStore((s) => s.control.running)
  const cycleIndexV = usePomodoroStore((s) => s.control.cycleIndex)
  const startedAtV = usePomodoroStore((s) => s.control.startedAt)
  const totalSecV = usePomodoroStore((s) => s.control.totalSec)
  const remainingSecV = usePomodoroStore((s) => s.timer.remainingSec)
  const elapsedSecV = usePomodoroStore((s) => s.timer.elapsedSec)

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

  const isIdle = !running
  const customMinutes = config.focusMin

  const handleChangeMinutes = useCallback(
    (m: number) => {
      void updateConfig({ focusMin: m })
    },
    [updateConfig],
  )

  const handlePrimary = useCallback(() => {
    if (running) {
      void pause()
    } else if (elapsedSecV > 0) {
      void resume()
    } else {
      void start()
    }
  }, [running, pause, resume, start, elapsedSecV])

  const handleSkip = useCallback(() => {
    void skip()
  }, [skip])

  const handleResetOrStop = useCallback(() => {
    if (isIdle) {
      void stop()
    } else {
      void reset()
    }
  }, [isIdle, stop, reset])

  if (!loaded) {
    return (
      <div className={`pomodoro-timer-panel ${embedded ? 'is-embedded' : ''}`}>
        <div className="empty-tip muted">加载中…</div>
      </div>
    )
  }

  return (
    <div className={`pomodoro-timer-panel ${embedded ? 'is-embedded' : ''}`}>
      {/* Row 1 · 主区域：clock 在左，controls 在右 */}
      <div className="pomodoro-timer-main">
        <div className="pomodoro-timer-display-col">
          <MemoTimerDisplay
            state={displayState}
            config={config}
            size={embedded ? 160 : 320}
            stroke={embedded ? 8 : 10}
          />
        </div>

        <div className="pomodoro-timer-controls-col">
          {/* 时长 pill + 开始专注按钮 —— 纵向堆叠（专注按钮在 duration 下方） */}
          <MemoFocusControls
            state={displayState}
            customMinutes={customMinutes}
            onChangeMinutes={handleChangeMinutes}
            primaryLabel={running ? '暂停' : elapsedSecV > 0 ? '继续' : '开始专注'}
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
              title={isIdle ? '停止' : '重置回初始 focus 阶段'}
            >
              {isIdle ? '停止' : '重置'}
            </button>
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
