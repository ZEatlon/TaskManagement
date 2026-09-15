/**
 * mdast → 自包含 HTML 渲染器（同步、纯函数）
 *
 * 仅用于 PDF 导出：主进程的隐藏 BrowserWindow 走 webContents.printToPDF()
 * 渲染我们提前拼好的 HTML 字符串。不能直接复用 NotePreview React 组件：
 *   - NotePreview 通过 Context（ImageResolverContext）异步解析图片 → 序列
 *     化进 PDF 会得到"图片加载一半"的空位
 *   - 隐藏 BrowserWindow 是空白页面，React 不会挂载
 *   - 因此走「一次性同步 HTML 字符串 + 共享 CSS」路径
 *
 * 安全策略与 NotePreview 保持一致：URL 仅放行 http/https/mailto/#/file/，
 * 其余协议降级为纯文本。
 *
 * 从 NoteEditor.tsx 抽出 (R13 medium)：原文件 ~750 行里 ~215 行是这段与编辑器
 * 无关的 mini-markdown 渲染器，没测试也难以复用。本文件独立后可用 vitest 单测
 * 全量 mdast 类型节点，NoteEditor.tsx 只剩编辑器本职代码。
 */
import type { PhrasingContent, RootContent, Table } from 'mdast'

/** mdast RootContent 数组（含 ListItem / TableCell 等所有变体）的别名 */
type RootContentArray = RootContent[]

const ALLOWED_HREF = /^(https?:|mailto:|#|file:)/i

function isSafeHref(raw: string): boolean {
  const stripped = raw.replace(/[\s\x00-\x1f\x7f]/g, '').toLowerCase()
  return stripped.length > 0 && ALLOWED_HREF.test(stripped)
}

function escapeHtml(s: string): string {
  return s
    // 去掉 Unicode 双向控制符（防止有人用 RTL override 翻转 PDF 视觉）
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把 mdast 节点数组渲染成简单 HTML 字符串。
 */
export function mdastToHtml(nodes: RootContentArray): string {
  return nodes.map((n) => mdastNodeToHtml(n)).join('')
}

function mdastNodeToHtml(node: RootContent): string {
  switch (node.type) {
    case 'heading': {
      const depth = Math.min(6, Math.max(1, node.depth))
      return `<h${depth}>${renderInline(node.children)}</h${depth}>`
    }
    case 'paragraph':
      return `<p>${renderInline(node.children)}</p>`
    case 'blockquote':
      return `<blockquote>${mdastToHtml(node.children)}</blockquote>`
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul'
      return `<${Tag}>${node.children.map((li) => mdastNodeToHtml(li as RootContent)).join('')}</${Tag}>`
    }
    case 'listItem': {
      const checked = (node as { checked?: boolean | null }).checked
      const checkbox = typeof checked === 'boolean'
        ? `<input type="checkbox" disabled ${checked ? 'checked' : ''} /> `
        : ''
      return `<li>${checkbox}${mdastToHtml(node.children as RootContentArray)}</li>`
    }
    case 'code':
      return `<pre><code>${escapeHtml(node.value)}</code></pre>`
    case 'thematicBreak':
      return '<hr />'
    case 'table':
      return mdastTableToHtml(node)
    case 'html':
      return escapeHtml(node.value)
    default:
      return ''
  }
}

function renderInline(children: PhrasingContent[]): string {
  return children.map((n) => renderInlineNode(n)).join('')
}

function renderInlineNode(node: PhrasingContent): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value)
    case 'inlineCode':
      return `<code>${escapeHtml(node.value)}</code>`
    case 'strong':
      return `<strong>${renderInline(node.children)}</strong>`
    case 'emphasis':
      return `<em>${renderInline(node.children)}</em>`
    case 'delete':
      return `<del>${renderInline(node.children)}</del>`
    case 'link': {
      const href = node.url
      return isSafeHref(href)
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${renderInline(node.children)}</a>`
        : renderInline(node.children)
    }
    case 'image': {
      const src = node.url
      const alt = escapeHtml(node.alt ?? '')
      // PDF 输出无法异步解析图片（主进程 printToPDF 是同步时机）；
      // 仅放行已经能直接加载的绝对 URL（http/https/file），相对路径
      // 在 PDF 里降级为占位文本，提示用户切换为绝对 URL。
      if (isSafeHref(src)) {
        return `<img src="${escapeHtml(src)}" alt="${alt}" />`
      }
      return `<span class="md-image-blocked">${alt || '(相对图片在 PDF 中不可用)'}</span>`
    }
    case 'break':
      return '<br />'
    case 'html':
      return escapeHtml(node.value)
    default:
      return ''
  }
}

function mdastTableToHtml(node: Table): string {
  const [head, ...rows] = node.children
  let html = '<table><thead>'
  if (head) {
    html += '<tr>' + head.children.map((c) => {
      const align = (c as { align?: string | null }).align
      return `<th${align ? ` align="${align}"` : ''}>${renderInline(c.children)}</th>`
    }).join('') + '</tr>'
    html += '</thead><tbody>'
    html += rows.map((row) => '<tr>' + row.children.map((c) => {
      const align = (c as { align?: string | null }).align
      return `<td${align ? ` align="${align}"` : ''}>${renderInline(c.children)}</td>`
    }).join('') + '</tr>').join('')
    html += '</tbody>'
  }
  return html + '</table>'
}

/**
 * 把渲染好的 markdown body 包成完整 HTML 文档（CSS 内联）。
 */
export function wrapPrintableHtml({ title, body }: { title: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 14mm 16mm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    font-size: 13px;
    line-height: 1.65;
    color: #1f2328;
    background: #ffffff;
    margin: 0;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, h4, h5, h6 {
    color: #1f2328;
    margin-top: 1.6em;
    margin-bottom: 0.6em;
    line-height: 1.3;
    font-weight: 600;
    page-break-after: avoid;
  }
  h1 { font-size: 24px; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
  h2 { font-size: 20px; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.2em; }
  h3 { font-size: 16px; }
  h4 { font-size: 14px; }
  p { margin: 0.6em 0; }
  a { color: #0969da; text-decoration: none; }
  ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0.8em 0;
    padding: 0.4em 1em;
    border-left: 3px solid #d1d9e0;
    color: #59636e;
    background: #f6f8fa;
  }
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.92em;
    background: #f6f8fa;
    padding: 0.12em 0.4em;
    border-radius: 4px;
  }
  pre {
    background: #f6f8fa;
    padding: 12px 14px;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.5;
    page-break-inside: avoid;
  }
  pre code { background: transparent; padding: 0; }
  hr { border: 0; border-top: 1px solid #d1d9e0; margin: 1.5em 0; }
  table { border-collapse: collapse; margin: 0.8em 0; }
  th, td { border: 1px solid #d1d9e0; padding: 6px 10px; }
  th { background: #f6f8fa; }
  img { max-width: 100%; height: auto; border-radius: 6px; margin: 0.4em 0; page-break-inside: avoid; }
  .note-print-title {
    font-size: 26px;
    font-weight: 700;
    margin: 0 0 0.4em 0;
    border-bottom: 2px solid #1f2328;
    padding-bottom: 0.4em;
  }
  .note-print-meta {
    color: #59636e;
    font-size: 11px;
    margin-bottom: 1.4em;
  }
  .md-image-blocked {
    color: #8b949e;
    font-style: italic;
    background: #f6f8fa;
    padding: 2px 6px;
    border-radius: 4px;
  }
</style>
</head>
<body>
  <h1 class="note-print-title">${escapeHtml(title)}</h1>
  <div class="note-print-meta">导出于 ${new Date().toLocaleString('zh-CN')}</div>
  ${body}
</body>
</html>`
}
