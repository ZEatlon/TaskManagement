/**
 * 番茄钟白噪音（主进程编排）
 *
 * 设计说明：
 *   Web Audio API 在 Electron 主进程**不可用**（主进程是纯 Node 运行时，
 *   没有 DOM / AudioContext）。所以本文件只做编排：
 *     - 缓存当前 kind
 *     - 通过 IPC 把 start/stop 指令推给所有渲染端
 *   实际的 Web Audio 合成在 `src/renderer/src/audio/noise.ts`。
 *
 * 使用场景：
 *   - pomodoroService.start() 时如果 config.whiteNoise !== 'none'，
 *     调 setWhiteNoise(kind) 推 IPC。
 *   - pomodoroService.stop() / 阶段完成 / 用户主动关闭 → setWhiteNoise('none')。
 *
 * 懒加载：
 *   - 不被 pomodoroService 静态 import；上层用 `await import('./audio')`，
 *     避免音频模块污染主进程冷启动链路。
 *
 * 渲染端可独立使用 noise.ts 的 startWhiteNoise() 做试听（无需主进程）。
 */
import { emitToRenderers } from '../ipc/emit'
import { IPC_CHANNELS, type PomodoroWhiteNoise } from '@shared/ipc/channels'

let _currentKind: PomodoroWhiteNoise = 'none'

/** 当前正在请求播放的白噪音类型（用于诊断） */
export function currentWhiteNoiseKind(): PomodoroWhiteNoise {
  return _currentKind
}

/** 推送白噪音变更到所有渲染端；同一 kind 视为幂等 */
export function setWhiteNoise(kind: PomodoroWhiteNoise): void {
  if (_currentKind === kind) return
  _currentKind = kind
  emitToRenderers(IPC_CHANNELS.POMODORO_AUDIO_SET, { kind })
}

/** 推送「阶段完成」音效（清脆一声）到所有渲染端 */
export function playCompletionSound(mode: 'focus' | 'shortBreak' | 'longBreak'): void {
  emitToRenderers(IPC_CHANNELS.POMODORO_AUDIO_PLAY_SOUND, { mode })
}

/** 主进程退出 / 重启时清理状态 */
export function disposeAudio(): void {
  _currentKind = 'none'
}
