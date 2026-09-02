/**
 * MathNode - 行内 ($...$) 与块级 ($$...$$) KaTeX 公式 Node 扩展
 *
 * 设计：
 * - MathInlineNode: inline = true, atom = true, group = 'inline'，渲染 katex HTML 到 span
 * - MathBlockNode: atom = true, group = 'block'，渲染 katex HTML 到 div
 *
 * 与 markdown.ts 的兼容性：
 * - 行内：parseHTML 匹配 <span data-type="math-inline" data-latex="...">
 * - 块级：parseHTML 匹配 <div data-type="math-block" data-latex="...">
 *         也兼容 <pre data-type="math-block">（来自 ```math 围栏）
 *
 * 性能：katex 及其 CSS 不在模块顶层静态导入，
 * 而是在 NodeView 首次渲染公式时动态 import（CSS 以 <link> 形式注入 head）。
 */
import { Node, mergeAttributes, type NodeViewProps } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import { useEffect, useMemo, useRef, useState } from 'react'

/** 仅类型引用 katex，不会产生运行时依赖 */
type KatexApi = (typeof import('katex'))['default']

// 动态导入的单例缓存：整个应用只拉取一次 katex chunk
let katexPromise: Promise<KatexApi> | null = null
// 已加载完成的实例：命中后可同步渲染，避免二次挂载时闪烁
let katexModule: KatexApi | null = null
let katexCssRequested = false

/** 懒加载 katex 样式：拿到打包后的 URL 后以 <link> 追加到 document.head */
function ensureKatexCss(): void {
  if (katexCssRequested || typeof document === 'undefined') return
  katexCssRequested = true
  void import('katex/dist/katex.min.css?url')
    .then((mod) => {
      const href = mod.default
      if (!href || document.querySelector(`link[data-katex-css]`)) return
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.dataset['katexCss'] = 'true'
      document.head.appendChild(link)
    })
    .catch((err: unknown) => {
      katexCssRequested = false
      console.error('[MathNode] katex css load failed', err)
    })
}

/** 懒加载 katex 主体；首次调用同时触发样式加载 */
async function loadKatex(): Promise<KatexApi> {
  ensureKatexCss()
  if (!katexPromise) {
    katexPromise = import('katex')
      .then((mod) => {
        katexModule = mod.default
        return mod.default
      })
      .catch((err: unknown) => {
        // 加载失败时清空缓存，允许下次重试
        katexPromise = null
        throw err
      })
  }
  return katexPromise
}

interface RenderResult {
  html: string
  error: string
}

function renderKatex(katex: KatexApi, latex: string, displayMode: boolean): RenderResult {
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: 'ignore',
      trust: false,
    })
    return { html, error: '' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { html: escapeHtml(latex), error: msg }
  }
}

/**
 * 公式渲染 hook：katex 未就绪时先展示转义后的源码占位，
 * 动态 chunk 到达后立即重渲染，保证首次进入视图也能正确显示。
 */
function useKatexRender(latex: string, displayMode: boolean): RenderResult {
  const [katex, setKatex] = useState<KatexApi | null>(katexModule)

  useEffect(() => {
    if (katex) return
    let cancelled = false
    loadKatex()
      .then((api) => {
        if (!cancelled) setKatex(api)
      })
      .catch((err: unknown) => {
        console.error('[MathNode] katex load failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [katex])

  return useMemo(
    () =>
      katex
        ? renderKatex(katex, latex, displayMode)
        : { html: escapeHtml(latex), error: '' },
    [katex, latex, displayMode],
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ============== MathInlineNode ==============

function MathInlineView(props: NodeViewProps) {
  const { node, updateAttributes, editor } = props
  const latex: string = node.attrs['latex'] ?? ''
  const [editing, setEditing] = useState<boolean>(false)
  const [draft, setDraft] = useState<string>(latex)
  const inputRef = useRef<HTMLInputElement>(null)

  const result = useKatexRender(latex, false)

  useEffect(() => {
    setDraft(latex)
  }, [latex])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const readOnly = !editor?.isEditable

  if (editing && !readOnly) {
    return (
      <NodeViewWrapper as="span" className="math-inline editing" contentEditable={false}>
        <input
          ref={inputRef}
          className="math-source"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            updateAttributes({ latex: draft })
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              updateAttributes({ latex: draft })
              setEditing(false)
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(latex)
              setEditing(false)
            }
          }}
        />
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`math-inline ${result.error ? 'has-error' : ''}`}
      data-latex={latex}
      contentEditable={false}
      onDoubleClick={() => !readOnly && setEditing(true)}
    >
      <span dangerouslySetInnerHTML={{ __html: result.html }} />
    </NodeViewWrapper>
  )
}

export const MathInlineNode = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-latex') ?? element.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs['latex'] ?? '' }),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="math-inline"]',
        getAttrs: (node) => {
          const el = node as HTMLElement
          return {
            latex: el.getAttribute('data-latex') ?? el.textContent ?? '',
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-inline',
        'data-latex': HTMLAttributes['latex'] ?? '',
      }),
      // 在 HTML 输出中保留 katex HTML 作为子节点（由 NodeView 渲染时已经写入）
      // 这里只在序列化场景下输出占位文本
      String.raw`\(${HTMLAttributes['latex'] ?? ''}\)`,
    ]
  },

  addCommands() {
    return {
      insertMathInline:
        (latex = 'E = mc^2') =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { latex },
          })
        },
    } as never
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView)
  },
})

// ============== MathBlockNode ==============

function MathBlockView(props: NodeViewProps) {
  const { node, updateAttributes, editor } = props
  const latex: string = node.attrs['latex'] ?? ''
  const [editing, setEditing] = useState<boolean>(false)
  const [draft, setDraft] = useState<string>(latex)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const result = useKatexRender(latex, true)

  useEffect(() => {
    setDraft(latex)
  }, [latex])

  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus()
    }
  }, [editing])

  const readOnly = !editor?.isEditable

  if (editing && !readOnly) {
    return (
      <NodeViewWrapper className="math-block editing" contentEditable={false}>
        <textarea
          ref={taRef}
          className="math-source"
          value={draft}
          rows={Math.min(20, Math.max(3, draft.split('\n').length + 1))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            updateAttributes({ latex: draft })
            setEditing(false)
          }}
        />
        <div className="math-actions">
          <button
            type="button"
            className="btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              updateAttributes({ latex: draft })
              setEditing(false)
            }}
          >
            保存
          </button>
          <button
            type="button"
            className="btn ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setDraft(latex)
              setEditing(false)
            }}
          >
            取消
          </button>
        </div>
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper
      className={`math-block ${result.error ? 'has-error' : ''}`}
      data-latex={latex}
      contentEditable={false}
      onDoubleClick={() => !readOnly && setEditing(true)}
    >
      <div
        className="math-render"
        dangerouslySetInnerHTML={{ __html: result.html }}
      />
      {!readOnly && (
        <div className="math-toolbar">
          <button
            type="button"
            className="btn ghost"
            onClick={() => setEditing(true)}
            title="编辑公式"
          >
            编辑
          </button>
        </div>
      )}
    </NodeViewWrapper>
  )
}

export const MathBlockNode = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-latex') ?? element.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs['latex'] ?? '' }),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="math-block"]',
        getAttrs: (node) => {
          const el = node as HTMLElement
          return {
            latex: el.getAttribute('data-latex') ?? el.textContent ?? '',
          }
        },
      },
      {
        tag: 'pre[data-type="math-block"]',
        getAttrs: (node) => {
          const el = node as HTMLElement
          return {
            latex: el.textContent ?? '',
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-block',
        'data-latex': HTMLAttributes['latex'] ?? '',
      }),
      String.raw`\[${HTMLAttributes['latex'] ?? ''}\]`,
    ]
  },

  addCommands() {
    return {
      insertMathBlock:
        (latex = '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}') =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { latex },
          })
        },
    } as never
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView)
  },
})

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      insertMathInline: (latex?: string) => ReturnType
      insertMathBlock: (latex?: string) => ReturnType
    }
  }
}
