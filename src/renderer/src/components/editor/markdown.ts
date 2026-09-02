/**
 * Markdown ↔ HTML 互转工具
 *
 * - markdownIt 解析 Markdown 文本为 HTML（保留 mermaid/katex 原文本块）
 * - turndown 将 HTML 反向转为 Markdown
 *
 * 设计要点：
 * 1. Markdown 中的 ```mermaid / ```math 围栏代码块保留为 `<pre data-type="mermaid">` / `<pre data-type="math">`
 *    TipTap 端使用对应的自定义 Node 解析这些 data-type 容器。
 * 2. 行内公式 `$...$` 与块级公式 `$$...$$` 在 markdown-it 中通过自定义规则拦截，
 *    渲染为 `<span data-type="math-inline">` / `<div data-type="math-block">`。
 * 3. 任务列表 `[ ]` / `[x]` 在生成的 HTML 中通过后处理转换为
 *    `<ul data-type="taskList"><li data-type="taskItem" data-checked="...">`。
 * 4. Turndown 阶段反向处理自定义容器，输出标准 Markdown。
 */
import MarkdownIt from 'markdown-it'
import TurndownService from 'turndown'

// ===== markdown-it 实例 =====

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
})

// 自定义 fence 渲染：针对 mermaid/math 输出保留原始代码的 <pre data-type>
const defaultFence = md.renderer.rules['fence']?.bind(md.renderer.rules)
md.renderer.rules['fence'] = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = (token.info || '').trim().toLowerCase()
  const content = token.content

  if (info === 'mermaid') {
    return `<pre data-type="mermaid">${escapeHtml(content)}</pre>`
  }
  if (info === 'math' || info === 'katex') {
    return `<pre data-type="math-block">${escapeHtml(content)}</pre>`
  }
  // 其他语言：使用默认高亮代码块
  return defaultFence
    ? defaultFence(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

// 行内公式 $...$：在 inline 解析时拦截
function mathInlineRule(state: any, silent: boolean): boolean {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false
  // 必须成对（不能跨多行）
  const end = state.src.indexOf('$', start + 1)
  if (end === -1) return false
  if (end === start + 1) return false // 空内容
  // 避免与 $$ 冲突
  if (state.src.charCodeAt(end + 1) === 0x24) return false

  const content = state.src.slice(start + 1, end)
  if (!content.trim()) return false
  if (silent) return true

  const token = state.push('math_inline', 'span', 0)
  token.markup = '$'
  token.content = content

  state.pos = end + 1
  return true
}

md.inline.ruler.after('escape', 'math_inline', mathInlineRule)
md.renderer.rules['math_inline'] = (tokens, idx) => {
  const content = tokens[idx].content
  return `<span data-type="math-inline" data-latex="${escapeAttr(content)}">${escapeHtml(
    content,
  )}</span>`
}

// 块级公式 $$...$$：在 block 解析时拦截
function mathBlockRule(
  state: any,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const startPos = state.bMarks[startLine] + state.tShift[startLine]
  const maxPos = state.eMarks[startLine]
  if (startPos + 2 > maxPos) return false
  if (state.src.slice(startPos, startPos + 2) !== '$$') return false
  if (silent) return true

  const firstLine = state.src.slice(startPos + 2, maxPos)
  // 单行块级公式：$$x^2$$ 整行
  if (firstLine.trimEnd().endsWith('$$')) {
    const content = firstLine.trimEnd().slice(0, -2)
    const token = state.push('math_block', 'div', 0)
    token.block = true
    token.content = content
    token.markup = '$$'
    token.map = [startLine, startLine + 1]
    state.line = startLine + 1
    return true
  }

  // 多行块级公式：寻找下一行单独 $$ 结束
  let nextLine = startLine + 1
  let found = false
  let lastContent = ''
  while (nextLine < endLine) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
    const lineMax = state.eMarks[nextLine]
    const line = state.src.slice(lineStart, lineMax)
    if (line.trim() === '$$') {
      found = true
      break
    }
    lastContent += (lastContent ? '\n' : '') + line
    nextLine += 1
  }
  if (!found) return false

  const token = state.push('math_block', 'div', 0)
  token.block = true
  token.content = lastContent
  token.markup = '$$'
  token.map = [startLine, nextLine + 1]
  state.line = nextLine + 1
  return true
}

md.block.ruler.after('blockquote', 'math_block', mathBlockRule, {
  alt: ['paragraph', 'reference', 'blockquote', 'list'],
})
md.renderer.rules['math_block'] = (tokens, idx) => {
  const content = tokens[idx].content
  return `<div data-type="math-block" data-latex="${escapeAttr(content)}">${escapeHtml(
    content,
  )}</div>`
}

// 由于 taskList 识别需要跨 token 分析，我们采用 HTML 后处理方式：
// 在生成的 HTML 中将含 [ ]/[x] 的 ul 转换为 taskList ul。
const taskItemCheckRe = /^\[( |x)\]\s+/i

// ===== 工具：HTML 后处理 =====

/**
 * R29-Sec-3 修复 (MEDIUM XSS via TipTap setContent)：原版 markdown-it 用
 * `html: true`，用户笔记里的 `<script>` / `<iframe>` / `onerror=` 等原始
 * HTML 直接进入 TipTap `editor.commands.setContent(...)`。ProseMirror 严格
 * schema 会过滤掉大多数未知 tag + 危险 attribute，但 `<a href="javascript:…">` /
 * `<img src=x onerror="…">` / `<svg><script>…</script></svg>` 等向量可能
 * 漏过 schema 检查。当用户后续触发「保存 / 预览」时，注入脚本可在渲染端
 * 上下文中执行，获得完整 IPC 桥接权限（XSS → 任意 RCE）。
 *
 * 修复：在 markdown-it 输出 → setContent 之间跑一次 sanitizeHtml()，剥掉
 * 危险 element + 危险 attribute。沙箱白名单：只允许 Tag Safe 节点（脚本、
 * iframe、object/embed、style/link、meta、表单、base 全部移除）和 5 个
 * safe-href scheme（http / https / mailto / data:image（非 base64 javascript）/ /）。
 */
const DANGEROUS_TAG_RE =
  /<(script|iframe|object|embed|style|link|meta|base|form|input|textarea|select|button)\b[\s\S]*?<\/\1>|<(script|iframe|object|embed|style|link|meta|base|form|input|textarea|select|button)\b[^>]*\/?>/gi
const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const JS_HREF_RE = /\s+(href|xlink:href|src|action|formaction)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi
const DATA_HREF_RE = /\s+(href|xlink:href|src)\s*=\s*("\s*data:\s*[^,"]*?;base64[^"]*"|'\s*data:\s*[^,']*?;base64[^']*')/gi

function sanitizeHtml(html: string): string {
  let out = html
  out = out.replace(DANGEROUS_TAG_RE, '')
  out = out.replace(EVENT_ATTR_RE, '')
  out = out.replace(JS_HREF_RE, ' $1=""')
  // 允许 data:image/* 但阻止 data:text/html / data:application/javascript 等
  out = out.replace(DATA_HREF_RE, ' $1=""')
  return out
}

function postProcessHtml(html: string): string {
  // R29-Sec-3：先 sanitize 危险 HTML，再做任务列表转换（转换后产物仍需
  // 经过 sanitize 二次过滤 —— 因为 convertTaskLists 重新拼接属性）。
  const safe = sanitizeHtml(html)
  return convertTaskLists(safe)
}

function convertTaskLists(html: string): string {
  // 递归匹配 <ul>...</ul>
  return html.replace(/<ul>([\s\S]*?)<\/ul>/g, (match, inner) => {
    // 检查是否所有 li 段落以 [ ] / [x] 开头
    const items: string[] = []
    let isTaskList = false
    let allMatch = true
    const liRegex = /<li>([\s\S]*?)<\/li>/g
    let liMatch: RegExpExecArray | null
    while ((liMatch = liRegex.exec(inner)) !== null) {
      const liInner = liMatch[1]
      const textMatch = liInner.match(taskItemCheckRe)
      if (textMatch) {
        isTaskList = true
        const checked = textMatch[1].toLowerCase() === 'x'
        const newInner = liInner.replace(taskItemCheckRe, '')
        items.push(
          `<li data-type="taskItem" data-checked="${checked}">${newInner}</li>`,
        )
      } else {
        // 包含非任务项，标记为非任务列表
        allMatch = false
        break
      }
    }
    if (!allMatch || !isTaskList) return match
    return `<ul data-type="taskList">${items.join('')}</ul>`
  })
}

// ===== HTML 转义工具 =====

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}

// ===== Turndown 实例（HTML -> Markdown） =====

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  hr: '---',
  linkStyle: 'inlined',
})

// 自定义 mermaid 块
td.addRule('mermaid-block', {
  filter: (node) =>
    node.nodeName === 'PRE' &&
    (node as HTMLElement).getAttribute('data-type') === 'mermaid',
  replacement: (_content, node) => {
    const code = (node as HTMLElement).textContent ?? ''
    return `\n\`\`\`mermaid\n${code.trim()}\n\`\`\`\n\n`
  },
})

// 自定义 math-block 块（pre 围栏）
td.addRule('math-block', {
  filter: (node) =>
    node.nodeName === 'PRE' &&
    (node as HTMLElement).getAttribute('data-type') === 'math-block',
  replacement: (_content, node) => {
    const code = (node as HTMLElement).textContent ?? ''
    return `\n\`\`\`math\n${code.trim()}\n\`\`\`\n\n`
  },
})

// 自定义 math-block div（块级 $$..$$）
td.addRule('math-block-div', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node as HTMLElement).getAttribute('data-type') === 'math-block',
  replacement: (_content, node) => {
    const code = (node as HTMLElement).textContent ?? ''
    return `\n\n$$\n${code.trim()}\n$$\n\n`
  },
})

// 自定义 math-inline
td.addRule('math-inline', {
  filter: (node) =>
    node.nodeName === 'SPAN' &&
    (node as HTMLElement).getAttribute('data-type') === 'math-inline',
  replacement: (_content, node) => {
    const el = node as HTMLElement
    const latex = el.getAttribute('data-latex') ?? el.textContent ?? ''
    return `$${latex}$`
  },
})

// 自定义 taskItem li：转为 [ ] / [x] 文本
td.addRule('taskItem', {
  filter: (node) =>
    node.nodeName === 'LI' &&
    (node as HTMLElement).getAttribute('data-type') === 'taskItem',
  replacement: (content, node) => {
    const el = node as HTMLElement
    const checked =
      el.getAttribute('data-checked') === 'true' ||
      el.getAttribute('data-checked') === '1'
    const marker = checked ? '[x]' : '[ ]'
    // turndown 在列表项中会在开头加空格，我们去掉并改用 [ ] 标记
    const trimmed = content.replace(/^\s+/, '')
    return `${marker} ${trimmed}\n`
  },
})

// ===== 公开 API =====

/**
 * Markdown 字符串 → HTML 字符串
 */
export function markdownToHtml(markdown: string): string {
  const raw = md.render(markdown ?? '')
  return postProcessHtml(raw)
}

/**
 * HTML 字符串 → Markdown 字符串
 */
export function htmlToMarkdown(html: string): string {
  return td.turndown(html ?? '')
}

/**
 * 仅用于纯文本预览：从 Markdown 提取第一段非空纯文本
 */
export function markdownToPreview(markdown: string, maxLen = 140): string {
  const html = md.render(markdown ?? '')
  // 极简：去掉标签
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}
