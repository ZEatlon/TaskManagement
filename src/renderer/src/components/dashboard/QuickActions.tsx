/**
 * 快捷操作
 *
 * 三个常驻入口按钮（每按钮 ≈ 56–64px 高），集中在 dashboard Row 4 顶部：
 *   1. 新建便签 → useStickyNotesStore.create(今日日期)
 *   2. 新建笔记 → useNotesStore.create（成功后导航到 /notes）
 *   3. 开始番茄钟 → 触发 pomodoro.start + 导航到 /today
 *
 * 历史说明：曾有 "全局搜索" tile，但该路由从未实现；tile 一直是 disabled
 * 占位，会误导用户以为该功能存在。已下线；后续若实现真正的跨实体搜索
 * （搜索便签 + 笔记 + 番茄），再加回。
 *
 * 图标 lucide-react；按钮走中性化样式（无 box-shadow / transform）。
 */
import { useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  FilePlus2,
  NotebookPen,
  Play,
  type LucideIcon,
} from 'lucide-react'
import { dayKeyOf } from '../../lib/date'
import { useStickyNotesStore } from '../../stores/stickyNotes'
import { useNotesStore } from '../../stores/notes'
import { usePomodoroStore } from '../../stores/pomodoro'

interface QuickAction {
  key: string
  label: string
  description: string
  icon: LucideIcon
  disabled?: boolean
  onClick: () => void | Promise<void>
}

interface Props {
  /** 触发后回调（例如用于关闭任何侧边面板） */
  onAfterAction?: () => void
}

export function QuickActions({ onAfterAction }: Props) {
  const navigate = useNavigate()
  const createSticky = useStickyNotesStore((s) => s.create)
  const createNote = useNotesStore((s) => s.create)
  const startPomodoro = usePomodoroStore((s) => s.start)
  const [busy, setBusy] = useState<string | null>(null)

  const handleNewSticky = useCallback(async () => {
    if (busy) return
    setBusy('sticky')
    try {
      await createSticky({
        title: '',
        description: '',
        date: dayKeyOf(new Date()),
        priority: 'p1',
        steps: [],
      })
      // 新建后导航到今日页，让用户看到新便签
      navigate({ to: '/today' })
      onAfterAction?.()
    } catch {
      // 静默失败；用户可在今日页重试
    } finally {
      setBusy(null)
    }
  }, [busy, createSticky, navigate, onAfterAction])

  const handleNewNote = useCallback(async () => {
    if (busy) return
    setBusy('note')
    try {
      await createNote()
      navigate({ to: '/notes' })
      onAfterAction?.()
    } catch {
      // 同上
    } finally {
      setBusy(null)
    }
  }, [busy, createNote, navigate, onAfterAction])

  const handleStartPomodoro = useCallback(async () => {
    if (busy) return
    setBusy('pomodoro')
    try {
      await startPomodoro()
      navigate({ to: '/today' })
      onAfterAction?.()
    } catch {
      // 静默
    } finally {
      setBusy(null)
    }
  }, [busy, startPomodoro, navigate, onAfterAction])

  const actions: QuickAction[] = [
    {
      key: 'sticky',
      label: '新建便签',
      description: '快速记录今日待办',
      icon: FilePlus2,
      onClick: handleNewSticky,
    },
    {
      key: 'note',
      label: '新建笔记',
      description: '在笔记库开新文档',
      icon: NotebookPen,
      onClick: handleNewNote,
    },
    {
      key: 'pomodoro',
      label: '开始番茄钟',
      description: '聚焦当前任务',
      icon: Play,
      onClick: handleStartPomodoro,
    },
  ]

  return (
    <div className="quick-actions" role="toolbar" aria-label="快捷操作">
      {actions.map((a) => {
        const Icon = a.icon
        return (
          <button
            key={a.key}
            type="button"
            className="btn ghost quick-action-btn"
            onClick={a.onClick}
            disabled={a.disabled || busy !== null}
            aria-disabled={a.disabled || busy !== null}
            title={a.description}
          >
            <Icon size={14} aria-hidden />
            <span className="quick-action-label">{a.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export default QuickActions