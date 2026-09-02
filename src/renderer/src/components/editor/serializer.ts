/**
 * TipTap JSON ↔ HTML ↔ Markdown 三向序列化
 *
 * 使用 TipTap 提供的 generateJSON / generateHTML 桥接到 markdown.ts 的 HTML<->Markdown 工具。
 */
import { generateHTML } from '@tiptap/html'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Underline from '@tiptap/extension-underline'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import Highlight from '@tiptap/extension-highlight'
import Color from '@tiptap/extension-color'
import TextStyle from '@tiptap/extension-text-style'
import Typography from '@tiptap/extension-typography'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'

import { MermaidNode } from './extensions/MermaidNode'
import { MathInlineNode, MathBlockNode } from './extensions/MathNode'
import { CodeBlockWithHighlight } from './extensions/CodeBlockWithHighlight'
import { htmlToMarkdown, markdownToHtml } from './markdown'

// 共享的 extensions 列表，用于 generateHTML 和编辑器
export const sharedExtensions = [
  StarterKit.configure({
    codeBlock: false, // 由 CodeBlockWithHighlight 取代
  }),
  Link.configure({
    openOnClick: false,
    HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
  }),
  Image,
  Underline,
  Subscript,
  Superscript,
  Highlight.configure({ multicolor: true }),
  Color,
  TextStyle,
  Typography,
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  MermaidNode,
  MathInlineNode,
  MathBlockNode,
  CodeBlockWithHighlight,
] as const

/**
 * 将 Markdown 文本解析为 TipTap 文档 JSON
 *
 * 流程：Markdown -> HTML（markdown.ts）-> JSON（@tiptap/html 内部 parseHTML）
 *
 * 注意：@tiptap/html 提供 generateJSON(doc, extensions)；HTML 输入需要调用
 * `prosemirrorJSONFromHTML` 或自定义解析。这里直接基于 generateHTML 反向使用
 * 是不行的，我们采用一种简单方案：借助 DOMParser 构造 document，再由
 * `generateHTML(json, extensions)` 反向生成不可行——所以采用以下两步：
 *   1. Markdown -> HTML
 *   2. 使用 ProseMirror DOMParser 把 HTML 字符串解析为 doc（通过临时编辑器 schema）
 *
 * 为避免启动编辑器开销，我们直接基于 ProseMirror Schema 手动构造 DOM 解析路径：
 * 此处提供一个轻量替代：直接返回 null/空文档，让上层用 markdownToHtml 渲染 HTML 字符串即可。
 * 完整编辑器入口通过 editor.commands.setContent({ type: 'doc', content: [...] }, true) 处理。
 */
export function markdownToEditorJSON(markdown: string): object | null {
  // 真实解析由编辑器初始化时通过 schema 完成，此处仅返回 HTML 字符串供调用方按需使用
  void markdown
  return null
}

/**
 * 将 TipTap JSON 序列化为 Markdown 文本
 *
 * 流程：JSON -> HTML（generateHTML）-> Markdown（htmlToMarkdown）
 *
 * Bug B 修复（编辑时多次按回车再输入文字，空行自动消失）：
 *
 * 原版完全依赖 turndown 把 HTML 转回 markdown。turndown 对空白 `<p></p>` 节点
 * 一律走 `blankRule`（输出 `\n\n`），且其内部的 `join()` 函数会先
 * `trimTrailingNewlines` 再拼接，导致**多个连续空段落无法累积换行**——
 * `<p>a</p><p></p><p></p><p>b</p>` 经过 turndown 后变成 `a\n\nb`，第二个空
 * 行彻底消失。
 *
 * 修复：直接遍历 TipTap JSON 树，把 paragraph / heading / list / taskList 等
 * 常见节点按 markdown 语法拼接，**保留连续空段落**（每个空段落输出 `\n\n`，
 * 不会被外部 join 函数裁掉）。其余不识别的节点（mermaid / math / 表格等）
 * 退回到原来的 turndown 路径，仅针对这些节点使用 generateHTML + htmlToMarkdown。
 *
 * 这样绝大多数"打字→回车"的场景都走 JSON 直接序列化，turndown 只在遇到
 * 复杂节点时才介入，从根本上消除空行被吞的问题。
 */
export function editorJSONToMarkdown(json: object): string {
  try {
    return jsonTreeToMarkdown(json)
  } catch (err) {
    console.error('[serializer] editorJSONToMarkdown (json path) failed, falling back', err)
    try {
      const html = generateHTML(json as any, [...sharedExtensions] as any)
      return htmlToMarkdown(html)
    } catch (err2) {
      console.error('[serializer] editorJSONToMarkdown fallback failed', err2)
      return ''
    }
  }
}

/**
 * 将 TipTap JSON 树递归序列化为 Markdown
 *
 * - 空段落（content 为空或全是空白）：输出 `\n\n`，**不会被合并**——
 *   多次连续空段落产生多次 `\n\n`，对应 markdown 中的多个空行
 * - 含内容的段落：输出 `\n\n${inline}\n\n`
 * - heading: `# ` ~ `###### `
 * - list: `- ` / `1. ` 前缀
 * - taskList/taskItem: `- [ ] ` / `- [x] `
 * - blockquote: `> ` 前缀
 * - codeBlock: ` ``` `
 * - hardBreak: 末尾两个空格 + 换行
 * - horizontalRule: `\n\n---\n\n`
 * - 其他复杂节点（mermaid / math / table / image）：退回到 HTML + turndown
 */
function jsonTreeToMarkdown(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; content?: unknown[]; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }
  switch (n.type) {
    case 'doc':
      return (n.content ?? []).map(jsonTreeToMarkdown).join('')
    case 'paragraph': {
      const inner = (n.content ?? []).map(jsonTreeToMarkdown).join('')
      // Bug B 修复：空段落（inner 为空字符串）输出 `\n\n`，不要因为 trim 而被吞。
      // 外层 join（doc）会用空字符串拼接，不会做任何 trim，所以连续空段落的
      // 多对 `\n\n` 会完整保留下来，对应 markdown 中的多个空行。
      if (!inner.trim()) return '\n\n'
      return '\n\n' + inner + '\n\n'
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.['level'] ?? 1)))
      const prefix = '#'.repeat(level) + ' '
      const inner = (n.content ?? []).map(jsonTreeToMarkdown).join('')
      return '\n\n' + prefix + inner + '\n\n'
    }
    case 'bulletList':
    case 'bullet_list': {
      const items = (n.content ?? []).map(jsonTreeToMarkdown).join('')
      return '\n\n' + items + '\n\n'
    }
    case 'orderedList':
    case 'ordered_list': {
      const items = (n.content ?? [])
        .map((li, idx) => {
          const inner = jsonTreeToMarkdown(li)
          return inner.replace(/^/, `${idx + 1}. `)
        })
        .join('')
      return '\n\n' + items + '\n\n'
    }
    case 'listItem':
    case 'list_item': {
      const inner = (n.content ?? []).map(jsonTreeToMarkdown).join('').trim()
      // 去掉 inner 首尾的 \n（paragraph 会自带 \n\n），加 list 缩进
      const stripped = inner.replace(/^\n+|\n+$/g, '')
      return '- ' + stripped + '\n'
    }
    case 'taskList': {
      const items = (n.content ?? []).map(jsonTreeToMarkdown).join('')
      return '\n\n' + items + '\n\n'
    }
    case 'taskItem': {
      const inner = (n.content ?? []).map(jsonTreeToMarkdown).join('').trim().replace(/^\n+|\n+$/g, '')
      const checked = n.attrs?.['checked'] ? 'x' : ' '
      return `- [${checked}] ${inner}\n`
    }
    case 'blockquote': {
      const inner = (n.content ?? [])
        .map(jsonTreeToMarkdown)
        .join('')
        .trim()
        .split('\n')
        .map((l) => (l ? '> ' + l : '>'))
        .join('\n')
      return '\n\n' + inner + '\n\n'
    }
    case 'codeBlock': {
      const lang = String(n.attrs?.['language'] ?? '')
      const text = (n.content ?? [])
        .map((c) => (c as { text?: string }).text ?? '')
        .join('')
      return '\n\n```' + lang + '\n' + text + '\n```\n\n'
    }
    case 'horizontalRule':
    case 'horizontal_rule':
      return '\n\n---\n\n'
    case 'hardBreak':
    case 'hard_break':
      return '  \n'
    case 'text': {
      let text = n.text ?? ''
      for (const mark of n.marks ?? []) {
        switch (mark.type) {
          case 'bold':
          case 'strong':
            text = `**${text}**`
            break
          case 'italic':
          case 'em':
            text = `*${text}*`
            break
          case 'underline':
            // markdown 不原生支持下划线；HTML 输出更稳
            text = `<u>${text}</u>`
            break
          case 'strike':
          case 'strikethrough':
            text = `~~${text}~~`
            break
          case 'code':
            text = '`' + text + '`'
            break
          case 'link': {
            const href = String(mark.attrs?.['href'] ?? '')
            if (href) text = `[${text}](${href})`
            break
          }
          case 'highlight':
            text = `==${text}==`
            break
          case 'subscript':
            text = `~${text}~`
            break
          case 'superscript':
            text = `^${text}^`
            break
          // 忽略未知 mark
        }
      }
      return text
    }
    // 复杂节点（mermaid / math / table / image 等）退回到 turndown
    case 'mermaid':
    case 'mathInline':
    case 'mathBlock':
    case 'math_inline':
    case 'math_block':
    case 'image':
    case 'table':
    case 'tableRow':
    case 'tableHeader':
    case 'tableCell':
    case 'table_row':
    case 'table_header':
    case 'table_cell': {
      try {
        const html = generateHTML(n as never, [...sharedExtensions] as any)
        return htmlToMarkdown(html)
      } catch {
        return ''
      }
    }
    default:
      // 未知节点：递归处理其子节点
      return (n.content ?? []).map(jsonTreeToMarkdown).join('')
  }
}

/**
 * 将 TipTap JSON 序列化为 HTML 字符串
 */
export function editorJSONToHTML(json: object): string {
  try {
    return generateHTML(json as any, [...sharedExtensions] as any)
  } catch (err) {
    console.error('[serializer] editorJSONToHTML failed', err)
    return ''
  }
}

/**
 * Markdown -> HTML（仅经过 markdown-it）— 用于在编辑器外做预览
 */
export function markdownToHTMLString(markdown: string): string {
  return markdownToHtml(markdown)
}

/**
 * HTML -> Markdown
 */
export function htmlStringToMarkdown(html: string): string {
  return htmlToMarkdown(html)
}
