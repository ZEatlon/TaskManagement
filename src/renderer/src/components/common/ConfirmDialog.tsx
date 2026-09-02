/**
 * 通用确认对话框（基于 shadcn/ui AlertDialog）
 *
 * 替换原生的 `confirm()` 与 `alert()`，使提示与暗色主题保持一致。
 *
 * 使用方式（API 与迁移前完全一致）：
 *
 * ```tsx
 * const [pending, setPending] = useState<{title, body, onConfirm} | null>(null)
 * <ConfirmDialog
 *   open={pending !== null}
 *   title={pending?.title ?? ''}
 *   body={pending?.body ?? ''}
 *   confirmLabel="删除"
 *   tone="danger"
 *   onCancel={() => setPending(null)}
 *   onConfirm={() => { pending?.onConfirm(); setPending(null) }}
 * />
 * ```
 */
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialog as ShadcnAlertDialog,
} from '@renderer/components/ui/alert-dialog'
import { cn } from '@renderer/lib/utils'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <ShadcnAlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {body != null && (
            <AlertDialogDescription asChild>
              <div>{body}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              tone === 'danger' &&
                'bg-danger text-white hover:bg-danger/90',
            )}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </ShadcnAlertDialog>
  )
}

export default ConfirmDialog