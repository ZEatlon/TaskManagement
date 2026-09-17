/**
 * TaskPilot UI —— Modal（基于 @radix-ui/react-dialog）
 *
 * 设计目标：
 *   - 给所有 dialog 提供一致的入口；和 alert-dialog.tsx 保持同款依赖风格
 *     （Radix Dialog + Tailwind 工具类 + 现有 CSS 变量）
 *   - 支持两种用法：
 *       1) 简洁 API：<Modal open title="..." footer={...}>body</Modal>
 *       2) 子组件 API：<Modal open><ModalHeader><ModalTitle .../>...
 *                    </ModalHeader><ModalBody>...</ModalBody><ModalFooter>...
 *                    </ModalFooter></Modal>
 *   - size: 'sm' | 'md' | 'lg' 控制对话框宽度（max-width）
 *   - dismissableMask: true（默认）时点击遮罩关闭；为 false 时只能 Esc / 关闭按钮
 *   - 内置右上角关闭按钮；按 Esc 关闭
 *   - 支持嵌套 <form>：ModalBody 内若有 form，Enter 会触发该 form 的默认 submit
 *     （Radix Dialog 不会拦截表单事件）
 *
 * 注意：背景动画和遮罩淡入通过 index.css 已有的 modal-fade-in /
 * modal-scale-in 关键帧提供 —— 只要加 .modal-overlay / .modal-content 类即可。
 */
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from '@renderer/lib/icon'
import { cn } from '@renderer/lib/utils'

/* ============================================================
 * Radix Dialog 命名空间绑定 —— 与 alert-dialog.tsx 同款风格
 * ============================================================ */
const Dialog = DialogPrimitive.Root
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

/* ============================================================
 * Modal —— 入口组件
 * ============================================================ */
export type ModalSize = "sm" | "md" | "lg"

export interface ModalProps {
  /** 受控开关 */
  open: boolean
  /** 状态变化回调（点遮罩 / Esc / 关闭按钮都会触发） */
  onOpenChange: (open: boolean) => void
  /** 简短标题：传了就在内置 header 渲染 ModalTitle */
  title?: React.ReactNode
  /** 副标题 / 描述：传了就在标题下方渲染 ModalDescription */
  description?: React.ReactNode
  /** 底部操作区（如 Cancel / Confirm 按钮组） */
  footer?: React.ReactNode
  /** 对话框尺寸 */
  size?: ModalSize
  /** 点击遮罩是否关闭（默认 true；为 false 时只能 Esc / 右上角 ✕） */
  dismissableMask?: boolean
  /** 是否展示右上角 ✕ 按钮（默认 true） */
  showCloseButton?: boolean
  /** 自定义 className 追加到内容容器 */
  className?: string
  /** 内容（也可与 title/footer 并存：会作为 body 渲染） */
  children?: React.ReactNode
}

/* ============================================================
 * 子组件导出
 * ============================================================ */
const ModalOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'modal-overlay fixed inset-0 z-50 bg-black/60',
      className,
    )}
    {...props}
  />
))
ModalOverlay.displayName = 'ModalOverlay'

const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    size?: ModalSize
    onInteractOutside?: (e: Event) => void
  }
>(({ className, children, size = 'md', onInteractOutside, ...props }, ref) => (
  <DialogPortal>
    <ModalOverlay />
    <DialogPrimitive.Content
      ref={ref}
      onInteractOutside={onInteractOutside}
      className={cn(
        'modal-content fixed left-[50%] top-[50%] z-50 grid w-full translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-bg-elevated shadow-lg duration-150 sm:rounded-lg',
        // padding 留在 ModalBody 控制；这里只管外框 + 圆角
        size === 'sm' && 'max-w-[360px]',
        size === 'md' && 'max-w-[480px]',
        size === 'lg' && 'max-w-[640px]',
        // 留出顶部 36px 给 ✕ 按钮，避免内容与之重叠
        'pt-6 pb-4 px-5',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
))
ModalContent.displayName = 'ModalContent'

/* Header —— 标题 + 描述区 */
function ModalHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-2 text-left pr-6', className)}
      {...props}
    />
  )
}
ModalHeader.displayName = 'ModalHeader'

/* Title */
const ModalTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-base font-semibold text-text-primary leading-snug',
      className,
    )}
    {...props}
  />
))
ModalTitle.displayName = 'ModalTitle'

/* Description */
const ModalDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(
      'text-sm text-text-secondary leading-relaxed',
      className,
    )}
    {...props}
  />
))
ModalDescription.displayName = 'ModalDescription'

/* Body —— 主体内容区（可放 form / 列表 / 任何 children） */
const ModalBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-sm text-text-primary', className)}
    {...props}
  />
))
ModalBody.displayName = 'ModalBody'

/* Footer —— 操作按钮行 */
function ModalFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-row justify-end gap-2 pt-2 border-t border-border/60 mt-2',
        className,
      )}
      {...props}
    />
  )
}
ModalFooter.displayName = 'ModalFooter'

/* ============================================================
 * 完整 Modal —— 组合 Open + Overlay + Content + 自动 Header/Footer
 * ============================================================ */
function ModalRoot(props: ModalProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    footer,
    size = 'md',
    dismissableMask = true,
    showCloseButton = true,
    className,
    children,
  } = props

  // dismissableMask=false 时拦截外侧点击事件，避免 Radix 默认的 onInteractOutside
  // 关闭对话框。注意：拦截只对外侧 PointerDown 事件生效，键盘 Esc 仍能关闭。
  const handleInteractOutside = React.useCallback(
    (e: Event) => {
      if (!dismissableMask) {
        e.preventDefault()
      }
    },
    [dismissableMask],
  )

  const showHeader = title != null || description != null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ModalContent
        size={size}
        onInteractOutside={handleInteractOutside}
        className={className}
      >
        {showHeader && (
          <ModalHeader>
            {title != null && <ModalTitle>{title}</ModalTitle>}
            {description != null && (
              <ModalDescription>{description}</ModalDescription>
            )}
          </ModalHeader>
        )}

        <ModalBody>{children}</ModalBody>

        {footer != null && <ModalFooter>{footer}</ModalFooter>}

        {showCloseButton && (
          <DialogPrimitive.Close
            type="button"
            aria-label="关闭"
            className={cn(
              'absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md',
              'text-text-secondary hover:text-text-primary hover:bg-bg-overlay',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <X size={16} aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </ModalContent>
    </Dialog>
  )
}

/* ============================================================
 * 对外导出
 * ============================================================ */
export {
  ModalRoot as Modal,
  ModalHeader,
  ModalTitle,
  ModalDescription,
  ModalBody,
  ModalFooter,
  // 不强制使用，但允许高级用法直接拿 Overlay / Close 自行组合
  ModalOverlay,
  DialogClose as ModalClose,
}

export default ModalRoot