/**
 * 番茄钟阶段提示音（WebAudio 合成）
 *
 * 不引第三方库 / 不打包 wav —— 用 OscillatorNode 现场合成。
 * 两个短音：
 *   - focus 完成：上行 C5 → G5（向上行进的"完成感"）
 *   - break 完成：下行 G5 → C5（提示"该专注了"）
 *
 * 浏览器音频策略：AudioContext 需要用户首次交互后才能播放；
 * 这里在第一次播放时才 lazy 创建，避免 Electron 启动时无意义开销。
 */

let _ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (_ctx) return _ctx
  if (typeof window === 'undefined') return null
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try {
    _ctx = new AC()
  } catch {
    return null
  }
  return _ctx
}

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
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  playTone(ctx, 523.25, 0.0, 250, 0.18)
  playTone(ctx, 783.99, 0.22, 350, 0.18)
}

/**
 * 休息结束提示音：G5 → C5 下行（提示用户进入下一轮 focus）
 */
export function playBreakComplete(): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  playTone(ctx, 783.99, 0.0, 220, 0.18)
  playTone(ctx, 523.25, 0.2, 350, 0.18)
}

/**
 * 用于 HMR / 测试时释放 AudioContext
 */
export function disposeAudio(): void {
  if (_ctx) {
    void _ctx.close()
    _ctx = null
  }
}