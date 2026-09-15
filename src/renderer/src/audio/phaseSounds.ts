/**
 * 番茄钟阶段提示音（WebAudio 合成）
 *
 * 不引第三方库 / 不打包 wav —— 用 OscillatorNode 现场合成。
 * 两个短音：
 *   - focus 完成：上行 C5 → G5（向上行进的"完成感"）
 *   - break 完成：下行 G5 → C5（提示"该专注了"）
 *
 * 浏览器音频策略：AudioContext 需要用户首次交互后才能播放；
 * AudioContext 单例与 dispose 在 `context.ts` 统一管理，本模块直接复用
 * 共享实例 —— 避免与 noise.ts 各持一份导致 Chrome AudioContext 上限告警。
 */

import { getSharedAudioContext, disposeSharedAudioContext } from './context'

/**
 * 播放单音（C5 = 523.25, G5 = 783.99）。
 * duration 单位毫秒；gain 0..1。
 */
function playTone(
  ctx: AudioContext,
  freq: number,
  startOffsetSec: number,
  durationMs: number,
  gain: number,
): void {
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  const start = ctx.currentTime + startOffsetSec
  const end = start + durationMs / 1000
  // ADSR：30ms attack, sustain 到接近尾, 200ms release
  env.gain.setValueAtTime(0, start)
  env.gain.linearRampToValueAtTime(gain, start + 0.03)
  env.gain.setValueAtTime(gain, end - 0.2)
  env.gain.linearRampToValueAtTime(0, end)
  osc.connect(env)
  env.connect(ctx.destination)
  osc.start(start)
  osc.stop(end + 0.05)
}

/**
 * focus 完成提示音：C5 → G5 上行
 */
export function playFocusComplete(): void {
  const ctx = getSharedAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  playTone(ctx, 523.25, 0.0, 250, 0.18)
  playTone(ctx, 783.99, 0.22, 350, 0.18)
}

/**
 * 休息结束提示音：G5 → C5 下行（提示用户进入下一轮 focus）
 */
export function playBreakComplete(): void {
  const ctx = getSharedAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  playTone(ctx, 783.99, 0.0, 220, 0.18)
  playTone(ctx, 523.25, 0.2, 350, 0.18)
}

/**
 * 阶段完成清脆提示：单个 800Hz beep + 50ms 快速衰减。
 * 用于主进程 phase-complete 事件触发的"叮"一声反馈。
 * 与 playFocusComplete/playBreakComplete（上行/下行旋律）不同 —— 这是
 * 单一的清脆响声，给系统级反馈（类似 macOS 完成通知音）。
 */
export function playCompletionPing(): void {
  const ctx = getSharedAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  // 单 osc + 50ms 指数衰减
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = 800
  const start = ctx.currentTime
  env.gain.setValueAtTime(0, start)
  env.gain.linearRampToValueAtTime(0.22, start + 0.005)
  env.gain.exponentialRampToValueAtTime(0.0001, start + 0.05)
  osc.connect(env)
  env.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + 0.06)
}

/**
 * 用于 HMR / 测试时释放 AudioContext —— 转调共享 context.ts 的
 * disposeSharedAudioContext()。本模块的 oscillator 都是 fire-and-forget
 * 短音，没有需要 teardown 的节点。
 */
export function disposeAudio(): void {
  disposeSharedAudioContext()
}

// R32-Corr-X 修复 (medium)：Vite HMR 替换本模块时，旧模块的 _ctx / _bundle 引用
// 被丢弃，但 AudioContext 本身不会被 GC 回收 —— 每次 getCtx() 都会 new 一个新 ctx。
// Chrome 同 page 活跃 AudioContext 上限 ~6，超过会触发
// `Cannot create more AudioContexts`，番茄提示音直接哑掉。注册 HMR dispose 让
// Vite 在替换前主动调 disposeAudio() 把旧 ctx 释放掉。生产构建无 HMR 路径，
// 此分支被 dead-code-eliminate 不会进入包体。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeAudio()
  })
}
