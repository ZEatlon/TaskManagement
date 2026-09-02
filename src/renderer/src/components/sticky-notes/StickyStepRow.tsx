/**
 * 便签 Step 行 —— 序号 + checkbox + 拖拽手柄 + 内容 input + 删除
 *
 * 交互：
 *   - checkbox 切换 → onChange({ done })
 *   - 完成一个 step 后显示 3s 内联「撤销」链接，方便误触后回退（用户需求：撤销支持）
 *   - 内容 onBlur → onChange({ content })
 *   - 内容 Enter → onAdd（让父组件在下方插入新 step 并 focus）
 *     ⚠ IME 守卫：中文输入法选词时按 Enter 不应触发 onAdd
 *     （e.nativeEvent.isComposing / keyCode 229）
 *   - 内容 Shift+Enter / Cmd+Enter → 阻止默认
 *   - 内容 Backspace（空内容） → onRemove
 *   - 内容 Esc → 失焦
 *   - HTML5 native drag/drop：拖拽手柄 ⋮⋮ → drop 时调 onChange({ order: targetOrder })
 *
 * 拖拽实现：用原生 HTML5 drag/drop，不引入新依赖。
 *   - draggable={true} 在 .sticky-step-grip 上
 *   - onDragStart 把当前 step 的 id + fromOrder 写入 dataTransfer
 *   - onDragOver preventDefault 才能让 onDrop 触发
 *   - onDrop 时调用 onChange({ order }) 更新排序（仓储 + store 同步）
 */
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { StickyNoteStep, StickyNoteStepPatch } from '@shared/types'

interface Props {
  step: StickyNoteStep
  index: number
  onChange: (patch: StickyNoteStepPatch) => void
  onRemove: () => void
  onAdd?: () => void
  /** 兄弟 step 列表（用于 drop 时计算 order） */
  siblings?: StickyNoteStep[]
  /**
   * 拖拽重排序回调：把 draggedStepId 插入到 targetStepId 之前。
   * 父组件负责批量重排兄弟 steps 的 order，避免撞 order_num。
   */
  onReorder?: (draggedStepId: string, targetStepId: string) => void
}

/** 撤销链接显示时长（毫秒） */
const UNDO_WINDOW_MS = 3500

function StickyStepRowInner({
  step,
  index,
  onChange,
  onRemove,
  onAdd,
  siblings,
  onReorder,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  // R26-a11y-5：稳定的按钮 id 给 aria-describedby 用；同一组件多次渲染
  // 之间 id 保持不变，SR 的关联不丢失。React 18 useId 在 SSR / CSR 均安全。
  const reactId = useId()
  const undoBtnId = `sticky-step-undo-${reactId}`
  const [dragOver, setDragOver] = useState(false)
  const [removing, setRemoving] = useState(false)
  // siblings 由父组件持有并用于 onReorder 回调，这里只占位以保留 prop 兼容性。
  void siblings

  // 撤销支持：标记最近一次「完成操作」的状态
  const [showUndo, setShowUndo] = useState(false)
  const undoTimerRef = useRef<number | null>(null)

  // R31-A11yPerf-3 修复：内容编辑本地草稿 + 300ms debounce。
  const [contentDraft, setContentDraft] = useState(step.content)
  const contentDebTimerRef = useRef<number | null>(null)
  // R32-A11yPerf-4 修复 (HIGH clobber-in-flight-edits)：R31 我自己的实现是
  // 无条件 `useEffect(() => setContentDraft(step.content), [step.content])`。
  // 父组件在用户 300ms debounce 内重新发出 step.content（因为另一个组件
  // 在响应 store 状态 / 同 sticky 其他字段 update 触发的整体重渲染）→
  // step.content 短暂变回「老值」（父还没收到 debounced onChange 之前）→
  // useEffect 把用户已经敲了几个字但还没到 debounce 的 input 内容清掉。
  //
  // 修复：与 StickyNoteCard titleDraft 的 lastSyncedTitleRef 同思路 —— 只
  // 在 step.content 与「上次同步过的值」不同时才覆盖 draft，且不覆盖
  // 「本地 draft 已经被用户改过」的状态。区分两种来源：
  //   (a) 父组件的回填（用户已敲的 → parent echo back）→ 不动 draft
  //   (b) 真正的外部更新（远端合并 / undo 完成 / 切 sticky）→ 同步 draft
  const lastSyncedContentRef = useRef(step.content)
  useEffect(() => {
    // 只有当「上次同步值」与「当前 step.content」不同时才同步 —— 父组件
    // 因自身 onChange 回填导致 step.content === lastSynced 时跳过；切到
    // 别的 step.content 时 lastSynced !== step.content 触发。
    if (lastSyncedContentRef.current !== step.content) {
      lastSyncedContentRef.current = step.content
      setContentDraft(step.content)
    }
  }, [step.content])
  // 组件卸载时清理所有 timer 防 setState-on-unmounted。R32-A11yPerf-9
  // 修复 (MEDIUM scattered-timer-cleanups)：原版有 3 个独立 useEffect 各
  // 自清理一种 timer（contentDebTimerRef / undoTimerRef / removeTimerRef），
  // 每次渲染都新增 effect 注册 / 卸载时 cleanup，3 个 cleanup function
  // 累积注册到 React fiber 的 effect chain。修复：合并成单一 cleanup
  // effect —— React 18 仍允许 effect chain 按声明顺序执行（cleanup 顺序
  // 与声明顺序相反），但减少 hook 数量让组件语义更清晰，且未来新增
  // timer 时有明显的「加进这个 effect」位置。
  useEffect(() => {
    return () => {
      if (contentDebTimerRef.current !== null) {
        window.clearTimeout(contentDebTimerRef.current)
        contentDebTimerRef.current = null
      }
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current)
        undoTimerRef.current = null
      }
      if (removeTimerRef.current !== null) {
        window.clearTimeout(removeTimerRef.current)
        removeTimerRef.current = null
      }
    }
  }, [])

  // 当 step.done 从 true 变 false（外部撤销、例如 store 回滚）→ 自动隐藏撤销链接
  useEffect(() => {
    if (!step.done && showUndo) setShowUndo(false)
  }, [step.done, showUndo])

  const handleToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const nextDone = e.target.checked
      onChange({ done: nextDone })
      // 完成操作才弹撤销；取消完成不弹（语义上「撤销已完成」才有意义）
      if (nextDone) {
        setShowUndo(true)
        if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
        undoTimerRef.current = window.setTimeout(() => {
          setShowUndo(false)
          undoTimerRef.current = null
        }, UNDO_WINDOW_MS)
      } else if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current)
        undoTimerRef.current = null
        setShowUndo(false)
      }
    },
    [onChange],
  )

  const handleUndo = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current)
      undoTimerRef.current = null
    }
    setShowUndo(false)
    onChange({ done: false })
  }, [onChange])

  const handleContent = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // R31-A11yPerf-3 修复 (HIGH per-keystroke-IPC)：原版 onChange 每个
      // 键击触发一次 → 一次 IPC + 一次 SQLite 写入 + 一次 store 更新 →
      // 30 字符的 step 内容 = 30 次端到端往返，timeline 重渲染级联。
      // 父组件 title 字段已经在 blur 时保存（patch-on-blur），保持一致：
      // 本地 contentDraft 立即更新让 input 流畅响应，300ms debounce 后
      // 再把最终值传上去。blur 时也强制 flush 防丢字。
      //
      // R32-A11yPerf-4 修复（补）：debounce 触发 onChange 时把
      // lastSyncedContentRef 标记为新值 —— 父组件 store echo back 同样
      // 的值时 useEffect 跳过（lastSynced === step.content），避免重新
      // 覆盖正在编辑的 draft。
      const v = e.target.value
      setContentDraft(v)
      if (contentDebTimerRef.current !== null) {
        window.clearTimeout(contentDebTimerRef.current)
      }
      contentDebTimerRef.current = window.setTimeout(() => {
        contentDebTimerRef.current = null
        if (v !== step.content) {
          lastSyncedContentRef.current = v
          onChange({ content: v })
        }
      }, 300)
    },
    [onChange, step.content],
  )

  // R31-A11yPerf-3 修复补充：blur 时 flush 防丢字。
  // R32-A11yPerf-4 修复（补）：blur 真正触发 onChange 时也把
  // lastSyncedContentRef 标记新值。
  const handleContentBlur = useCallback(() => {
    if (contentDebTimerRef.current !== null) {
      window.clearTimeout(contentDebTimerRef.current)
      contentDebTimerRef.current = null
    }
    if (contentDraft !== step.content) {
      lastSyncedContentRef.current = contentDraft
      onChange({ content: contentDraft })
    }
  }, [contentDraft, onChange, step.content])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // IME 守卫：中文输入法选词时按 Enter 会先触发 compositionend，
      // 此时 keyCode === 229，且 nativeEvent.isComposing === true。
      // 此场景下不应触发 onAdd（否则输入法的拼音/上屏都会被当成新步骤）。
      const isComposing =
        e.nativeEvent.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229

      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !isComposing
      ) {
        e.preventDefault()
        onAdd?.()
      } else if (
        e.key === 'Backspace' &&
        step.content === '' &&
        e.currentTarget.selectionStart === 0
      ) {
        e.preventDefault()
        handleRemoveWithAnimation()
      } else if (e.key === 'Escape') {
        e.currentTarget.blur()
      } else if (
        // R8A-3：ArrowUp / ArrowDown 在光标位于首/末位置时跳到上/下一条 step。
        // 仅当用户没按 Shift / Alt / Meta / Ctrl 才触发，避免与重排快捷键冲突。
        (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        const target = e.currentTarget
        const atStart = target.selectionStart === 0 && target.selectionEnd === 0
        const atEnd =
          target.selectionStart === target.value.length &&
          target.selectionEnd === target.value.length
        if ((e.key === 'ArrowUp' && atStart) || (e.key === 'ArrowDown' && atEnd)) {
          // R10 修复：原版用 document.querySelectorAll('.sticky-step-content')，
          // 会拿到页面上**所有便签**的 step input，光标在 A 便签最后一步按 ↓
          // 焦点会跳到 B 便签的第一步，违反"同一便签内导航"的直觉。改用
          // closest('.sticky-step-list') 把查找范围限制到当前便签的 step 容器。
          const list = target.closest<HTMLElement>('.sticky-step-list')
          if (!list) return
          const all = Array.from(
            list.querySelectorAll<HTMLInputElement>('.sticky-step-content'),
          )
          const i = all.indexOf(target)
          if (i >= 0) {
            const ni = e.key === 'ArrowUp' ? i - 1 : i + 1
            if (ni >= 0 && ni < all.length) {
              e.preventDefault()
              all[ni].focus()
            }
          }
        }
      } else if (
        // R8A-4：Alt+ArrowUp / Alt+ArrowDown 重排（与拖拽手柄等价）。
        // 只对父组件提供了 onReorder 的情形生效；否则放行让默认行为（首/末移动光标）。
        e.altKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        !e.metaKey &&
        !e.ctrlKey &&
        onReorder
      ) {
        e.preventDefault()
        // R10 修复：同上，把查找范围限定到当前便签的 step-list 容器，
        // 避免 Alt+↓ 跨便签触发"重排到下一便签的 step" 的诡异行为。
        const draggedRow = e.currentTarget.closest<HTMLElement>('[data-step-id]')
        const list = draggedRow?.closest<HTMLElement>('.sticky-step-list')
        if (!list) return
        const all = Array.from(
          list.querySelectorAll<HTMLInputElement>('.sticky-step-content'),
        )
        const i = all.indexOf(e.currentTarget)
        if (i >= 0) {
          const ni = e.key === 'ArrowUp' ? i - 1 : i + 1
          if (ni >= 0 && ni < all.length) {
            const targetRow = all[ni].closest<HTMLElement>('[data-step-id]')
            const targetId = targetRow?.dataset['stepId']
            const draggedId = draggedRow?.dataset['stepId']
            if (targetId && draggedId && targetId !== draggedId) {
              onReorder(draggedId, targetId)
            }
          }
        }
      }
    },
    [onAdd, step.content, onReorder], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // R5-24：组件卸载时 clearTimeout，否则 step 在动画期间被父组件卸载，
  // setTimeout 仍会调 onRemove 触发"幽灵删除"。
  const removeTimerRef = useRef<number | null>(null)
  const handleRemoveWithAnimation = useCallback(() => {
    setRemoving(true)
    if (removeTimerRef.current !== null) {
      window.clearTimeout(removeTimerRef.current)
    }
    // 180ms 后再真删（CSS 动画时长）
    removeTimerRef.current = window.setTimeout(() => {
      removeTimerRef.current = null
      onRemove()
    }, 180)
  }, [onRemove])

  // 拖拽：开始时把当前 id 写入 dataTransfer；放下时计算目标 order
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLSpanElement>) => {
      e.dataTransfer.setData('text/sticky-step-id', step.id)
      e.dataTransfer.setData('text/sticky-step-from-order', String(step.order))
      e.dataTransfer.effectAllowed = 'move'
    },
    [step.id, step.order],
  )

  const handleDragOver = useCallback((e: React.DragEvent<HTMLLIElement>) => {
    // R5R-6：先检查 MIME，非 sticky-step 拖拽直接放行（不 preventDefault，
    // 不显示 drop 高亮），否则任意元素拖到 step 上都会触发 is-drop-target。
    if (!e.dataTransfer.types.includes('text/sticky-step-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOver) setDragOver(true)
  }, [dragOver])

  const handleDragLeave = useCallback(() => setDragOver(false), [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLLIElement>) => {
      // R5R-6：同样守 MIME，避免 OS 文件 / 笔记 / 文本选择等被错认。
      if (!e.dataTransfer.types.includes('text/sticky-step-id')) return
      e.preventDefault()
      setDragOver(false)
      const draggedId = e.dataTransfer.getData('text/sticky-step-id')
      if (!draggedId || draggedId === step.id) return
      // 优先调用父组件提供的批量重排回调，由其保证不撞 order；
      // 若父组件未提供，则降级为只更新目标 step 的 order（保留旧行为）。
      if (onReorder) {
        onReorder(draggedId, step.id)
      } else {
        onChange({ order: step.order })
      }
    },
    [step.id, onChange, onReorder],
  )

  return (
    <li
      className={`sticky-step-row${step.done ? ' is-done' : ''}${dragOver ? ' is-drop-target' : ''}${removing ? ' is-removing' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      draggable={false}
      data-step-id={step.id}
    >
      <span
        className="sticky-step-grip"
        draggable
        onDragStart={handleDragStart}
        aria-hidden
        title="拖动排序"
      >
        ⋮⋮
      </span>
      <input
        ref={inputRef}
        type="checkbox"
        className="sticky-step-checkbox"
        checked={step.done}
        onChange={handleToggle}
        // R12 修复 (medium)：aria-label 只说"步骤 N 完成"对多个相似步骤难以区分，
        // 加上步骤内容片段（前 40 字）让屏幕阅读器能识别。
        //
        // R26-a11y-5 修复 (medium aria-describedby)：原版 checkbox 与「撤销
        // 完成」按钮之间无任何程序关联。SR 用户勾选步骤后听不到「5 秒内可
        // 撤销」的提示，只能 Tab 才能发现按钮。补 aria-describedby 指向
        // 同 row 的撤销按钮 id；undo 出现时屏幕阅读器把按钮说明一并念出来。
        aria-label={`步骤 ${index + 1}（${(step.content ?? '').slice(0, 40)}）${step.done ? '已完成' : '未完成'}`}
        aria-describedby={showUndo ? undoBtnId : undefined}
      />
      <span className="sticky-step-order" aria-hidden>
        {index + 1}.
      </span>
      <input
        type="text"
        className="sticky-step-content"
        // R31-A11yPerf-3 修复：用 contentDraft（本地态）渲染让 input 即时
        // 响应键击，300ms debounce 后再 patch 到父组件 + DB。onBlur 同步
        // flush 防丢字（用户连击 / IME 选词立刻切焦点）。
        value={contentDraft}
        onChange={handleContent}
        onBlur={handleContentBlur}
        onKeyDown={handleKeyDown}
        placeholder="步骤内容..."
        aria-label={`步骤 ${index + 1}`}
      />
      {showUndo && (
        <button
          id={undoBtnId}
          type="button"
          className="sticky-step-undo"
          onClick={handleUndo}
          // R26-a11y-5 修复：见 checkbox 注释 —— 把 id 与 aria-describedby
          // 关联，让 SR 在勾选步骤时同步提示「5 秒内可撤销」。
          aria-label="撤销完成（5 秒内可点此恢复未完成状态）"
          title="撤销完成"
        >
          撤销
        </button>
      )}
      <button
        type="button"
        className="sticky-step-remove"
        onClick={handleRemoveWithAnimation}
        title="删除步骤"
        aria-label="删除步骤"
      >
        ×
      </button>
    </li>
  )
}

/**
 * React.memo 包裹的 StickyStepRow。
 *
 * 性能要点（Perf-fix #7）：
 *   - 单条 sticky 可能有 5+ steps；timeline 视图一次渲染 600+ 卡 → 数千 step rows
 *   - 父组件（StickyNoteCard）任意 state 变化（hover、isNew 切换、status 编辑）都会触发
 *     本卡片的所有 step row 重渲染，即使 step data 本身没变
 *   - comparator 只比较 `step` 引用 + `index` + `siblings` 引用；handler refs（onChange
 *     /onRemove/onAdd/onReorder）由父组件 inline arrow 每次渲染新建，忽略其引用；
 *     handler 行为依赖 store 状态，行为对相同 step 是一致的
 *   - 这是 R32-A11yPerf 系列优化后的延续 —— 已有 debounced content 写入 + lastSyncedContentRef
 *     防 clobber，配合 memo 让单个 step 的 300ms debounce 周期内整个 row 不重渲染
 */
export const StickyStepRow = memo(
  StickyStepRowInner,
  (prev, next) =>
    prev.step === next.step &&
    prev.index === next.index &&
    prev.siblings === next.siblings,
)