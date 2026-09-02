/**
 * shadcn/ui 通用按钮（带 CVA 变体）
 *
 * 抽出来供 alert-dialog / button / 下一步要加的 DropdownMenu / Sheet 等复用。
 * 颜色 token 通过 tailwind.config.ts 映射到现有 CSS 变量。
 */
import { cva, type VariantProps } from 'class-variance-authority'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
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
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>