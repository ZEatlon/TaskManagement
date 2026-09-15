/**
 * 番茄钟快捷设置（内嵌到 PomodoroTimerPanel）
 *
 * 取代之前独立的 `PomodoroSettingsStrip` widget —— 直接把高频设置放在计时面板底部一行，
 * 不再需要"展开/折叠"的中间步骤。
 *
 * 两层分布：
 *   Tier 1 · 内嵌一行（最常用）：
 *     - 循环数（cycleCount） -/+
 *     - 每日目标（dailyGoal） -/+
 *     - 自动开始下一阶段（autoStartNext） 切换按钮
 *     - 提示音（soundEnabled） 切换按钮
 *   Tier 2 · 齿轮 popover（不常用，按需打开）：
 *     - 短休时长（shortBreakMin） -/+
 *     - 长休时长（longBreakMin） -/+
 *     - 白噪音（whiteNoise） select
 *
 * 设计原则：
 *   - 每个字段独立写入：`updateConfig({ key: value })`，无 save/dirty 状态机。
 *   - 不重复 focusMin —— 已在 FocusControls 里有 -/+ 按钮。
 *   - 数值范围限制在写入时立即 clamp（避免 store 与 UI 不一致）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Minus,
  Plus,
  Play,
  Settings,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { usePomodoroStore } from '../../stores/pomodoro'
import {
  POMODORO_CYCLE_LIMITS,
  POMODORO_DAILY_GOAL_LIMITS,
  POMODORO_LONG_BREAK_LIMITS,
  POMODORO_SHORT_BREAK_LIMITS,
  type PomodoroConfig,
  type PomodoroWhiteNoise,
} from '@shared/ipc/channels'

/**
 * UI 边界从 @shared/ipc/channels 单一源读（与 validator 同文件 import）。
 *
 * Validator 在主进程允许更宽的区间（cycleCount [1,12] / shortBreakMin [1,180]
 * / longBreakMin [1,180] / dailyGoal [1,20]），UI 故意只暴露更窄的子集
 * （见 channels.ts 各 *_LIMITS 常量的 JSDoc）。两层边界的契约见
 * channels.ts POMODORO_CYCLE_LIMITS 块。
 */
const CYCLE_MIN = POMODORO_CYCLE_LIMITS.min
const CYCLE_MAX = POMODORO_CYCLE_LIMITS.max
const GOAL_MIN = POMODORO_DAILY_GOAL_LIMITS.min
const GOAL_MAX = POMODORO_DAILY_GOAL_LIMITS.max
const SHORT_BREAK_MIN = POMODORO_SHORT_BREAK_LIMITS.min
const SHORT_BREAK_MAX = POMODORO_SHORT_BREAK_LIMITS.max
const LONG_BREAK_MIN = POMODORO_LONG_BREAK_LIMITS.min
const LONG_BREAK_MAX = POMODORO_LONG_BREAK_LIMITS.max

const WHITE_NOISE_OPTIONS: Array<{ value: PomodoroWhiteNoise; label: string }> = [
  { value: 'none', label: '关闭' },
  { value: 'brown', label: '棕色' },
  { value: 'pink', label: '粉色' },
  { value: 'rain', label: '雨声' },
  { value: 'ocean', label: '海浪' },
  { value: 'forest', label: '森林' },
]

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

interface StepperProps {
  label: string
  value: number
  min: number
  max: number
  onChange: (next: number) => void
}

function Stepper({ label, value, min, max, onChange }: StepperProps) {
  const dec = useCallback(() => onChange(clamp(value - 1, min, max)), [value, min, max, onChange])
  const inc = useCallback(() => onChange(clamp(value + 1, min, max)), [value, min, max, onChange])
  const canDec = value > min
  const canInc = value < max
  return (
    <div className="pomodoro-quick-pill">
      <span className="pomodoro-quick-label">{label}</span>
      <button
        type="button"
        className="pomodoro-quick-step"
        onClick={dec}
        disabled={!canDec}
        aria-label={`${label} 减 1`}
      >
        <Minus size={12} aria-hidden />
      </button>
      <span className="pomodoro-quick-value">{value}</span>
      <button
        type="button"
        className="pomodoro-quick-step"
        onClick={inc}
        disabled={!canInc}
        aria-label={`${label} 加 1`}
      >
        <Plus size={12} aria-hidden />
      </button>
    </div>
  )
}

export function PomodoroQuickSettings(): JSX.Element {
  const config = usePomodoroStore((s) => s.config)
  const updateConfig = usePomodoroStore((s) => s.updateConfig)

  const [gearOpen, setGearOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const gearBtnRef = useRef<HTMLButtonElement | null>(null)

  // popover 关闭统一入口：先关闭 state，浏览器下一帧再把焦点还给齿轮按钮。
  // 直接在 setGearOpen 回调里 focus 会被 React 自己的焦点管理覆盖，故延后到 effect。
  const closeGear = useCallback(() => {
    setGearOpen(false)
  }, [])

  // 打开时把焦点送进 popover 第一个可聚焦元素；关闭时归还焦点给齿轮按钮。
  useEffect(() => {
    if (!gearOpen) return
    // 打开后下一帧取 focusable，避免 React 还没把 popover 渲染进去就 query
    const focusFirst = window.setTimeout(() => {
      const pop = popoverRef.current
      if (!pop) return
      const focusables = pop.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      focusables[0]?.focus()
    }, 0)
    return () => window.clearTimeout(focusFirst)
  }, [gearOpen])

  // 关闭后归还焦点给齿轮按钮（仅在确实打开过 → 关闭时执行）
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (gearOpen) {
      wasOpenRef.current = true
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false
      gearBtnRef.current?.focus()
    }
  }, [gearOpen])

  // 点击外部 / Esc 关闭 popover；Tab/Shift+Tab 在 popover 内循环
  useEffect(() => {
    if (!gearOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (gearBtnRef.current?.contains(t)) return
      closeGear()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeGear()
        return
      }
      if (e.key === 'Tab') {
        const pop = popoverRef.current
        if (!pop) return
        const focusables = Array.from(
          pop.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        )
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey) {
          if (active === first || !pop.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (active === last || !pop.contains(active)) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [gearOpen, closeGear])

  const patchCycle = useCallback(
    (n: number) => {
      void updateConfig({ cycleCount: clamp(n, CYCLE_MIN, CYCLE_MAX) })
    },
    [updateConfig],
  )
  const patchGoal = useCallback(
    (n: number) => {
      void updateConfig({ dailyGoal: clamp(n, GOAL_MIN, GOAL_MAX) })
    },
    [updateConfig],
  )
  const patchShortBreak = useCallback(
    (n: number) => {
      void updateConfig({ shortBreakMin: clamp(n, SHORT_BREAK_MIN, SHORT_BREAK_MAX) })
    },
    [updateConfig],
  )
  const patchLongBreak = useCallback(
    (n: number) => {
      void updateConfig({ longBreakMin: clamp(n, LONG_BREAK_MIN, LONG_BREAK_MAX) })
    },
    [updateConfig],
  )
  const toggleAutoStart = useCallback(() => {
    void updateConfig({ autoStartNext: !config.autoStartNext })
  }, [updateConfig, config.autoStartNext])
  const toggleSound = useCallback(() => {
    void updateConfig({ soundEnabled: !config.soundEnabled })
  }, [updateConfig, config.soundEnabled])
  const setWhiteNoise = useCallback(
    (w: PomodoroWhiteNoise) => {
      void updateConfig({ whiteNoise: w })
    },
    [updateConfig],
  )

  // 试听白噪音：点播放 3 秒预览，点停止立即停。仅渲染端 Web Audio 播放，
  // 不影响 config / 主进程 audio 模块。组件卸载或切换预览 kind 时也清理。
  const [previewing, setPreviewing] = useState(false)
  const previewTimerRef = useRef<number | null>(null)
  const stopPreview = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    void import('../../audio/noise').then((m) => {
      m.stopWhiteNoise()
    }).catch(() => undefined)
    setPreviewing(false)
  }, [])
  const handlePreview = useCallback(() => {
    if (previewing) {
      stopPreview()
      return
    }
    const kind = config.whiteNoise
    if (kind === 'none') return
    void import('../../audio/noise').then((m) => {
      m.startWhiteNoise(kind)
      setPreviewing(true)
      // 3 秒后自动停
      previewTimerRef.current = window.setTimeout(() => {
        m.stopWhiteNoise()
        setPreviewing(false)
        previewTimerRef.current = null
      }, 3000)
    }).catch(() => undefined)
  }, [previewing, stopPreview, config.whiteNoise])

  // 卸载或切换选项时清掉预览 timer
  useEffect(() => {
    return () => {
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current)
      }
      void import('../../audio/noise').then((m) => m.stopWhiteNoise()).catch(() => undefined)
    }
  }, [])

  return (
    <div className="pomodoro-quick-controls">
      <Stepper
        label="循环"
        value={config.cycleCount}
        min={CYCLE_MIN}
        max={CYCLE_MAX}
        onChange={patchCycle}
      />
      <Stepper
        label="目标"
        value={config.dailyGoal}
        min={GOAL_MIN}
        max={GOAL_MAX}
        onChange={patchGoal}
      />
      <button
        type="button"
        className={`pomodoro-quick-toggle ${config.autoStartNext ? 'is-active' : ''}`}
        onClick={toggleAutoStart}
        title="阶段结束后自动开始下一段"
        aria-pressed={config.autoStartNext}
      >
        <SkipForward size={13} aria-hidden />
        <span>自动</span>
      </button>
      <button
        type="button"
        className={`pomodoro-quick-toggle ${config.soundEnabled ? 'is-active' : ''}`}
        onClick={toggleSound}
        title="阶段切换提示音"
        aria-pressed={config.soundEnabled}
      >
        {config.soundEnabled ? (
          <Volume2 size={13} aria-hidden />
        ) : (
          <VolumeX size={13} aria-hidden />
        )}
        <span>提示音</span>
      </button>
      <button
        ref={gearBtnRef}
        type="button"
        className={`pomodoro-quick-gear ${gearOpen ? 'is-open' : ''}`}
        onClick={() => setGearOpen((v) => !v)}
        title="更多设置"
        // R37 修复 (medium a11y)：popover 是非模态（不挡背后 UI 也不暗化），
        // 不应使用 role="dialog" / aria-haspopup="dialog"。改为 region +
        // aria-haspopup="true"（通用 popup），开关状态由 aria-expanded 表达。
        aria-haspopup="true"
        aria-expanded={gearOpen}
        aria-controls="pomodoro-settings-popover"
      >
        <Settings size={13} aria-hidden />
      </button>
      {gearOpen && (
        <div
          ref={popoverRef}
          id="pomodoro-settings-popover"
          className="pomodoro-settings-popover"
          role="region"
          aria-label="番茄钟更多设置"
        >
          <Stepper
            label="短休"
            value={config.shortBreakMin}
            min={SHORT_BREAK_MIN}
            max={SHORT_BREAK_MAX}
            onChange={patchShortBreak}
          />
          <Stepper
            label="长休"
            value={config.longBreakMin}
            min={LONG_BREAK_MIN}
            max={LONG_BREAK_MAX}
            onChange={patchLongBreak}
          />
          <label className="pomodoro-quick-row">
            <span className="pomodoro-quick-label">白噪音</span>
            <select
              className="pomodoro-quick-select"
              value={config.whiteNoise}
              onChange={(e) => setWhiteNoise(e.target.value as PomodoroWhiteNoise)}
            >
              {WHITE_NOISE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`pomodoro-quick-toggle pomodoro-noise-preview ${previewing ? 'is-active' : ''}`}
              onClick={handlePreview}
              disabled={config.whiteNoise === 'none'}
              title={previewing ? '停止试听' : '试听 3 秒'}
              aria-label={previewing ? '停止试听' : '试听白噪音 3 秒'}
              aria-pressed={previewing}
            >
              {previewing ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}
            </button>
          </label>
        </div>
      )}
    </div>
  )
}

// 静默导出 PomodoroConfig 类型别名，避免外部因重构而 import 不到
export type { PomodoroConfig }