/**
 * QuickCaptureOverlay —— 全局「快速新建便签」浮层
 *
 * 设计：
 *   - 任意页面（不依赖 /today 路由）按 `n`（sticky.newGlobal）唤起
 *   - 一个小型居中卡片，单 input（标题）+ 可选 priority 下拉（默认 p2）
 *     + 可选 dueAt 时间选择（datetime-local）；右上角有关闭按钮
 *   - Enter 提交；Esc 关闭；Cmd/Ctrl+Enter 直接保存并关闭（与 Enter 同义
 *     —— quick capture 设计意图就是「少操作立刻存」）
 *   - 提交后：
 *       1) 调 useStickyNotesStore.getState().create(...) 落库。store 内部
 *          负责：占位 placeholder 写入 byDate+all 并经 sortNotes 排序；
 *          连续连点去重（key=`c:${title}|${date}`）；inflightOps +
 *          bumpNoteVersion 标记新 note 为飞行中让并发的 loadAllFiltered
 *          不覆盖占位。直接走 stickyNotesApi.create 会绕过这些机制，
 *          导致 ~50-200ms IPC await 期间 note 不在 byDate/all，路由到
 *          /today 后可能看不到新便签，且 p0 排在已有 p3 之后（直到下次
 *          fetchRange 才被 sortNotes 重新对齐）。
 *       2) 路由导航到 /today（确保新便签所在日期的 section 可见）
 *       3) 关闭浮层
 *
 * 输入焦点策略：
 *   - 浮层挂载 → 自动 focus title input
 *   - Esc / 点遮罩 → 关闭
 *   - 在浮层 input 内按 n 不会再次触发——useShortcut 的 isEditableTarget
 *     守卫默认跳过 input 焦点时的单字母快捷键
 *
 * 集成方式：
 *   - 在 __root.tsx 里挂一次（与 CommandBar / CreateNoteConfirmDialog 同级）
 *   - 自身在 window 上挂 keydown 监听 'n'，独立于 useShortcut hook
 *     （hook 只在 TodayRoute 挂载时激活；overlay 才是真正的全局入口）
 *   - 接收自定义事件 'taskpilot:quick-capture-open' 让 useStickyShortcuts
 *     的 onNewGlobal 与本 overlay 共用同一入口，避免「/today 内按 n 又
 *     触发一次」的竞态
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from '@tanstack/react-router'
import { useStickyNotesStore } from '../../stores/stickyNotes'
import { dayKeyOf } from '../../lib/date'
import { announce } from '../common/AriaAnnouncer'
import type { Priority } from '@shared/types'
import { PRIORITIES, PRIORITY_LABEL } from '@shared/lib/priorities'
import { useFocusTrap } from '../../lib/useFocusTrap'
import { isEditableTarget } from '../../lib/useShortcut'

interface DraftState {
  title: string
  priority: Priority
  dueAt: string // YYYY-MM-DDTHH:mm 来自 datetime-local；空字符串表示「不设置」
}

const EMPTY_DRAFT = (): DraftState => ({ title: '', priority: 'p2', dueAt: '' })

/** 把 datetime-local 的字符串（无时区）转成 ISO（视作本地时区 → UTC） */
function localDateTimeToIso(s: string): string | null {
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * 把 store.create 抛出的技术错误翻译成中文友好文案。
 *
 * 历史：R40-fix-quick-capture-raw-error (high error-handling)。
 * 原版直接 `创建失败：${(err as Error).message}` 把 IPC / SQLite / TypeError
 * 的英文 / 技术栈文本甩到用户面前（"SQLITE_BUSY: database is locked"、
 * "Error invoking remote method 'sticky-note:create'..." 等）。修复：常见
 * 错误码 / 子串映射到中文，未识别 → 兜底中文文案。
 */
function translateCreateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lc = raw.toLowerCase()
  // SQLite 常见错误码 / 子串（better-sqlite3 / 系统 errno）
  if (lc.includes('sqlite_busy') || lc.includes('database is locked')) {
    return '数据库繁忙，请稍后重试'
  }
  if (lc.includes('sqlite_full')) {
    return '数据库已满，请清理后重试'
  }
  if (lc.includes('sqlite_corrupt')) {
    return '数据库文件损坏，请尝试重启应用'
  }
  if (
    lc.includes('sqlite_cantopen') ||
    lc.includes('unable to open database') ||
    lc.includes('no such file')
  ) {
    return '无法访问数据库，请检查库目录权限'
  }
  if (lc.includes('sqlite_constraint')) {
    return '数据冲突（重复或字段过长）'
  }
  // Electron IPC 桥接错误（preload 注入失败 / contextIsolation 等）
  if (
    lc.includes('error invoking remote method') ||
    lc.includes('no handler registered') ||
    lc.includes('bridge is not connected')
  ) {
    return '与主进程通信失败，请稍后重试'
  }
  // IPC 入参校验（主进程 handler 抛的 "sticky-note: title exceeds ..."）
  if (lc.includes('sticky-note:')) {
    const m = raw.match(/sticky-note:\s*([^.]+)/i)
    if (m) return `输入有误：${m[1].trim()}`
  }
  // 兜底 —— 永远不再把英文 SDK / 技术栈文本透给用户
  return '创建失败，请重试或查看日志'
}

export function QuickCaptureOverlay() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  // 提交流程可能在 await stickyNotesApi.create 期间被用户 Esc / 点遮罩中断。
  // close() 会把 cancelledRef 置 true；submit() 在 await resolve 后第一时间
  // 校验，避免「DB 已写入但 overlay 已关闭」时仍强跳 router.navigate 到 /today。
  const cancelledRef = useRef(false)

  // R29 修复 (high a11y)：aria-modal 弹窗必须
  //   1) 把 Tab 焦点圈在弹窗内（useFocusTrap），
  //   2) 关闭时把焦点还原给打开前的触发元素（previouslyFocusedRef）。
  // 否则在 NoteEditor 内按 n 打开后 Esc 关闭，焦点丢失到 TipTap 编辑器，
  // 后续按 Cmd+Enter 仍会触发 AI 助手。
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  // quick-capture 只有打开时 modal 才挂载，把 open 作为 active 条件
  useFocusTrap(overlayRef, open)

  const close = useCallback(() => {
    cancelledRef.current = true
    setOpen(false)
    setDraft(EMPTY_DRAFT())
    setError(null)
    setSubmitting(false)
  }, [])

  const openOverlay = useCallback(() => {
    setOpen(true)
    setDraft(EMPTY_DRAFT())
    setError(null)
  }, [])

  // 全局 'n' 监听：与 useShortcut 同款语义，但独立挂在 window 上保证
  // 任意路由（包括 /settings / /notes / /ai）按 n 都能打开。
  //
  // 注意：
  //   - useShortcut hook 在 useStickyShortcuts 里也会监听 n，但仅当
  //     TodayRoute 挂载时（即用户在 /today 时）；其他路由只能靠本监听。
  //   - /today 内同时挂两个监听 → 双触发？不需要：useStickyShortcuts 的
  //     onNewGlobal dispatch 一个自定义事件 'taskpilot:quick-capture-open'
  //     让本 overlay 统一处理入口，本 keydown 直接阻止默认即可避免双触发。
  useEffect(() => {
    if (typeof window === 'undefined') return

    const onKeyDown = (e: KeyboardEvent) => {
      // 仅在 overlay 关闭时响应（打开时由 overlay 自己处理 Enter / Esc）
      if (open) return
      // 跳过 input / textarea / contenteditable：用户可能在输入框里打字。
      // 复用 useShortcut 的 isEditableTarget，保持 input/textarea/select/
      // contenteditable 一份实现，未来扩展 aria-readonly 等场景只需改一处。
      if (isEditableTarget(e.target)) return
      // 跳过任何带 mod 修饰键的按键（mod+n / cmd+n 等仍走 sticky.new 不冲突）
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // 必须是裸 n（不区分大小写）；其它键不响应
      if (e.key !== 'n' && e.key !== 'N') return
      // modal 开启时不抢——CommandBar / 别的浮层打开时跳过
      // （与 useShortcut 的 isModalLayerActive 对齐）
      if (document.body.dataset['quickCaptureSuppressed'] === '1') return
      e.preventDefault()
      openOverlay()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, openOverlay])

  // 自定义事件桥接：让 useStickyShortcuts.onNewGlobal 也能复用同一入口。
  // /today 内按 n 时，hook 会 dispatch 'taskpilot:quick-capture-open'，本
  // overlay 监听它 → 打开。这样避免「hook 触发 onNewGlobal + window 监听
  // 触发 openOverlay」的双重逻辑。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onCustom = () => openOverlay()
    window.addEventListener('taskpilot:quick-capture-open', onCustom as EventListener)
    return () => window.removeEventListener('taskpilot:quick-capture-open', onCustom as EventListener)
  }, [openOverlay])

  // 打开后自动 focus title
  useEffect(() => {
    if (!open) return
    // 下一帧 focus（等 portal 挂载完）
    const id = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  // R29 修复 (high a11y)：打开前记录原始焦点，关闭 / 卸载时还原。
  // 仅依赖 `open`：quick-capture 是单一开关（无中途切换 panel 等），所以
  // 单一 effect 比 ToolConfirmDialog 拆 effect#1/effect#2 更合适。
  //   - open 变 true：记录弹窗弹出前的 activeElement（此时 title 还没自动 focus），
  //     并在 cleanup 里 prev.focus() 还原。
  //   - 组件整体卸载（提交后 router.navigate 切路由）：React 会先跑 effect cleanup，
  //     同样路径还原焦点。
  useEffect(() => {
    if (!open) return
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null
    return () => {
      const prev = previouslyFocusedRef.current
      if (prev && document.contains(prev)) {
        prev.focus()
      }
      previouslyFocusedRef.current = null
    }
  }, [open])

  const submit = useCallback(async () => {
    const trimmed = draft.title.trim()
    if (!trimmed) {
      setError('请输入便签标题')
      titleRef.current?.focus()
      return
    }
    if (submitting) return
    cancelledRef.current = false
    setSubmitting(true)
    setError(null)
    try {
      // 走 store.create 而非 stickyNotesApi.create：store 内部会同步插入
      // 带 tempId 的占位（经 sortNotes 排序）到 byDate / all，并调用
      // bumpNoteVersion + beginOp 让并发的 loadAllFiltered 把这条 note
      // 当作 in-flight 不覆盖；连续连点 create 用 `c:${title}|${date}`
      // 去重。返回真实 StickyNote 后再做后续副作用。
      const note = await useStickyNotesStore.getState().create({
        title: trimmed,
        date: dayKeyOf(new Date()),
        priority: draft.priority,
        dueAt: localDateTimeToIso(draft.dueAt),
        steps: [],
      })
      // 用户在 await 期间按 Esc / 点遮罩：overlay 已关闭，下面副作用
      // （announce、router.navigate）全部跳过。note 已在 DB 落库且 store
      // 已并入 byDate / all，自然进入下次 /today 加载，不会丢失。
      if (cancelledRef.current) return
      announce(`已创建便签 ${note.title}`)
      // 路由到 /today 让新便签所在日期的 section 可见
      try {
        await router.navigate({ to: '/today' })
      } catch (navErr) {
        // 路由失败不阻塞 close；用户至少能看到便签已创建
        console.warn('[quick-capture] navigate to /today failed:', navErr)
      }
      if (cancelledRef.current) return
      close()
    } catch (err) {
      // overlay 已关闭就别在已卸载的组件上 setError / focus
      if (cancelledRef.current) return
      // R40-fix-quick-capture-raw-error：不再把英文 SDK / SQLite / IPC 技术栈
      // 文本直接显示给用户。原始错误进 console / 主进程日志供诊断。
      console.warn('[quick-capture] create failed:', err)
      const friendly = translateCreateError(err)
      setError(friendly)
      // 同步广播给屏幕阅读器（即便 SR 用户看不到 .quick-capture-error）
      announce(friendly, 'assertive')
      setSubmitting(false)
      titleRef.current?.focus()
    }
  }, [draft, submitting, router, close])

  if (!open || typeof document === 'undefined') return null

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    // Enter 提交（input 自身的 Enter 默认会提交 form，preventDefault 兜底）
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return createPortal(
    <div
      ref={overlayRef}
      className="quick-capture-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="新建便签"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        // 点击遮罩关闭（点击卡片本身不冒泡到这里——stopPropagation 在卡片）
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="quick-capture-card" onClick={(e) => e.stopPropagation()}>
        <div className="quick-capture-header">
          <span className="quick-capture-title">新建便签</span>
          <button
            type="button"
            className="quick-capture-close"
            aria-label="关闭"
            onClick={close}
          >
            ×
          </button>
        </div>
        <form
          className="quick-capture-body"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            ref={titleRef}
            type="text"
            className="quick-capture-input"
            placeholder="便签标题…"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            aria-label="便签标题"
            // R43 修复 (LOW input-validation-mismatch)：HTML maxLength 是 UTF-16
            // code units，与 IPC handler 的 Buffer.byteLength(utf8) 上限 500 bytes
            // 不一致 —— 200 个 CJK 字符 ≈ 600 bytes 会触发「title exceeds 500 bytes」。
            // 上限改 160 保证即便 4-byte UTF-8（emoji / 罕用 CJK 扩展 B）也 ≤ 500 bytes。
            maxLength={160}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="quick-capture-row">
            <label className="quick-capture-field">
              <span className="quick-capture-label">优先级</span>
              <select
                className="quick-capture-select"
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value as Priority }))}
                aria-label="优先级"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="quick-capture-field">
              <span className="quick-capture-label">截止（可选）</span>
              <input
                type="datetime-local"
                className="quick-capture-datetime"
                value={draft.dueAt}
                onChange={(e) => setDraft((d) => ({ ...d, dueAt: e.target.value }))}
                aria-label="截止时间"
              />
            </label>
          </div>
          {error && (
            <div className="quick-capture-error" role="alert">
              {error}
            </div>
          )}
          <div className="quick-capture-footer">
            <span className="quick-capture-hint">Enter 保存 · Esc 关闭</span>
            <button
              type="submit"
              className="quick-capture-submit"
              disabled={submitting}
              aria-label="保存便签"
            >
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

export default QuickCaptureOverlay