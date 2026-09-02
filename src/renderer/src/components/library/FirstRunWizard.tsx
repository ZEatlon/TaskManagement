/**
 * 首次启动向导（全屏覆盖）
 *
 * 步骤：
 *   1. 欢迎界面，介绍 TaskPilot
 *   2. 选择库目录（默认 ~/Documents/TaskPilot，可手动浏览）
 *   3. 创建/初始化库，显示进度
 *   4. 完成 → 通知父组件进入主界面
 *
 * Props：
 *   - onComplete(): 库路径设置成功后调用，__root.tsx 据此切换到主界面
 */
import { useEffect, useRef, useState } from 'react'
import { libraryApi } from '@renderer/lib/ipc'
import { useSettingsStore } from '@renderer/stores/settings'
import { LibrarySelector } from './LibrarySelector'
import { BrandMark } from '../brand/BrandMark'
import { useFocusTrap } from '@renderer/lib/useFocusTrap'

interface Props {
  onComplete: () => void
}

type Step = 'welcome' | 'select' | 'init' | 'done'

interface InitState {
  path: string
  status: 'pending' | 'creating' | 'success' | 'error'
  message?: string
}

export function FirstRunWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  const [initState, setInitState] = useState<InitState | null>(null)
  const setLibraryPath = useSettingsStore((s) => s.setLibraryPath)
  // R13 修复 (medium)：向导是 modal-style 全屏 overlay。补 role="dialog" +
  // aria-modal + Escape 不关闭（向导无 close 按钮，Esc 不应让用户卡在中间）但
  // 可以回退到 welcome；focus 在 step 切换时重新聚焦 body 第一按钮。
  const wizardRef = useRef<HTMLDivElement | null>(null)
  // R24-a11y-1 修复 (high a11y-keyboard)：向导声明 role=dialog + aria-modal=true
  // 但缺 useFocusTrap → 键盘用户 Tab 一次就穿透 wizard-overlay 落到背后的
  // AppHeader nav / WindowControls / StatusBar（DOM 中这些元素并未 unmount，
  // 仅被 overlay 视觉遮挡），无法返回向导。WCAG 2.1.2 No Keyboard Trap 反
  // 面（无 containment）。装上 useFocusTrap 强制 Tab 在向导子树内循环。
  useFocusTrap(wizardRef, true)
  useEffect(() => {
    // 每次 step 切换后，把焦点送到该 step 的第一个 button/input
    const id = window.requestAnimationFrame(() => {
      const el = wizardRef.current?.querySelector<HTMLElement>(
        'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      el?.focus()
    })
    return () => window.cancelAnimationFrame(id)
  }, [step])

  const handleSelect = (path: string) => {
    setChosenPath(path)
  }

  const handleInitialize = async () => {
    if (!chosenPath) return
    setStep('init')
    setInitState({ path: chosenPath, status: 'creating' })

    try {
      // 1. 校验目录
      const v = await libraryApi.validate(chosenPath)
      if (!v.valid) {
        setInitState({
          path: chosenPath,
          status: 'error',
          message: v.reason ?? '目录不可用',
        })
        return
      }

      // 2. 创建库骨架
      const result = await libraryApi.initialize(chosenPath)

      // 3. 写入 settings
      await setLibraryPath(result.path)

      setInitState({ path: result.path, status: 'success' })
      setStep('done')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setInitState({
        path: chosenPath,
        status: 'error',
        message: msg,
      })
    }
  }

  return (
    <div className="wizard-overlay">
      <div
        className="wizard"
        ref={wizardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
      >
        <header className="wizard-header">
          <h1 id="wizard-title">欢迎使用 TaskPilot</h1>
          <StepIndicator current={step} />
        </header>

        <div className="wizard-body">
          {step === 'welcome' && (
            <WelcomeStep onNext={() => setStep('select')} />
          )}

          {step === 'select' && (
            <SelectStep
              chosenPath={chosenPath}
              onSelect={handleSelect}
              onBack={() => setStep('welcome')}
              onNext={handleInitialize}
            />
          )}

          {step === 'init' && initState && (
            <InitStep state={initState} onRetry={() => setStep('select')} />
          )}

          {step === 'done' && initState && (
            <DoneStep path={initState.path} onEnter={onComplete} />
          )}
        </div>
      </div>
    </div>
  )
}

// ====== 子步骤 ======

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="wizard-step welcome-step">
      <BrandMark size={72} className="welcome-icon" title="TaskPilot" />
      <h2>本地优先的个人任务与笔记工作台</h2>
      <p className="welcome-desc">
        TaskPilot 把你的任务、笔记和附件都保存在<strong>你自己选择</strong>的本地目录中。
        数据完全由你掌控：随时可以备份、迁移到其它机器、或用 Git 同步。
      </p>
      <ul className="welcome-features">
        <li>📝 任务与笔记一体化：任务可在笔记中展开上下文</li>
        <li>📂 数据本地存储：选定一个目录，所有内容都在那里</li>
        <li>🔌 可扩展：将来支持 Git 同步、AI 助手等</li>
      </ul>
      <div className="wizard-actions">
        <button className="btn primary" onClick={onNext}>
          开始设置 →
        </button>
      </div>
    </div>
  )
}

function SelectStep({
  chosenPath,
  onSelect,
  onBack,
  onNext,
}: {
  chosenPath: string | null
  onSelect: (p: string) => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="wizard-step select-step">
      <h2>选择库目录</h2>
      <p className="muted">
        TaskPilot 将在该目录下创建 <code>.taskpilot</code> 子目录，
        用于存放任务、笔记和附件。
      </p>

      <LibrarySelector value={chosenPath} onChange={onSelect} />

      <div className="wizard-actions">
        <button className="btn ghost" onClick={onBack}>
          ← 上一步
        </button>
        <button className="btn primary" onClick={onNext} disabled={!chosenPath}>
          使用此目录 →
        </button>
      </div>
    </div>
  )
}

function InitStep({
  state,
  onRetry,
}: {
  state: InitState
  onRetry: () => void
}) {
  return (
    <div className="wizard-step init-step">
      <h2>正在初始化库…</h2>
      <p className="muted">库目录：{state.path}</p>

      <div className="init-progress">
        {state.status === 'creating' && (
          <div className="spinner" aria-label="加载中" />
        )}
        {state.status === 'error' && (
          <div className="error-box" role="alert">
            <strong>初始化失败</strong>
            <p>{state.message}</p>
          </div>
        )}
      </div>

      {state.status === 'error' && (
        <div className="wizard-actions">
          <button className="btn" onClick={onRetry}>
            ← 重新选择目录
          </button>
        </div>
      )}
    </div>
  )
}

function DoneStep({ path, onEnter }: { path: string; onEnter: () => void }) {
  return (
    <div className="wizard-step done-step">
      <div className="done-icon">✓</div>
      <h2>库已就绪</h2>
      <p className="muted">{path}</p>
      <div className="wizard-actions">
        <button className="btn primary" onClick={onEnter}>
          进入 TaskPilot →
        </button>
      </div>
    </div>
  )
}

function StepIndicator({ current }: { current: Step }) {
  const order: Step[] = ['welcome', 'select', 'init', 'done']
  const idx = order.indexOf(current)
  const labels = ['欢迎', '选择目录', '初始化', '完成']
  return (
    // R12 修复 (low)：给 ol 加 role="list" 让 SR 正确识别列表；当前 step
    // 标 aria-current="step" 让 SR 知道用户位置。
    <ol className="step-indicator" role="list">
      {order.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'active' : 'pending'
        return (
          <li
            key={s}
            className={state}
            aria-current={i === idx ? 'step' : undefined}
          >
            <span className="dot">{i + 1}</span>
            <span className="label">{labels[i]}</span>
          </li>
        )
      })}
    </ol>
  )
}
