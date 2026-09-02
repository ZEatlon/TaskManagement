/**
 * 番茄钟页面的顶部日期 Header
 *
 * 设计：
 * - 大字显示「8月31日，星期一」
 * - 下方小字显示农历「七月十九」（节气时显示节气，如「立秋」）
 * - 右侧 ▼ 下拉菜单：日期选择器 + "回到今天"
 *
 * 交互：
 * - 点击 ▼ 展开自定义下拉（包含 native date input 和快捷按钮）
 * - 点击外部区域自动收起
 */
import { useEffect, useRef, useState } from 'react'
import { solarToLunar, weekdayName } from '../../lib/lunar'

interface FocusDateHeaderProps {
  date: Date
  onChangeDate: (date: Date) => void
  /** 是否处于运行中（影响视觉） */
  isRunning?: boolean
}

export function FocusDateHeader({ date, onChangeDate, isRunning }: FocusDateHeaderProps) {
  const lunar = solarToLunar(date)
  const weekday = weekdayName(date, 1) // 周一为首
  const month = date.getMonth() + 1
  const day = date.getDate()

  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const dateInputRef = useRef<HTMLInputElement | null>(null)
  const toggleButtonRef = useRef<HTMLButtonElement | null>(null)
  // R17 修复 (high a11y)：曾「打开过 popover」才在关闭时还焦点。初始 open=false
  // 直接命中 toggleButtonRef.focus() 会从页面标题 / 其它上下文抢走焦点（首次
  // 挂载瞬间），违反 WAI-ARIA APG dialog pattern。
  const hasOpenedRef = useRef(false)
  // R13 修复 (medium)：打开 popover 时把焦点送入日期输入框；关闭时还原
  // 到 toggle 按钮。键盘用户开/关后都能继续按 Tab 操作。
  // R16 修复 (medium)：原版仅当「关闭瞬间 activeElement 恰好等于 dateInputRef」才
  // 还焦点 —— 用户点「回到今天」后焦点在那个按钮上（不是 dateInputRef），popover
  // 卸载后 activeElement 落到 document.body，焦点丢失；键盘用户必须 Tab 多次才能
  // 恢复。改为无条件还焦点到 toggleButtonRef（无论用户关 popover 时焦点在哪里）。
  useEffect(() => {
    if (!open) {
      // R17：仅当曾经打开过才还焦点，避免首次挂载瞬间抢焦点
      if (hasOpenedRef.current) {
        toggleButtonRef.current?.focus()
      }
      return
    }
    hasOpenedRef.current = true
    // R18 修复 (medium ux)：把 Esc 监听从 document 收窄到 popoverRef 根节点。
    // R17 挂在 document 上会和 CommandBar 的 window+capture 监听撞优先级，
    // 且 pomodoro 页同时还可能有其它 modal（CreateNoteConfirmDialog /
    // settings 编辑等），任意 modal 的 Esc 都会顺带把 popover 关掉。
    // 改为 popover 根 div 上的 onKeyDown：popover 没拿到焦点时不会触发。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    const popover = popoverRef.current
    popover?.addEventListener('keydown', onKey)
    // 等下一帧再 focus，popover 还没挂载
    const id = window.requestAnimationFrame(() => {
      dateInputRef.current?.focus()
    })
    return () => {
      popover?.removeEventListener('keydown', onKey)
      window.cancelAnimationFrame(id)
    }
  }, [open])

  // 点外面收起
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const dateInputValue = `${date.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    if (!v) return
    const [y, m, d] = v.split('-').map((s) => parseInt(s, 10))
    onChangeDate(new Date(y, (m ?? 1) - 1, d ?? 1))
    setOpen(false)
  }

  function goToday() {
    onChangeDate(new Date())
    setOpen(false)
  }

  // 副标题：优先节气 → 否则农历「月份 + 日期」
  const subLabel = lunar.term
    ? `${lunar.term}`
    : lunar.isLeap && lunar.day === 1
      ? `闰${lunar.monthName}初${lunar.day}`
      : `${lunar.monthName}${lunar.dayName}`

  return (
    <div className={['focus-date-header', isRunning ? 'is-running' : ''].filter(Boolean).join(' ')}>
      <div className="focus-date-main">
        <div className="focus-date-row1">
          <span className="focus-date-md">
            {month}月{day}日
          </span>
          <span className="focus-date-weekday">{weekday}</span>
        </div>
        <div className="focus-date-row2">
          <span className="focus-date-lunar">{subLabel}</span>
        </div>
      </div>

      <div className="focus-date-dropdown" ref={popoverRef}>
        <button
          ref={toggleButtonRef}
          type="button"
          className="focus-date-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="日期选项"
        >
          <span className="focus-date-caret">▼</span>
        </button>

        {open && (
          <div className="focus-date-popover" role="dialog" aria-modal="false">
            <label className="focus-date-popover-label">
              <span>选择日期</span>
              <input
                ref={dateInputRef}
                type="date"
                value={dateInputValue}
                onChange={handlePick}
                className="focus-date-input"
              />
            </label>
            <button type="button" className="focus-date-today" onClick={goToday}>
              回到今天
            </button>
          </div>
        )}
      </div>
    </div>
  )
}