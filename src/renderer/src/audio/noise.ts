/**
 * 白噪音生成器（WebAudio）
 *
 * 支持 kind：
 *   - none   : 关闭（teardown）
 *   - brown  : 1/f^2 棕色噪音（积分白噪音）
 *   - pink   : 1/f   粉红噪音（Paul Kellet 简化算法）
 *   - rain   : 白噪音 + lowpass @1500Hz + 偶发随机脉冲（模拟雨滴）
 *   - ocean  : brown + LFO 调制（模拟海浪起伏）
 *   - forest : pink + chirp oscillator（兼容历史 enum）
 *
 * 单例：startWhiteNoise() 时如已在跑同类则 no-op，异类则重建；
 * stopWhiteNoise() 幂等。
 */

import type { PomodoroWhiteNoise } from '@shared/ipc/channels'
import { getSharedAudioContext, disposeSharedAudioContext } from './context'

interface NoiseBundle {
  ctx: AudioContext
  source: AudioBufferSourceNode
  filter?: BiquadFilterNode
  gain: GainNode
  /** ocean 模式的 LFO（amplitude modulation） */
  lfo?: { osc: OscillatorNode; lfoGain: GainNode }
  /** forest 模式的额外 chirp oscillator */
  chirp?: { osc: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode }
  /** rain 模式的脉冲触发器 */
  rain?: { timer: number; panner: StereoPannerNode }
}

let _bundle: NoiseBundle | null = null
/**
 * 模块级 bundle 单例。ctx 来自 `./context` 的共享 AudioContext —— 整个
 * page 生命周期只创建 1 个 AudioContext（与 phaseSounds 共用），理由：
 *   1. AudioContext 构造开销 10~100ms（平台相关）；
 *   2. Chrome 同 page 活跃 AudioContext 数量上限 ~6 个，频繁切换 noise
 *      kind（rain→ocean→pink→none→brown）触顶后会触发
 *      `Cannot create more AudioContexts` warning；
 *   3. 每次 close() 后重建会丢失 audio session 状态，并重新走一次
 *      autoplay policy handshake。
 * 真正关闭走 disposeAudio()（HMR / 测试用），teardown() 只 disconnect
 * 节点保留 ctx 引用。
 */

/**
 * 生成 5 秒长度的 noise buffer —— 用 loop=true 循环播放避免每 5s 重建。
 * 算法：
 *   - brown: 积分白噪音（衰减系数 ~0.02，限制斜率）
 *   - pink : Paul Kellet 7-stage IIR filter
 *   - white: 均匀分布（rain 用 raw white）
 */
function makeNoiseBuffer(ctx: AudioContext, kind: 'brown' | 'pink' | 'white'): AudioBuffer {
  const seconds = 5
  const sampleRate = ctx.sampleRate
  const buf = ctx.createBuffer(1, sampleRate * seconds, sampleRate)
  const data = buf.getChannelData(0)
  if (kind === 'brown') {
    // Brown noise = integral of white noise（1/f^2 spectrum）
    let last = 0
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.5 // 增益补偿（brown 整体能量较小）
    }
  } else if (kind === 'pink') {
    // Paul Kellet 7-stage pink noise filter（业界标准近似 1/f）
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
  } else {
    // white：均匀分布
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * 0.7
    }
  }
  return buf
}

/** 安全地 stop 一个 AudioScheduledSourceNode，忽略节点状态机异常 */
function safeStop(n: AudioScheduledSourceNode | undefined): void {
  if (!n) return
  try {
    n.stop()
  } catch {
    // ignore：节点可能已经停止 / context 已 closing
  }
}

/** 安全地 disconnect 一个 AudioNode，忽略 InvalidStateError 等 */
function safeDisconnect(n: AudioNode | StereoPannerNode | undefined): void {
  if (!n) return
  try {
    n.disconnect()
  } catch {
    // ignore：节点可能未连接 / 已 disconnect
  }
}

/** 释放旧 bundle —— 每个节点独立 try/catch，保证 ctx.close() 一定能跑到 */
function teardown(): void {
  if (!_bundle) return
  const bundle = _bundle
  // 先 null 化外部引用，防止 rain tick 等回调在 teardown 过程中又碰到半残 bundle
  _bundle = null

  safeStop(bundle.source)
  safeDisconnect(bundle.source)
  safeDisconnect(bundle.filter)
  safeDisconnect(bundle.gain)

  if (bundle.lfo) {
    safeStop(bundle.lfo.osc)
    safeDisconnect(bundle.lfo.osc)
    safeDisconnect(bundle.lfo.lfoGain)
  }

  if (bundle.chirp) {
    safeStop(bundle.chirp.osc)
    safeStop(bundle.chirp.lfo)
    safeDisconnect(bundle.chirp.osc)
    safeDisconnect(bundle.chirp.lfo)
    safeDisconnect(bundle.chirp.lfoGain)
  }

  if (bundle.rain) {
    window.clearInterval(bundle.rain.timer)
    safeDisconnect(bundle.rain.panner)
  }

  // 注意：此处不再 close bundle.ctx。ctx 来自 `./context` 的共享单例（见模块
  // 顶部注释），切换 noise kind 或 stopWhiteNoise() 只 disconnect 节点即可，
  // 避免重建 ctx 触发 Chrome 的 AudioContext 数量上限告警。真正的 close 在
  // disposeAudio()（同时清空共享 ctx 引用）。
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
  // 已在跑 → 唤醒 suspended ctx 后重建（kind 不同 → 重建 buffer / 节点）
  if (_bundle) {
    if (_bundle.ctx.state === 'suspended') void _bundle.ctx.resume()
    teardown()
  }
  const ctx = getSharedAudioContext()
  if (!ctx) return false

  // 选 buffer 算法
  let bufKind: 'brown' | 'pink' | 'white'
  if (kind === 'brown' || kind === 'ocean') bufKind = 'brown'
  else if (kind === 'pink' || kind === 'forest') bufKind = 'pink'
  else bufKind = 'white' // rain

  const source = ctx.createBufferSource()
  source.buffer = makeNoiseBuffer(ctx, bufKind)
  source.loop = true

  let filter: BiquadFilterNode | undefined
  if (kind === 'rain') {
    filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1500
  } else if (kind === 'forest') {
    filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 800
  } else if (kind === 'ocean') {
    filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 600
  }

  const gain = ctx.createGain()
  // 能量补偿：brown 整体能量小 → 放大
  gain.gain.value =
    kind === 'brown' ? 0.6 :
    kind === 'rain' ? 0.35 :
    kind === 'ocean' ? 0.5 :
    kind === 'forest' ? 0.3 :
    kind === 'pink' ? 0.4 :
    0.4

  if (filter) {
    source.connect(filter)
    filter.connect(gain)
  } else {
    source.connect(gain)
  }
  gain.connect(ctx.destination)
  source.start()

  let lfo: NoiseBundle['lfo']
  if (kind === 'ocean') {
    // 0.15Hz LFO 模拟海浪起伏（5~7 秒周期）
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 0.15
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.35 // 调制深度 ±35%
    lfoGain.connect(gain.gain)
    osc.connect(lfoGain)
    osc.start()
    lfo = { osc, lfoGain }
  }

  let chirp: NoiseBundle['chirp']
  if (kind === 'forest') {
    // 1Hz LFO 周期性短暂放大 chirp
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 1800
    const lfoOsc = ctx.createOscillator()
    lfoOsc.type = 'sine'
    lfoOsc.frequency.value = 1
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.04
    osc.connect(lfoGain)
    lfoGain.connect(gain.gain)
    osc.start()
    lfoOsc.start()
    chirp = { osc, lfo: lfoOsc, lfoGain }
  }

  let rain: NoiseBundle['rain']
  if (kind === 'rain') {
    // 偶发雨滴脉冲：用 setInterval 每 80~200ms 插一次 burst
    const panner = ctx.createStereoPanner()
    panner.pan.value = 0
    panner.connect(gain)
    const tick = (): void => {
      if (!_bundle || !_bundle.rain) return
      const drop = ctx.createBufferSource()
      const dropBuf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate)
      const dd = dropBuf.getChannelData(0)
      for (let i = 0; i < dd.length; i += 1) {
        // 衰减包络 × 白噪音 = 短促啪声
        dd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / dd.length, 2)
      }
      drop.buffer = dropBuf
      const dropGain = ctx.createGain()
      dropGain.gain.value = 0.15 + Math.random() * 0.1
      drop.connect(dropGain)
      dropGain.connect(panner)
      // 随机左右声像（模拟雨滴位置）
      panner.pan.value = (Math.random() * 2 - 1) * 0.7
      // 资源回收：stop 触发 onended 后立即 disconnect。25 分钟雨声 ≈ 10500 次
      // tick × 3 节点；Chrome AudioBufferSourceNode 活跃源上界 ~256，不释放会
      // 触发 createBufferSource 抛错，且 GC 不回收仍 connect 的节点。
      drop.onended = (): void => {
        safeDisconnect(drop)
        safeDisconnect(dropGain)
      }
      drop.start()
      drop.stop(ctx.currentTime + 0.06)
    }
    const timer = window.setInterval(tick, 80 + Math.random() * 120)
    rain = { timer, panner }
  }

  _bundle = { ctx, source, filter, gain, lfo, chirp, rain }
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

/**
 * 用于 HMR / 测试时释放 AudioContext。先 teardown 当前 bundle（如果还在跑），
 * 再转调共享 context.ts 的 disposeSharedAudioContext()，close 共享单例并清
 * 空引用。与 phaseSounds.disposeAudio() 走同一条路径。
 */
export function disposeAudio(): void {
  teardown()
  disposeSharedAudioContext()
}

// R32-Corr-X 修复 (medium)：Vite HMR 替换本模块时，旧模块的 _ctx / _bundle 引用
// 被丢弃，但 AudioContext 本身不会被 GC 回收 —— 每次 getCtx() 都会 new 一个新 ctx。
// Chrome 同 page 活跃 AudioContext 上限 ~6，超过会触发
// `Cannot create more AudioContexts`，白噪音直接哑掉。注册 HMR dispose 让
// Vite 在替换前主动调 disposeAudio() 把旧 ctx 释放掉。生产构建无 HMR 路径，
// 此分支被 dead-code-eliminate 不会进入包体。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeAudio()
  })
}
