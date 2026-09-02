/**
 * 编辑器演示页（/editor-demo）
 *
 * 用于验证 TipTap WYSIWYG 编辑器 + Mermaid + KaTeX 各种能力：
 * - Markdown 内容加载
 * - 工具栏使用
 * - 字符计数
 * - 实时预览 Markdown 输出
 *
 * 数据通过 localStorage 持久化（key: taskpilot:editor-demo-content），便于测试往返。
 */
import { useCallback, useEffect, useState } from 'react'
import { TipTapEditor, type EditorContentSource } from '../components/editor'

const STORAGE_KEY = 'taskpilot:editor-demo-content'

const SAMPLE_MARKDOWN = `# TaskPilot 编辑器演示

这是一个**所见即所得**（WYSIWYG）Markdown 编辑器，基于 [TipTap](https://tiptap.dev) 实现。

## 文本格式

支持 *斜体*、**加粗**、<u>下划线</u>、~~删除线~~、\`行内代码\`、H~2~O、X^2^ 等格式。

## 列表

- 无序列表项 1
- 无序列表项 2
  - 嵌套项
- 无序列表项 3

1. 有序列表项
2. 有序列表项
3. 有序列表项

## 任务列表

- [x] 已完成任务
- [ ] 待办任务
- [ ] 另一个待办

## 引用

> 知识就是力量。
> —— 培根

## 代码块（含语法高亮）

\`\`\`typescript
import { create } from 'zustand'

interface State {
  count: number
  inc: () => void
}

export const useCounter = create<State>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
}))
\`\`\`

## 表格

| 功能 | 状态 | 备注 |
| --- | --- | --- |
| 标题 H1-H6 | ✅ | StarterKit |
| 表格 | ✅ | Table 扩展 |
| 任务列表 | ✅ | TaskList 扩展 |
| Mermaid | ✅ | 自定义 Node |
| KaTeX | ✅ | 自定义 Node |

## 数学公式

行内公式：$E = mc^2$，勾股定理 $a^2 + b^2 = c^2$。

块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## Mermaid 图表

\`\`\`mermaid
graph TD
  A[开始] --> B{是否完成任务?}
  B -->|是| C[标记完成]
  B -->|否| D[继续执行]
  C --> E[结束]
  D --> B
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant U as 用户
  participant E as 编辑器
  participant S as 存储
  U->>E: 输入内容
  E->>S: 保存
  S-->>E: 确认
  E-->>U: 反馈
\`\`\`

---

试试在工具栏上点击各个按钮，感受编辑体验！
`

export function EditorDemoRoute() {
  const [initialMarkdown, setInitialMarkdown] = useState<string | null>(null)
  const [markdownOut, setMarkdownOut] = useState<string>('')
  const [htmlOut, setHtmlOut] = useState<string>('')

  // 初次加载：从 localStorage 读取或使用示例
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(STORAGE_KEY)
    setInitialMarkdown(stored ?? SAMPLE_MARKDOWN)
  }, [])

  // 持久化 + 同步输出
  const handleChange = useCallback(
    (state: { json: object; html: string; markdown: string; characters: number; words: number }) => {
      setMarkdownOut(state.markdown)
      setHtmlOut(state.html)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, state.markdown)
      }
    },
    [],
  )

  const handleReset = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY)
    }
    setInitialMarkdown(SAMPLE_MARKDOWN)
  }

  const handleClear = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY)
    }
    setInitialMarkdown('')
  }

  if (initialMarkdown === null) {
    return (
      <div className="page-placeholder">
        <p className="muted">加载中…</p>
      </div>
    )
  }

  const content: EditorContentSource =
    initialMarkdown.length > 0
      ? { kind: 'markdown', markdown: initialMarkdown }
      : { kind: 'empty' }

  return (
    <div className="page editor-demo-page">
      <header className="page-header">
        <div>
          <h1>编辑器演示</h1>
          <p className="muted">
            TipTap WYSIWYG · Mermaid · KaTeX · 字符计数 · Markdown 双向转换
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={handleClear} title="清空内容">
            清空
          </button>
          <button className="btn" onClick={handleReset} title="重置为示例">
            重置示例
          </button>
        </div>
      </header>

      <TipTapEditor
        content={content}
        placeholder="开始书写…"
        charLimit={5000}
        onChange={handleChange}
        renderFooter={() => (
          <span className="muted" style={{ fontSize: 11 }}>
            自动保存到 localStorage
          </span>
        )}
      />

      <details className="editor-output" open>
        <summary>Markdown 输出（实时）</summary>
        <pre className="output-block">{markdownOut || '（空）'}</pre>
      </details>

      <details className="editor-output">
        <summary>HTML 输出（实时）</summary>
        <pre className="output-block">{htmlOut || '（空）'}</pre>
      </details>
    </div>
  )
}

export default EditorDemoRoute
