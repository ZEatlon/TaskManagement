/**
 * 共享 AudioContext 单例
 *
 * R36-audio-context-dedup 修复 (low perf)：原版 phaseSounds.ts 与 noise.ts 各自持有一份
 * `let _ctx: AudioContext | null = null` 模块级单例，且 `getCtx()` 都是 lazy
 * 第一次播放时才创建。noise.ts 注释明文承诺"整个 page 生命周期只创建 1 个
 * AudioContext"（Chrome 上限 ~6 个），但两个模块独立持有会让承诺落空：
 *
 *   - 用户首次完成一个番茄 focus 阶段 → phaseSounds.getCtx() 创建 context A
 *   - 随后打开 ambient noise（rain/ocean）→ noise.getCtx() 又创建 context B
 *
 * 两个 context 长期共存；进一步若再引入第三个 audio 模块（notification cue
 * / keyboard sound），3 个 context 在用户短时间多交互下会接近 Chrome 上限，
 * 触发 `Cannot create more AudioContexts` warning，后续模块的 getCtx() 进入
 * try/catch 静默失败路径 → 番茄完成音"无故消失"且无任何日志。
 *
 * 统一收口到一个共享模块：所有 audio 模块（phaseSounds / noise / 后续新增）
 * 都走 getSharedAudioContext()，注释里承诺的"page 生命周期 1 个 context"
 * 才真正成立。disposeAudio() 也集中管理，避免模块之间出现一个 close 掉另一
 * 个还在用的悬挂引用。
 *
 * lazy 创建策略不变 —— 浏览器音频策略要求 AudioContext 需要用户首次交互
 * 后才能播放；这里在第一次播放时才创建，避免 Electron 启动时无意义开销。
 */

let _ctx: AudioContext | null = null

/**
 * 获取 page 生命周期内共享的 AudioContext。
 *
 * - 首次调用时 lazy 创建（避免 Electron 启动时无意义开销 + 满足浏览器
 *   autoplay policy 的"用户首次交互后才能播放"要求）；
 * - 后续调用复用同一实例；
 * - SSR / 测试环境（window 不可用）→ 返回 null，调用方需自行降级；
 * - 创建抛错（极端浏览器环境）→ 返回 null。
 */
export function getSharedAudioContext(): AudioContext | null {
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
 * 释放共享 AudioContext。供 HMR / 测试使用 —— 生产构建无 HMR 路径，
 * 此分支被 dead-code-eliminate 不会进入包体。
 *
 * 注意：调用前应确保所有使用该 ctx 的节点（noise bundle / 一次性 oscillator）
 * 已经 stop + disconnect，否则 close 之后残留节点的 onended 回调会拿到
 * closed context。phaseSounds / noise 各自的 disposeAudio() 负责 teardown
 * 自己的节点，本函数只负责 close ctx 与清空引用。
 */
export function disposeSharedAudioContext(): void {
  if (_ctx) {
    void _ctx.close()
    _ctx = null
  }
}
