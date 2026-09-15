/**
 * Inline AI 触发按钮 + 操作菜单（紧凑 ✨ sparkles 按钮 + 弹出菜单）
 *
 * 设计要点：
 *   - 单一组件同时拥有 trigger 按钮与菜单浮层（之前拆成 InlineAIButton +
 *     InlineAIMenu 两个文件造成 prop drilling、无意义复用边界），现在所有
 *     状态（open / activeIdx）都在一棵组件树里管理。
 *   - 浮层不是 portal —— 简单 case 直接 inline 渲染，菜单用 fixed 定位
 *     不会受父级 overflow:hidden 影响（除非父级是 transform 上下文；
 *     实测 StickyNoteCard / NoteEditor / PomodoroTimerPanel 父级都不
 *     是 transform 容器）。
 *   - 不引入 popper / Radix Popover：单 dropdown 简单 case 手算定位就够；
 *     若后续有多种 placement 需求再换 Radix。
 *   - 复用 alert-dialog 的 btn ghost 样式系统作为兜底（避免与 Agent 1
 *     还未建立的 Button.tsx 冲突）；当 Button 已就绪时改用 asChild=Button。
 *
 * 用法：
 *   <InlineAIPicker target="sticky" id={note.id} size="sm" />
 *   <InlineAIPicker target="note" id={currentNote.id} size="md" />
 *   <InlineAIPicker target="pomodoro" id="pomodoro-state" size="sm" />
 *
 * 行为：
 *   - 点击按钮 → 菜单在按钮下方绝对定位展开
 *   - 点击菜单项 → 调 useAiStore.openWithPrompt(prompt) 打开 CommandBar
 *   - 键盘 ↑/↓ 在项间循环、Enter / Space 触发当前项、Esc 关闭、Tab 关闭
 *   - 点击空白处 / Esc → 关闭菜单（Esc 还会把焦点还给触发按钮）
 *
 * 可访问性：
 *   - role="menu" / role="menuitem" / aria-label
 *   - tabIndex={-1} 让菜单项本身不进 Tab 顺序（focus 由父按钮管），
 *     但可被 roving focus 操作
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useAiStore } from '../../stores/ai'
import { isImeComposing } from '../../lib/useImeGuard'

export type InlineAITarget = 'sticky' | 'note' | 'pomodoro'

export interface InlineAIMenuItem {
  /** 显示给用户的标签 */
  label: string
  /** 点击后发给 AI 的 prompt（与渲染端上下文无关的纯文本模板） */
  prompt: string
  /** 鼠标悬停时的副标题（可选，用于解释"AI 续写 = ??"） */
  hint?: string
}

interface Props {
  /** 触发的上下文类型，决定菜单渲染哪些项 */
  target: InlineAITarget
  /** 触发实体的 ID（仅用于菜单 prompt 模板的占位） */
  id: string
  /** 紧凑度：sm = 24px，md = 32px（与 Button size="icon" 一致） */
  size?: 'sm' | 'md'
  /** 自定义 title（鼠标悬停 tooltip） */
  title?: string
  /** 自定义 className */
  className?: string
  /** 视觉变体：ghost = 透明背景 hover 显底色（适合便签 / 笔记工具栏），
   *  solid  = 实色按钮（适合 Pomodoro 这种 primary 区域）。默认 ghost。 */
  variant?: 'ghost' | 'solid'
}

/**
 * 默认菜单项生成。
 * sticky / note / pomodoro 三类 target 各自的"AI 拆解 / 总结 / 规划"模板。
 * 模板仅描述 LLM 的任务，不含用户上下文（用户上下文由 AIContext 在
 * stream.ts 边界注入到 system prompt 末尾，避免 prompt 模板长成不可维护
 * 的 string）。
 */
function buildDefaultItems(target: InlineAITarget, id: string): InlineAIMenuItem[] {
  switch (target) {
    case 'sticky':
      return [
        {
          label: 'AI 拆解步骤',
          prompt: `把这张便签（id=${id}）拆成 3-7 步可执行步骤，每步一行。`,
          hint: '基于便签标题 + 描述拆解可执行步骤',
        },
        {
          label: 'AI 建议优先级',
          prompt: `根据这张便签（id=${id}）的标题与描述，给出 p0/p1/p2/p3 中合适的优先级，并解释 1-2 句原因。`,
          hint: '评估紧急 / 重要程度',
        },
        {
          label: 'AI 润色标题',
          prompt: `把这张便签（id=${id}）的标题润色得更清晰、动词在前、长度 6-12 字；给出 3 个候选并说明取舍。`,
          hint: '让标题一眼看出要做什么',
        },
      ]
    case 'note':
      return [
        {
          label: 'AI 总结',
          prompt: `总结这篇笔记（id=${id}）的要点，输出一份不超过 200 字的摘要，保留关键术语与链接。`,
          hint: '提纲挈领：保留原意与关键信息',
        },
        {
          label: 'AI 续写',
          prompt: `基于当前笔记（id=${id}）的上下文续写下一段；保持同样的人称 / 文风 / Markdown 结构。`,
          hint: '顺着现有段落继续写',
        },
        {
          label: 'AI 重写更正式',
          prompt: `把这篇笔记（id=${id}）改写得更正式、更书面化；保留所有事实信息不变，只调整语气与句式。`,
          hint: '适合给同事 / 客户阅读',
        },
      ]
    case 'pomodoro':
      return [
        {
          label: 'AI 规划本节做什么',
          prompt:
            '根据我今天还没完成的便签 + 当前打开的便签，给我一个接下来这一节番茄钟的具体行动清单（3-5 条）。',
          hint: '基于待办列表给出可立即开始的步骤',
        },
        {
          label: 'AI 解释今日统计',
          prompt:
            '帮我解读一下今天的番茄钟统计：已完成几节 / 失败几节 / 平均专注时长；指出可能的改进点。',
          hint: '把数字翻译成可执行的改进建议',
        },
      ]
    default:
      return []
  }
}

export function InlineAIPicker({
  target,
  id,
  size = 'sm',
  title = 'AI 助手',
  className,
  variant = 'ghost',
}: Props) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const itemRefs = useRef<Array<HTMLLIElement | null>>([])
  // 注意：之前这里有过一个 `aiEnabled = useAiStore(s => s.context ? true : false)`
  // 的占位订阅，但它有两个 bug：
  //   1) s.context 是 AI 流式请求时的 UI 上下文快照（sticky/note/pomodoro），
  //      不是「是否启用了 AI」的信号。真正的启用信号是 s.providers.length > 0
  //      （见 components/dashboard/AIInsightCard.tsx:124）。
  //   2) 即便修了语义，订阅整个 context Map 会让 N 张便签卡的 InlineAIPicker
  //      在任何调用方更新 context 时都重渲染一次，但值又被 void 丢掉了。
  // 当前组件没有「禁用按钮」需求，先彻底移除；以后真要做 disable 时再加
  // `const aiEnabled = useAiStore((s) => s.providers.length > 0)`，并按 primitive
  // 订阅避免无限 re-render。
  const openWithPrompt = useAiStore((s) => s.openWithPrompt)

  const items = buildDefaultItems(target, id)

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      // 不要冒泡到上层（如便签的 click 让 StickyNoteCard 进入"卡片被点击"
      // 状态 / NoteEditor 的 toolbar 不会误触）。
      setOpen((v) => !v)
    },
    [],
  )

  const closeMenu = useCallback(() => {
    setOpen(false)
    // 还焦点给触发按钮
    queueMicrotask(() => buttonRef.current?.focus())
  }, [])

  // 点击浮层外部 / Esc → 关闭
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (menuWrapRef.current && !menuWrapRef.current.contains(t)) {
        setOpen(false)
      }
    }
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMenu()
      }
    }
    // mousedown 比 click 早一帧触发，避免「点空白关闭」与「点菜单项触发」
    // 之间的竞态（如果用 click，可能事件顺序：button click → menu click →
    // doc click；先发生的 menu click 已处理完，再 doc click 关闭菜单，此时
    // 用户已经看到菜单被点中的反馈，关闭体验是一致的；用 mousedown 则更早
    // 一拍关闭，与原生 dropdown 习惯一致）。
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onDocKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onDocKey)
    }
  }, [open, closeMenu])

  // 打开时立即 focus 第一项，便于键盘 Enter 直接触发。
  useEffect(() => {
    if (!open) return
    const el = itemRefs.current[0]
    if (el) {
      // queueMicrotask 让 DOM 完全挂载后再 focus，避免被父级
      // mousedown 的 focus 抢走。
      queueMicrotask(() => el.focus())
    }
    // 不在 cleanup 里 clear —— 卸载时 React 自行处理
  }, [open])

  // 滚到 active 项（如果菜单超出视口）
  useEffect(() => {
    const el = itemRefs.current[activeIdx]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx])

  const handleSelect = (idx: number) => {
    const item = items[idx]
    if (!item) return
    openWithPrompt(item.prompt).catch(() => undefined)
    setOpen(false)
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    // IME 守卫（中文/日文/韩文输入法选词期按 Enter 不应触发菜单激活）
    if (isImeComposing(e)) return
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        setActiveIdx((i) => (i + 1) % Math.max(items.length, 1))
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        setActiveIdx((i) => (i - 1 + items.length) % Math.max(items.length, 1))
        break
      }
      case 'Home': {
        e.preventDefault()
        setActiveIdx(0)
        break
      }
      case 'End': {
        e.preventDefault()
        setActiveIdx(Math.max(items.length - 1, 0))
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        handleSelect(activeIdx)
        break
      }
      case 'Escape': {
        e.preventDefault()
        closeMenu()
        break
      }
      case 'Tab': {
        // Tab 直接关闭菜单（避免焦点逃出菜单后还以为是菜单的一部分）。
        // 走 closeMenu() 而不是 setOpen(false)：与 Esc / mousedown 外部
        // 收敛到同一个关闭入口，焦点会还给触发按钮（a11y 一致性）。
        e.preventDefault()
        closeMenu()
        break
      }
      default:
        break
    }
  }

  const px = size === 'md' ? 6 : 4
  const iconSize = size === 'md' ? 14 : 12

  // 浮层定位：使用 fixed 定位，相对 viewport 在按钮下方展开。
  // R33 修复 (medium #3)：原版在 render 期间同步读 getBoundingClientRect()，
  // 一旦 open 后用户滚动页面 / resize 窗口 / 父容器 reflow，菜单仍死死
  // 钉在首次记录的 viewport 坐标，与按钮脱钩（甚至跨卡片 / 出视口）。
  // 修复：菜单打开时挂 scroll（capture 阶段，因为某些祖先滚动不会
  // bubble）+ resize 监听，把最新 rect 同步到一个 state；用 useLayoutEffect
  // 避免一帧的 (0,0) 闪烁。
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    top: 0,
    left: 0,
    zIndex: 80,
    minWidth: 220,
    maxWidth: 320,
    visibility: 'hidden',
  })
  useLayoutEffect(() => {
    if (!open) {
      // 关闭时重置 visibility，避免下次 open 之前 rect 残留。
      setMenuStyle((s) => ({ ...s, visibility: 'hidden' }))
      return
    }
    const compute = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (!r) return
      setMenuStyle({
        position: 'fixed',
        top: r.bottom + 6,
        left: Math.min(r.left, window.innerWidth - 240),
        zIndex: 80,
        minWidth: 220,
        maxWidth: 320,
        visibility: 'visible',
      })
    }
    compute()
    // capture: true —— 滚动事件不一定会冒泡到 window（祖先有 overflow:auto
    // 的滚动就停在祖先），所以捕获阶段拦截任何祖先的滚动。
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open])

  return (
    <div
      ref={menuWrapRef}
      className={`inline-ai-wrap ${className ?? ''}`}
      style={{ display: 'inline-flex' }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`btn ${variant === 'ghost' ? 'ghost' : 'primary'} inline-ai-btn inline-ai-btn-${size}`}
        onClick={handleClick}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        // 阻止 button 被上层"卡片 click"代理（例如便签卡片的 click 不应
        // 因点击 AI 按钮而被识别为"卡片点击"事件）。
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          padding: `2px ${px}px`,
          lineHeight: 1,
          fontSize: size === 'md' ? '13px' : '12px',
          color: 'var(--ai-glow, #a371f7)',
        }}
      >
        <Sparkles
          size={iconSize}
          aria-hidden="true"
          className="inline-ai-sparkles"
        />
        {size === 'md' && <span className="inline-ai-btn-text">AI</span>}
      </button>
      {open && (
        <ul
          ref={listRef}
          className="inline-ai-menu"
          role="menu"
          aria-label="AI 操作"
          tabIndex={-1}
          style={menuStyle}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, idx) => (
            <li
              key={item.label}
              ref={(el) => {
                itemRefs.current[idx] = el
              }}
              role="menuitem"
              tabIndex={idx === activeIdx ? 0 : -1}
              aria-label={item.hint ? `${item.label}（${item.hint}）` : item.label}
              className={`inline-ai-menu-item ${idx === activeIdx ? 'is-active' : ''}`}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => handleSelect(idx)}
            >
              <span className="inline-ai-menu-icon" aria-hidden>
                ✨
              </span>
              <span className="inline-ai-menu-body">
                <span className="inline-ai-menu-label">{item.label}</span>
                {item.hint && (
                  <span className="inline-ai-menu-hint">{item.hint}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default InlineAIPicker
