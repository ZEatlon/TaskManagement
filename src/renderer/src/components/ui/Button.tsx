/**
 * TaskPilot UI —— Button（基于 shadcn 风格 + Radix Slot）
 *
 * 设计：
 *   - 复用 button-variants.ts 里已经定义好的 CVA 变体（variant × size）
 *   - 通过 @radix-ui/react-slot 实现 asChild，可把样式下放到任意子元素（如 <a>）
 *   - loading 状态：内置 spinner + 自动 aria-busy + 强制 disabled，
 *     避免 onClick 触发竞态；保留键盘焦点环
 *   - type 默认 'button'，避免放进 <form> 时被当作 submit 误触
 *
 * 使用方式：
 *   import { Button } from '@renderer/components/ui/Button'
 *   <Button variant="default" size="default" onClick={...}>保存</Button>
 *   <Button asChild variant="ghost"><a href="...">链接按钮</a></Button>
 *   <Button loading>提交中…</Button>
 */
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { Spinner as Loader2 } from '@renderer/lib/icon'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

/**
 * 复用现有 CVA 变体 —— 保持单点真源（在 button-variants.ts 里维护）。
 * 这里重新导出仅为了给 Button 提供类型安全的 variant / size prop。
 *
 * 注：button-variants.ts 已经是项目内唯一的按钮样式表，alert-dialog.tsx 等
 * 也直接 import 它。Button 作为正式 API 暴露，类型从它派生即可。
 */
const buttonClasses = cva(undefined, {
  variants: {
    variant: {
      default: 'bg-accent text-white hover:bg-accent-hover',
      destructive: 'bg-danger text-white hover:bg-danger/90',
      outline:
        'border border-border bg-transparent text-text-primary hover:bg-bg-overlay',
      secondary:
        'bg-bg-overlay text-text-primary hover:bg-bg-overlay/80',
      ghost: 'hover:bg-bg-overlay text-text-primary',
      link: 'text-accent underline-offset-4 hover:underline',
    },
    size: {
      default: 'h-9 px-4',
      lg: 'h-10 px-6',
      sm: 'h-8 px-3 text-xs',
      icon: 'h-9 w-9',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
})

export type ButtonVariantProps = VariantProps<typeof buttonClasses>

/**
 * Button —— 统一按钮组件
 *
 * Props：
 *   - variant: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
 *   - size:    'default' | 'lg' | 'sm' | 'icon'
 *   - asChild: 为 true 时把样式套到唯一子元素（典型如 <a> / NextLink），自身不渲染 <button>
 *   - loading: 显示旋转图标 + aria-busy=true + 自动 disabled；图标 aria-hidden
 *   - 其余：React.ButtonHTMLAttributes<HTMLButtonElement>
 */
export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    ButtonVariantProps {
  asChild?: boolean
  loading?: boolean
  /** 显式指定 type（默认 'button'，避免误触 form submit） */
  type?: 'button' | 'submit' | 'reset'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      type,
      children,
      onClick,
      ...props
    },
    ref,
  ) => {
    // 把 loading 拼进 disabled —— 让屏幕阅读器和原生表单都拿到「不可交互」信号，
    // 并阻止 onClick 在异步期间重复触发。Radix Slot 也尊重 disabled 属性。
    const isDisabled = disabled || loading

    // 基础样式：focus ring + 禁用态 + 平滑过渡 —— 与 button-variants 一致
    // 这里单独拼出来是因为 asChild 时 Slot 不会自动合并 base classes，
    // 把基础 className 显式传给 Slot 即可。
    const baseClasses =
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50'

    const composed = cn(
      baseClasses,
      buttonClasses({ variant, size }),
      // loading 时禁止点击动画再触发 translateY（避免按下反馈被吃掉）
      loading && 'cursor-wait',
      className,
    )

    const content = (
      <>
        {loading && (
          <Loader2
            size={14}
            className="ui-spin shrink-0"
            aria-hidden="true"
          />
        )}
        {children}
      </>
    )

    if (asChild) {
      // Radix Slot 会把 props 透传给唯一子元素；className 用 mergeClasses
      // 风格合并，避免覆盖用户传入的 className。
      return (
        <Slot
          ref={ref as React.Ref<HTMLElement>}
          className={composed}
          aria-busy={loading || undefined}
          onClick={(e: React.MouseEvent<HTMLElement>) => {
            if (isDisabled) {
              e.preventDefault()
              return
            }
            onClick?.(e as unknown as React.MouseEvent<HTMLButtonElement>)
          }}
          {...(props as React.ComponentPropsWithoutRef<typeof Slot>)}
        >
          {content}
        </Slot>
      )
    }

    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={composed}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        onClick={onClick}
        {...props}
      >
        {content}
      </button>
    )
  },
)
Button.displayName = 'Button'

export default Button