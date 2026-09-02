/**
 * Markdown 视图
 *
 * 用 markdown-it + 自定义占位符解析聊天消息中的 Markdown、KaTeX 数学、Mermaid 图表。
 *   - 先调 renderMarkdown 得到带占位符的 HTML
 *   - 按出现顺序切分字符串，把占位符替换成 React 组件（MermaidBlock / MathBlock）
 *   - 其余 HTML 段用 dangerouslySetInnerHTML 注入
 */
import { useMemo } from 'react'
import { MermaidBlock } from './MermaidBlock'
import { MathBlock } from './MathBlock'
import {
  renderMarkdown,
  extractMermaidBlocks,
  extractMathBlocks
} from '../../lib/markdown'

interface Props {
  /** 原始 Markdown 文本 */
  content: string
}

interface RenderPart {
  type: 'html' | 'mermaid' | 'math'
  value: string
}

export function MarkdownView({ content }: Props) {
  const parts = useMemo<RenderPart[]>(() => {
    const html = renderMarkdown(content)

    const mermaidBlocks = extractMermaidBlocks(html)
    const mathBlocks = extractMathBlocks(html)

    // 合并所有占位符，按位置排序；然后切片原始 html
    type Marker =
      | { kind: 'mermaid'; start: number; end: number; placeholder: string; source: string }
      | { kind: 'math'; start: number; end: number; placeholder: string; tex: string; display: boolean }

    const markers: Marker[] = []
    for (const m of mermaidBlocks) {
      const start = html.indexOf(m.placeholder)
      if (start < 0) continue
      markers.push({
        kind: 'mermaid',
        start,
        end: start + m.placeholder.length,
        placeholder: m.placeholder,
        source: m.source
      })
    }
    for (const m of mathBlocks) {
      const start = html.indexOf(m.placeholder)
      if (start < 0) continue
      markers.push({
        kind: 'math',
        start,
        end: start + m.placeholder.length,
        placeholder: m.placeholder,
        tex: m.tex,
        display: m.display
      })
    }
    // 按出现顺序排序
    markers.sort((a, b) => a.start - b.start)

    const out: RenderPart[] = []
    let cursor = 0
    for (const mk of markers) {
      if (mk.start > cursor) {
        out.push({ type: 'html', value: html.slice(cursor, mk.start) })
      }
      if (mk.kind === 'mermaid') {
        out.push({ type: 'mermaid', value: mk.source })
      } else {
        out.push({ type: 'math', value: JSON.stringify({ tex: mk.tex, display: mk.display }) })
      }
      cursor = mk.end
    }
    if (cursor < html.length) {
      out.push({ type: 'html', value: html.slice(cursor) })
    }
    return out
  }, [content])

  return (
    <div className="ai-markdown">
      {parts.map((part, i) => {
        if (part.type === 'html') {
          return <div key={`h-${i}`} dangerouslySetInnerHTML={{ __html: part.value }} />
        }
        if (part.type === 'mermaid') {
          return <MermaidBlock key={`m-${i}`} source={part.value} />
        }
        // math
        const meta = JSON.parse(part.value) as { tex: string; display: boolean }
        return <MathBlock key={`t-${i}`} tex={meta.tex} display={meta.display} />
      })}
    </div>
  )
}

export default MarkdownView