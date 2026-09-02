/**
 * 番茄钟控件
 * - 开始 / 暂停（toggle）
 * - 跳过
 * - 重置
 */
import type { PomodoroState } from '@shared/ipc/channels'

interface Props {
  state: PomodoroState
  loading?: boolean
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onSkip: () => void
  onReset: () => void
}

export function TimerControls({
  state,
  loading,
  onStart,
  onPause,
  onResume,
  onStop,
  onSkip,
  onReset,
}: Props) {
  // 已完成过阶段（elapsedSec > 0）说明在某个阶段中
  const inProgress = state.elapsedSec > 0 || state.remainingSec < state.totalSec

  const primaryLabel = !state.running
    ? inProgress
      ? '继续'
      : '开始'
    : '暂停'

  const handlePrimary = () => {
    if (loading) return
    if (!state.running) {
      if (inProgress) onResume()
      else onStart()
    } else {
      onPause()
    }
  }

  return (
    <div className="timer-controls">
      <button
        className="btn primary large"
        onClick={handlePrimary}
        disabled={loading}
      >
        {primaryLabel}
      </button>
      <button
        className="btn"
        onClick={onSkip}
        disabled={loading}
        title="跳过当前阶段"
      >
        跳过
      </button>
      <button
        className="btn ghost"
        onClick={inProgress ? onReset : onStop}
        disabled={loading}
        title="重置回初始 focus 阶段"
      >
        {inProgress ? '重置' : '停止'}
      </button>
    </div>
  )
}