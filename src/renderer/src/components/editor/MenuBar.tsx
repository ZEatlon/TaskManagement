/**
 * MenuBar - TipTap 工具栏
 *
 * 分组：
 *   1. 撤销/重做
 *   2. 标题 H1-H6、段落
 *   3. 加粗/斜体/下划线/删除线/行内代码
 *   4. 上标/下标/高亮/颜色
 *   5. 无序/有序列表/任务列表/引用
 *   6. 链接/图片/代码块/表格
 *   7. 公式 (行内/块级 KaTeX)、Mermaid 图表
 *   8. 水平线、清除格式
 *
 * 当前激活格式通过 editor.isActive() 检测并高亮按钮。
 */
import { type Editor } from '@tiptap/react'
import { useCallback } from 'react'

interface Props {
  editor: Editor | null
  /** 是否禁用整个工具栏（只读态） */
  disabled?: boolean
  /** 自定义图片按钮触发（点击工具栏图片按钮时调用），用于弹出文件选择器 */
  onPickImage?: () => void
}

interface ButtonDef {
  key: string
  title: string
  label: string
  isActive?: () => boolean
  isDisabled?: () => boolean
  onClick: () => void
}

function Divider() {
  return <div className="editor-toolbar-divider" />
}

export function MenuBar({ editor, disabled = false, onPickImage }: Props) {
  // 公共判定：当前光标是否在指定 level 标题内
  const isHeadingActive = useCallback(
    (level: 1 | 2 | 3 | 4 | 5 | 6) => {
      if (!editor) return false
      return editor.isActive('heading', { level })
    },
    [editor],
  )

  // ===== 通用 prompt 工具 =====
  const promptText = useCallback(
    (msg: string, defaultValue = ''): string | null => {
      if (typeof window === 'undefined') return null
       
      const v = window.prompt(msg, defaultValue)
      return v
    },
    [],
  )

  if (!editor) {
    return <div className="editor-toolbar editor-toolbar-loading">加载中…</div>
  }

  // ===== 按钮分组定义 =====
  const groupHistory: ButtonDef[] = [
    {
      key: 'undo',
      title: '撤销 (Ctrl+Z)',
      label: '↶',
      isDisabled: () => !editor.can().undo(),
      onClick: () => editor.chain().focus().undo().run(),
    },
    {
      key: 'redo',
      title: '重做 (Ctrl+Shift+Z)',
      label: '↷',
      isDisabled: () => !editor.can().redo(),
      onClick: () => editor.chain().focus().redo().run(),
    },
  ]

  const groupBlock: ButtonDef[] = [
    {
      key: 'p',
      title: '正文',
      label: 'P',
      isActive: () => editor.isActive('paragraph'),
      onClick: () => editor.chain().focus().setParagraph().run(),
    },
    ...([1, 2, 3, 4, 5, 6] as const).map<ButtonDef>((level) => ({
      key: `h${level}`,
      title: `标题 H${level}`,
      label: `H${level}`,
      isActive: () => isHeadingActive(level),
      onClick: () => editor.chain().focus().toggleHeading({ level }).run(),
    })),
  ]

  const groupInline: ButtonDef[] = [
    {
      key: 'bold',
      title: '加粗 (Ctrl+B)',
      label: 'B',
      isActive: () => editor.isActive('bold'),
      onClick: () => editor.chain().focus().toggleBold().run(),
    },
    {
      key: 'italic',
      title: '斜体 (Ctrl+I)',
      label: 'I',
      isActive: () => editor.isActive('italic'),
      onClick: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      key: 'underline',
      title: '下划线 (Ctrl+U)',
      label: 'U',
      isActive: () => editor.isActive('underline'),
      onClick: () => editor.chain().focus().toggleUnderline().run(),
    },
    {
      key: 'strike',
      title: '删除线',
      label: 'S',
      isActive: () => editor.isActive('strike'),
      onClick: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      key: 'code',
      title: '行内代码',
      label: '<>',
      isActive: () => editor.isActive('code'),
      onClick: () => editor.chain().focus().toggleCode().run(),
    },
  ]

  const groupScript: ButtonDef[] = [
    {
      key: 'sup',
      title: '上标',
      label: 'X²',
      isActive: () => editor.isActive('superscript'),
      onClick: () => editor.chain().focus().toggleSuperscript().run(),
    },
    {
      key: 'sub',
      title: '下标',
      label: 'X₂',
      isActive: () => editor.isActive('subscript'),
      onClick: () => editor.chain().focus().toggleSubscript().run(),
    },
    {
      key: 'highlight',
      title: '高亮',
      label: '🖍',
      isActive: () => editor.isActive('highlight'),
      onClick: () => editor.chain().focus().toggleHighlight().run(),
    },
    {
      key: 'color',
      title: '文字颜色',
      label: 'A',
      isActive: () => editor.isActive('textStyle'),
      onClick: () => {
        const c = promptText('输入颜色（hex 或 css 名）', '#ff8800')
        if (!c) return
        editor.chain().focus().setColor(c).run()
      },
    },
  ]

  const groupList: ButtonDef[] = [
    {
      key: 'ul',
      title: '无序列表',
      label: '•',
      isActive: () => editor.isActive('bulletList'),
      onClick: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      key: 'ol',
      title: '有序列表',
      label: '1.',
      isActive: () => editor.isActive('orderedList'),
      onClick: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      key: 'task',
      title: '任务列表',
      label: '☑',
      isActive: () => editor.isActive('taskList'),
      onClick: () => editor.chain().focus().toggleTaskList().run(),
    },
    {
      key: 'quote',
      title: '引用',
      label: '❝',
      isActive: () => editor.isActive('blockquote'),
      onClick: () => editor.chain().focus().toggleBlockquote().run(),
    },
  ]

  const groupInsert: ButtonDef[] = [
    {
      key: 'link',
      title: '链接',
      label: '🔗',
      isActive: () => editor.isActive('link'),
      onClick: () => {
        const url = promptText('输入 URL', editor.getAttributes('link')['href'] ?? 'https://')
        if (url === null) return
        if (url === '') {
          editor.chain().focus().unsetLink().run()
        } else {
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        }
      },
    },
    {
      key: 'image',
      title: '图片（粘贴/拖拽 或 选文件）',
      label: '🖼',
      onClick: () => {
        // 优先触发外部文件选择器
        if (onPickImage) {
          onPickImage()
          return
        }
        // 回退：手动 URL
        const url = promptText('输入图片 URL', 'https://')
        if (!url) return
        // R33-A11yPerf-2 修复 (CRITICAL wcag-1.1.1-empty-alt)：原版硬编码
        // alt='' 违反 WCAG 1.1.1（Non-text Content）。屏幕阅读器对空 alt
        // 完全跳过图片——信息性图片失去可访问性。修复：弹第二个 prompt
        // 让用户输入描述性 alt 文本；若用户留空视为装饰图，传 alt=null 并
        // 加 role='presentation'（TipTap setImage 接受 alt=null）。
        const altInput = promptText('图片 alt 描述（留空 = 装饰图）', '') ?? ''
        const alt = altInput.trim() ? altInput : null
        editor
          .chain()
          .focus()
          .setImage({
            src: url,
            alt,
            // 装饰图显式声明 role='presentation' 让 SR 完全跳过
            ...(alt === null ? { role: 'presentation' } : {}),
          } as never)
          .run()
      },
    },
    {
      key: 'codeblock',
      title: '代码块',
      label: '{ }',
      isActive: () => editor.isActive('codeBlock'),
      onClick: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      key: 'table',
      title: '表格',
      label: '⊞',
      isActive: () => editor.isActive('table'),
      onClick: () =>
        editor
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
  ]

  const groupMedia: ButtonDef[] = [
    {
      key: 'math-inline',
      title: '行内公式',
      label: '∑',
      isActive: () => editor.isActive('mathInline'),
      onClick: () => {
        const latex = promptText('输入 LaTeX 公式（行内）', 'E = mc^2')
        if (!latex) return
        editor.chain().focus().insertMathInline(latex).run()
      },
    },
    {
      key: 'math-block',
      title: '块级公式',
      label: '∫',
      isActive: () => editor.isActive('mathBlock'),
      onClick: () => {
        const latex = promptText('输入 LaTeX 公式（块级）', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}')
        if (!latex) return
        editor.chain().focus().insertMathBlock(latex).run()
      },
    },
    {
      key: 'mermaid',
      title: 'Mermaid 图表',
      label: '◆',
      isActive: () => editor.isActive('mermaid'),
      onClick: () => {
        const code = promptText(
          '输入 Mermaid 源码',
          'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| D[继续]',
        )
        if (!code) return
        editor.chain().focus().insertMermaid(code).run()
      },
    },
  ]

  const groupMisc: ButtonDef[] = [
    {
      key: 'hr',
      title: '水平线',
      label: '—',
      onClick: () => editor.chain().focus().setHorizontalRule().run(),
    },
    {
      key: 'clear',
      title: '清除格式',
      label: '✕',
      onClick: () =>
        editor.chain().focus().clearNodes().unsetAllMarks().run(),
    },
  ]

  const renderButton = (b: ButtonDef) => {
    const active = b.isActive?.() ?? false
    const dis = (b.isDisabled?.() ?? false) || disabled
    // R13 修复 (medium)：toggle 按钮加 aria-pressed + aria-label，让 SR
    // 知道当前是否激活，光标移动到 bold 文本里时也能听到"加粗，已按下"。
    const isToggle = typeof b.isActive === 'function'
    return (
      <button
        key={b.key}
        type="button"
        className={`editor-toolbar-btn ${active ? 'is-active' : ''}`}
        title={b.title}
        aria-label={b.title}
        aria-pressed={isToggle ? active : undefined}
        disabled={dis}
        onClick={b.onClick}
      >
        {b.label}
      </button>
    )
  }

  const renderGroup = (group: ButtonDef[]) => group.map(renderButton)

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="编辑器工具栏">
      {renderGroup(groupHistory)}
      <Divider />
      {renderGroup(groupBlock)}
      <Divider />
      {renderGroup(groupInline)}
      <Divider />
      {renderGroup(groupScript)}
      <Divider />
      {renderGroup(groupList)}
      <Divider />
      {renderGroup(groupInsert)}
      <Divider />
      {renderGroup(groupMedia)}
      <Divider />
      {renderGroup(groupMisc)}
    </div>
  )
}
