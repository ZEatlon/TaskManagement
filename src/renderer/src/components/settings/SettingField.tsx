/**
 * 通用设置字段
 *
 * 统一的 label + control + description 三段式结构，
 * 通过 `type` 渲染对应的 input / select / toggle / color / password。
 * value 变更通过 onChange 触发，持久化由父组件负责。
 */
import { useId, useState, type ReactNode } from 'react'

/** SettingField 支持的控件类型 */
export type SettingControlType =
  | 'text'
  | 'number'
  | 'select'
  | 'toggle'
  | 'color'
  | 'password'
  | 'time'
  | 'custom'

/** select 选项 */
export interface SelectOption {
  value: string
  label: string
}

export interface SettingFieldProps {
  /** 标题（必填） */
  label: string
  /** 描述文案，显示在控件下方 */
  description?: string
  /** 控件类型 */
  type?: SettingControlType
  /** 当前值 */
  value?: string | number | boolean | null
  /** 值变化回调 */
  onChange?: (next: string | number | boolean) => void
  /** select 选项（type=select 时必填） */
  options?: SelectOption[]
  /** number 范围 */
  min?: number
  max?: number
  step?: number
  /** 占位符 */
  placeholder?: string
  /** 失焦保存（如 number 推荐 onBlur） */
  onBlur?: () => void
  /** 自定义控件（type=custom 时使用） */
  children?: ReactNode
  /** 禁用 */
  disabled?: boolean
}

/**
 * 通用字段组件
 * 支持 text / number / select / toggle / color / password / time / custom
 */
export function SettingField({
  label,
  description,
  type = 'text',
  value,
  onChange,
  options,
  min,
  max,
  step,
  placeholder,
  onBlur,
  children,
  disabled = false,
}: SettingFieldProps) {
  // R12 修复 (medium)：用 useId 给 label 和控件建立 htmlFor ↔ id 绑定，
  // 屏幕阅读器 / 点击 label 都能聚焦到对应控件。
  const fieldId = useId()
  return (
    <div className={`setting-field ${disabled ? 'is-disabled' : ''}`}>
      <div className="setting-field-head">
        <label className="setting-field-label" htmlFor={fieldId}>{label}</label>
        {renderControl({
          id: fieldId,
          type,
          value,
          onChange,
          options,
          min,
          max,
          step,
          placeholder,
          onBlur,
          children,
          disabled,
        })}
      </div>
      {description && <p className="setting-field-desc">{description}</p>}
    </div>
  )
}

/** 渲染右侧控件 */
function renderControl(props: {
  id?: string
  type: SettingControlType
  value?: string | number | boolean | null
  onChange?: (next: string | number | boolean) => void
  options?: SelectOption[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  onBlur?: () => void
  children?: ReactNode
  disabled: boolean
}): ReactNode {
  const { id, type, value, onChange, options, min, max, step, placeholder, onBlur, children, disabled } = props

  switch (type) {
    case 'text':
      return (
        <input
          id={id}
          className="setting-input"
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
      )

    case 'number':
      return (
        <input
          id={id}
          className="setting-input"
          type="number"
          value={typeof value === 'number' ? value : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange?.(Number(e.target.value))}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
        />
      )

    case 'select':
      return (
        <select
          id={id}
          className="setting-input"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={disabled}
        >
          {(options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )

    case 'toggle':
      return (
        <button
          id={id}
          type="button"
          className={`toggle ${value ? 'on' : 'off'}`}
          onClick={() => !disabled && onChange?.(!value)}
          disabled={disabled}
          aria-pressed={Boolean(value)}
        >
          <span className="toggle-knob" />
        </button>
      )

    case 'color':
      return (
        <input
          id={id}
          className="setting-color"
          type="color"
          value={typeof value === 'string' ? value : '#000000'}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={disabled}
        />
      )

    case 'password':
      return <PasswordInput id={id} value={typeof value === 'string' ? value : ''} onChange={(v) => onChange?.(v)} disabled={disabled} placeholder={placeholder} />

    case 'time':
      return (
        <input
          id={id}
          className="setting-input setting-input-time"
          type="time"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={disabled}
        />
      )

    case 'custom':
      return <>{children}</>

    default:
      return null
  }
}

/** 带显示/隐藏切换的密码输入框 */
function PasswordInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id?: string
  value: string
  onChange: (next: string) => void
  disabled: boolean
  placeholder?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="setting-password">
      <input
        id={id}
        className="setting-input"
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button
        type="button"
        className="setting-password-toggle"
        onClick={() => setShow((v) => !v)}
        disabled={disabled}
        // R20 修复 (medium a11y)：原仅 title，screen reader 读 emoji 字面
        // 「see-no-evil monkey」。加 aria-label + aria-pressed 让 SR 用户
        // 知道按钮用途和当前状态。
        aria-label={show ? '隐藏密码' : '显示密码'}
        aria-pressed={show}
        title={show ? '隐藏' : '显示'}
      >
        {show ? '🙈' : '👁'}
      </button>
    </div>
  )
}
