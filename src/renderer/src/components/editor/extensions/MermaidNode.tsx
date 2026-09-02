/**
 * MermaidNode - 自定义 TipTap Node 扩展
 *
 * 用于在 WYSIWYG 编辑器中嵌入 Mermaid 图表。
 * - 节点属性：code（mermaid 源码）、theme（light/dark，默认跟随系统）
 * - 序列化输出：<pre data-type="mermaid">code</pre>（与 markdown.ts 解析兼容）
 * - 节点视图：使用 mermaid.render(id, code) 异步生成 SVG
 *
 * 性能：mermaid 打包体积约 1MB，因此不在模块顶层静态导入，
 * 而是在 NodeView 真正需要渲染图表时才动态 import（首屏不加载）。
 */
import { Node, mergeAttributes, type NodeViewProps } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

/** 仅类型引用 mermaid，不会产生运行时依赖 */
type MermaidApi = (typeof import('mermaid'))['default']

export interface MermaidNodeOptions {
  /** 默认主题：跟随系统 / 固定 light/dark */
  defaultTheme: 'system' | 'light' | 'dark'
}

// 动态导入的单例缓存：整个应用只拉取一次 mermaid chunk
let mermaidPromise: Promise<MermaidApi> | null = null
// Mermaid 全局初始化状态：避免重复初始化
let mermaidInited = false

/**
 * 懒加载 mermaid 并确保只 initialize 一次。
 * 第一次调用会触发动态 import（生成独立 chunk），后续调用复用同一 Promise。
 */
async function loadMermaid(theme: 'light' | 'dark'): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => mod.default)
      .catch((err: unknown) => {
        // 加载失败时清空缓存，允许下次重试
        mermaidPromise = null
        throw err
      })
  }
  const mermaid = await mermaidPromise
  if (!mermaidInited) {
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // mermaid 类型限定了 Theme 枚举值，这里通过 as 兼容
        theme: theme as 'default' | 'base' | 'forest' | 'dark' | 'neutral' | 'null',
        fontFamily: 'inherit',
      })
      mermaidInited = true
    } catch (err) {
      console.error('[MermaidNode] mermaid.initialize failed', err)
    }
  }
  return mermaid
}

// 单调递增 ID 计数器
let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `mmd-${Date.now().toString(36)}-${idCounter}`
}

/**
 * MermaidNodeView：节点视图组件
 *
 * - 接收 node.attrs.code 与 node.attrs.theme
 * - 挂载时调用 mermaid.render 异步生成 SVG
 * - 编辑态：点击"编辑"切换为 textarea；保存后重新渲染
 */
function MermaidNodeView(props: NodeViewProps) {
  const { node, updateAttributes, editor } = props
  const code: string = node.attrs['code'] ?? ''
  const attrTheme: string = node.attrs['theme'] ?? 'system'
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [editing, setEditing] = useState<boolean>(false)
  const [draft, setDraft] = useState<string>(code)

  // 解析当前主题
  const systemTheme: 'light' | 'dark' =
    typeof document !== 'undefined' &&
    document.documentElement.dataset['theme'] === 'light'
      ? 'light'
      : 'dark'
  const effectiveTheme: 'light' | 'dark' =
    attrTheme === 'system' || !attrTheme ? systemTheme : (attrTheme as 'light' | 'dark')

  useEffect(() => {
    let cancelled = false
    if (editing) return
    if (!code.trim()) {
      setSvg('')
      setError('')
      return
    }
    // 首次渲染时才动态加载 mermaid，加载完成后立即渲染
    void (async () => {
      try {
        const mermaid = await loadMermaid(effectiveTheme)
        if (cancelled) return
        const res = await mermaid.render(nextId(), code)
        if (cancelled) return
        setSvg(res.svg)
        setError('')
      } catch (err: unknown) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setSvg('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, effectiveTheme, editing])

  // 同步 draft
  useEffect(() => {
    setDraft(code)
  }, [code])

  const readOnly = !editor?.isEditable

  return (
    <NodeViewWrapper
      className="mermaid-block"
      data-theme={effectiveTheme}
      contentEditable={false}
    >
      {editing ? (
        <div className="mermaid-edit">
          <textarea
            className="mermaid-source"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(20, Math.max(4, draft.split('\n').length + 1))}
          />
          <div className="mermaid-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                updateAttributes({ code: draft })
                setEditing(false)
              }}
            >
              保存
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setDraft(code)
                setEditing(false)
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <div
            ref={containerRef}
            className="mermaid-render"
            dangerouslySetInnerHTML={
              error
                ? { __html: `<pre class="mermaid-error">${escapeHtml(error)}</pre>` }
                : svg
                  ? { __html: svg }
                  : { __html: '<div class="mermaid-placeholder">渲染中…</div>' }
            }
          />
          {!readOnly && (
            <div className="mermaid-toolbar">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setEditing(true)}
                title="编辑源码"
              >
                编辑
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    window.alert('Mermaid 源码：\n\n' + code)
                  }
                }}
                title="查看源码"
              >
                源码
              </button>
            </div>
          )}
        </>
      )}
    </NodeViewWrapper>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * MermaidNode - TipTap Node 定义
 *
 * - atom: true（不可编辑内部，光标不能进入）
 * - group: block
 * - draggable: true
 * - selectable: true
 */
export const MermaidNode = Node.create<MermaidNodeOptions>({
  name: 'mermaid',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      defaultTheme: 'system',
    }
  },

  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
      },
      theme: {
        default: 'system',
        parseHTML: (element) => element.getAttribute('data-theme') ?? 'system',
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'pre[data-type="mermaid"]',
        getAttrs: (node) => {
          const el = node as HTMLElement
          return {
            code: el.textContent ?? '',
            theme: el.getAttribute('data-theme') ?? 'system',
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'mermaid',
        'data-theme': HTMLAttributes['theme'] ?? 'system',
      }),
      HTMLAttributes['code'] ?? '',
    ]
  },

  addCommands() {
    return {
      insertMermaid:
        (code = 'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| D[继续]') =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { code, theme: this.options.defaultTheme },
          })
        },
    } as never
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView)
  },
})

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mermaid: {
      insertMermaid: (code?: string) => ReturnType
    }
  }
}
