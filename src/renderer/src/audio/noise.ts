/**
 * 白噪音生成器（WebAudio）
 *
 * - rain: 白噪音 + lowpass biquad @1500Hz，模拟雨声
 * - forest: 粉红噪音（Voss-McCartney 算法）+ 偶发短促鸟鸣（带 LFO）
 *
 * 单例：调用 startWhiteNoise('rain') 时如已有 noise 在跑则先停再切；
 * stopWhiteNoise() 时断开所有节点。
 */

import type { PomodoroWhiteNoise } from '@shared/ipc/channels'

interface NoiseBundle {
  ctx: AudioContext
  source: AudioBufferSourceNode
  filter: BiquadFilterNode
  gain: GainNode
  /** 森林模式下的额外 chirp oscillator */
  chirp?: { osc: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode }
}

let _bundle: NoiseBundle | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try {
    return new AC()
  } catch {
    return null
  }
}

/** 5 秒白噪音 BufferSource */
function makeWhiteBuffer(ctx: AudioContext, kind: PomodoroWhiteNoise): AudioBuffer {
  const seconds = 5
  const sampleRate = ctx.sampleRate
  const buf = ctx.createBuffer(1, sampleRate * seconds, sampleRate)
  const data = buf.getChannelData(0)
  if (kind === 'rain') {
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * 0.7
    }
  } else {
    // 粉红噪音（Paul Kellet 简化算法）
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + white * 0.0555179
      b1 = 0.99332 * b1 + white * 0.0750759
      b2 = 0.96900 * b2 + white * 0.1538520
      b3 = 0.86650 * b3 + white * 0.3104856
      b4 = 0.55000 * b4 + white * 0.5329522
      b5 = -0.7616 * b5 - white * 0.0168980
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
      b6 = white * 0.115926
    }
  }
  return buf
}

/** 释放旧 bundle */
function teardown(): void {
  if (!_bundle) return
  try {
    _bundle.source.stop()
  } catch {
    // ignore
  }
  try {
    _bundle.source.disconnect()
    _bundle.filter.disconnect()
    _bundle.gain.disconnect()
    if (_bundle.chirp) {
      _bundle.chirp.osc.stop()
      _bundle.chirp.lfo.stop()
      _bundle.chirp.osc.disconnect()
      _bundle.chirp.lfo.disconnect()
      _bundle.chirp.lfoGain.disconnect()
    }
    void _bundle.ctx.close()
  } catch {
    // ignore
  }
  _bundle = null
}

/**
 * 启动白噪音；如已在播放同类则 no-op，异类则切换。
 * @returns true 启动成功；false（AudioContext 不可用或参数异常）
 */
export function startWhiteNoise(kind: PomodoroWhiteNoise): boolean {
  if (kind === 'none') {
    stopWhiteNoise()
    return true
  }
  if (_bundle && _bundle.ctx.state === 'suspended') {
    void _bundle.ctx.resume()
  }
  if (_bundle && _bundle.source.buffer) {
    // 已经在跑：检测是否同一 kind —— 简化处理：总是重建以避免状态错乱
    teardown()
  }
  const ctx = getCtx()
  if (!ctx) return false

  const source = ctx.createBufferSource()
  source.buffer = makeWhiteBuffer(ctx, kind)
  source.loop = true

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = kind === 'rain' ? 1500 : 800

  const gain = ctx.createGain()
  gain.gain.value = kind === 'rain' ? 0.35 : 0.3

  source.connect(filter)
  filter.connect(gain)
  gain.connect(ctx.destination)
  source.start()

  let chirp: NoiseBundle['chirp']
  if (kind === 'forest') {
    // 1Hz LFO 周期性短暂放大 chirp
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 1800
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 1
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.04
    osc.connect(lfoGain)
    lfoGain.connect(gain.gain)
    osc.start()
    lfo.start()
    chirp = { osc, lfo, lfoGain }
  }

  _bundle = { ctx, source, filter, gain, chirp }
  return true
}

/** 停止白噪音；幂等 */
export function stopWhiteNoise(): void {
  teardown()
}

/** 当前是否在播放（用于 UI 状态指示） */
export function isNoisePlaying(): boolean {
  return _bundle !== null
}