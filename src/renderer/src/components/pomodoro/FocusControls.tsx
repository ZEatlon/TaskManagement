/**
 * 番茄钟页面的底部控制栏
 *
 * 设计：
 * - 中间：大字显示「30 分钟」（带 −/+ 按钮调整）
 * - 右侧：主操作按钮（开始 / 暂停 / 继续）
 * - 左侧：可选显示「剩余次数」「今日已完成」等 metadata
 *
 * 交互：
 * - −/+ 调整时长（步长 5 分钟；边界 5~90 分钟）
 * - 点击中央时长 → 重置为默认（25 分钟）
 * - 点击右侧按钮触发 onStart/onPause/onResume（由父组件决定）
 */
import { useCallback, useEffect, useState } from 'react'
import type { PomodoroState } from '@shared/ipc/channels'

interface FocusControlsProps {
  state: PomodoroState
  /** 自定义焦点时长（分钟），仅在 idle 状态下生效 */
  customMinutes: number
  onChangeMinutes: (m: number) => void
  /** 主按钮文字 */
  primaryLabel: string
  onPrimary: () => void
  /** 是否处于空闲状态（idle / 未运行） */
  isIdle: boolean
  loading?: boolean
  /**
   * 布局朝向：
   *   - 'row'（默认）：duration 在左、start 在右 —— 用于整页底部控制栏
   *   - 'col'：duration 在上、start 在下，都铺满列宽 —— 用于 dashboard 嵌入式面板
   */
  orientation?: 'row' | 'col'
}

const MIN_MINUTES = 5
const MAX_MINUTES = 90
const STEP_MINUTES = 5
const DEFAULT_MINUTES = 25

export function FocusControls({
  customMinutes,
  onChangeMinutes,
  primaryLabel,
  onPrimary,
  isIdle,
  loading,
  orientation = 'row',
}: FocusControlsProps) {
  // R12 修复 (low)：每次 +/- 都直接打 IPC（updateConfig）会狂写主进程
  // + DB + 通知 store 订阅者。本地先 hold pendingMinutes，250ms 内连续
  // 点击只发最后一次。
  const [pendingMinutes, setPendingMinutes] = useState<number | null>(null)
  useEffect(() => {
    if (pendingMinutes === null) return
    const id = window.setTimeout(() => {
      onChangeMinutes(pendingMinutes)
      setPendingMinutes(null)
    }, 250)
    return () => window.clearTimeout(id)
  }, [pendingMinutes, onChangeMinutes])

  const dec = useCallback(() => {
    const next = Math.max(MIN_MINUTES, customMinutes - STEP_MINUTES)
    setPendingMinutes(next)
  }, [customMinutes])

  const inc = useCallback(() => {
    const next = Math.min(MAX_MINUTES, customMinutes + STEP_MINUTES)
    setPendingMinutes(next)
  }, [customMinutes])

  const resetMinutes = useCallback(() => {
    setPendingMinutes(DEFAULT_MINUTES)
  }, [])

  // idle 时才允许调整；运行中显示当前阶段剩余（不可调整）
  const disabled = !isIdle || loading
  // 显示值：优先用 pending（用户点了 +/- 后立即反馈），否则用 external prop
  const displayMinutes = pendingMinutes ?? customMinutes

  return (
    <div className={`focus-controls orientation-${orientation}`}>
      <div className="focus-duration">
        <button
          type="button"
          className="focus-duration-btn"
          onClick={dec}
          disabled={disabled || displayMinutes <= MIN_MINUTES}
          aria-label="减少时长"
          title="减少 5 分钟"
        >
          −
        </button>
        <button
          type="button"
          className="focus-duration-display"
          onClick={resetMinutes}
          disabled={disabled}
          title="重置为 25 分钟"
        >
          <span className="focus-duration-num">{displayMinutes}</span>
          <span className="focus-duration-unit">分钟</span>
        </button>
        <button
          type="button"
          className="focus-duration-btn"
          onClick={inc}
          disabled={disabled || displayMinutes >= MAX_MINUTES}
          aria-label="增加时长"
          title="增加 5 分钟"
        >
          +
        </button>
      </div>

      <button
        type="button"
        className={['focus-start', isIdle ? 'is-idle' : 'is-running'].filter(Boolean).join(' ')}
        onClick={onPrimary}
        disabled={loading}
      >
        <span className="focus-start-icon" aria-hidden>
          {isIdle ? '▶' : '❚❚'}
        </span>
        <span className="focus-start-label">{primaryLabel}</span>
      </button>
    </div>
  )
}