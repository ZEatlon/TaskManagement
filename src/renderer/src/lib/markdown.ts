/**
 * Markdown 渲染辅助模块
 *
 * 设计思路：
 *   1. 不依赖 markdown-it 的 KaTeX / Mermaid 插件（这些插件未随项目安装）。
 *   2. 在交给 markdown-it 之前，先用正则把数学公式（$$..$$ / $..$）和 Mermaid 代码块
 *      替换成纯文本哨兵（<<<MERMAID:n>>> / <<<MATH:n>>>），markdown-it 会把它们当作
 *      普通文本输出。
 *   3. markdown-it 始终以 html:false 渲染 —— 这样任何用户输入的 `<script>` /
 *      `<img onerror=...>` / `<iframe>` 都会被自动转义，不会出现 R7S-1 那种 XSS。
 *   4. 渲染完成后我们再用占位符替换回受控的 <pre>/<span> HTML（属性值经转义），
 *      由渲染组件进一步换成真正的 KaTeX / Mermaid React 节点。
 *
 * 安全性（R7S-1）：
 *   - 不再走 html:true 路径；用户原文里的 <script>/<iframe>/<svg onload=...> 等
 *     都会被 markdown-it 自动 escape，永远不会出现在 dangerouslySetInnerHTML 中。
 *   - 占位符只由我们自己的后处理注入，且属性值经过 escapeForAttr 转义。
 */
import MarkdownIt from 'markdown-it'

/** 哨兵格式：纯 ASCII，markdown-it 会作为文本保留，且容易正则匹配。 */
const MERMAID_SENTINEL_RE = /<<<MERMAID:(\d+)>>>/g
const MATH_SENTINEL_RE = /<<<MATH:(\d+)>>>/g

/** Mermaid 占位符正则（用于从最终 HTML 中抽取源码）。 */
const MERMAID_PLACEHOLDER_RE =
  /<pre class="mermaid-placeholder" data-source="([\s\S]*?)" data-idx="(\d+)"><\/pre>/g

/** Math 占位符正则。 */
const MATH_PLACEHOLDER_RE =
  /<span class="math-placeholder" data-tex="([\s\S]*?)" data-display="(true|false)" data-idx="(\d+)"><\/span>/g

/** 单例 markdown-it 实例；通过 set() 在 html:true/false 间切换。 */
let mdInstance: MarkdownIt | null = null
function getMd(): MarkdownIt {
  if (!mdInstance) {
    mdInstance = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: false,
      // typographer 会改写引号，中文场景容易触发奇怪替换，这里关掉
      typographer: false
    })
  }
  return mdInstance
}

/**
 * HTML 属性里出现 `"` 时做最小化转义——我们用 `&quot;` 保留原字符，
 * 这样 data-source / data-tex 解码后能 1:1 还原。
 *
 * 注意：`<` `>` 不需要在这里转义，因为属性值在引号内是字面量，markdown-it 会
 * 把它们当作属性字符串的一部分保留下来。
 */
function escapeForAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** 反向：把 HTML 属性值还原成原始字符串。 */
function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/**
 * 抽取 ```mermaid ... ``` 块，替换为纯文本哨兵（markdown-it 会当作文本输出）。
 * 没有正确闭合的 ``` 视为普通代码块（不替换，避免错位）。
 */
function preprocessMermaid(input: string): { text: string; sources: string[] } {
  const sources: string[] = []
  const re = /```\s*mermaid\s*\n([\s\S]*?)(?:```|$)/g
  let result = ''
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    const fullMatch = m[0]
    const inner = m[1]
    if (!fullMatch.endsWith('```')) continue
    result += input.slice(lastIndex, m.index)
    const idx = sources.length
    sources.push(inner.replace(/\n$/, ''))
    // R7S-1：哨兵是纯文本而不是 HTML —— markdown-it 即使 html:true 也会保留，
    // 但我们改用 html:false 后哨兵仍能透传，XSS 攻击面关闭。
    result += `<<<MERMAID:${idx}>>>`
    lastIndex = m.index + fullMatch.length
    re.lastIndex = lastIndex
  }
  result += input.slice(lastIndex)
  return { text: result, sources }
}

/**
 * 抽取 $$ ... $$ (display) 和 $ ... $ (inline) 公式。
 *   - display 优先匹配，剩余区域再做 inline，避免冲突。
 *   - inline 不能跨行（TeX 单行公式），遇到换行直接丢弃这次尝试。
 *   - 反斜杠转义的 \$ 视为普通美元符（不当作公式边界）。
 */
function preprocessMath(input: string): {
  text: string
  blocks: { tex: string; display: boolean }[]
} {
  const blocks: { tex: string; display: boolean }[] = []

  // 1) display: $$ ... $$
  const dispRe = /\$\$([\s\S]+?)\$\$/g
  let stage1 = ''
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = dispRe.exec(input)) !== null) {
    stage1 += input.slice(lastIndex, m.index)
    const idx = blocks.length
    const tex = m[1].trim()
    blocks.push({ tex, display: true })
    // R7S-1：哨兵而非 HTML —— markdown-it html:false 也能透传
    stage1 += `<<<MATH:${idx}>>>`
    lastIndex = m.index + m[0].length
    dispRe.lastIndex = lastIndex
  }
  stage1 += input.slice(lastIndex)

  // 2) inline: $ ... $，单行
  const inlineRe = /(^|[^\\$])\$([^\n$]+?)\$(?!\d)/g
  let stage2 = ''
  lastIndex = 0
  while ((m = inlineRe.exec(stage1)) !== null) {
    const lead = m[1] ?? ''
    stage2 += stage1.slice(lastIndex, m.index) + lead
    const idx = blocks.length
    const tex = m[2].trim()
    blocks.push({ tex, display: false })
    // R7S-1：哨兵
    stage2 += `<<<MATH:${idx}>>>`
    lastIndex = m.index + m[0].length
    inlineRe.lastIndex = lastIndex
  }
  stage2 += stage1.slice(lastIndex)

  return { text: stage2, blocks }
}

/**
 * 将 sentinel 文本替换为受控的占位符 HTML（属性值经转义）。
 * 这是 R7S-1 修复的核心：用户原文永远不会被原样拼接进 HTML。
 */
function injectPlaceholders(
  html: string,
  mermaidSources: string[],
  mathBlocks: { tex: string; display: boolean }[],
): string {
  // mermaid: <pre class="mermaid-placeholder" data-source="..." data-idx="N"></pre>
  html = html.replace(MERMAID_SENTINEL_RE, (_full, idxStr: string) => {
    const idx = Number(idxStr)
    const src = mermaidSources[idx]
    if (src === undefined) return ''
    return `<pre class="mermaid-placeholder" data-source="${escapeForAttr(src)}" data-idx="${idx}"></pre>`
  })
  // math: <span class="math-placeholder" data-tex="..." data-display="..." data-idx="N"></span>
  html = html.replace(MATH_SENTINEL_RE, (_full, idxStr: string) => {
    const idx = Number(idxStr)
    const b = mathBlocks[idx]
    if (!b) return ''
    return `<span class="math-placeholder" data-tex="${escapeForAttr(b.tex)}" data-display="${b.display ? 'true' : 'false'}" data-idx="${idx}"></span>`
  })
  return html
}

/**
 * 解析 Markdown 并返回 HTML，HTML 中保留数学 / Mermaid 占位符。
 */
export function renderMarkdown(content: string): string {
  // 第一步：抽取 mermaid / math，替换为哨兵（纯文本，markdown-it html:false
  // 也能原样保留 —— 不会引入 XSS）。
  const { text: mermaidReplaced, sources: mermaidSources } = preprocessMermaid(content)
  const { text: mathReplaced, blocks: mathBlocks } = preprocessMath(mermaidReplaced)

  // 第二步：html:false 渲染 —— 用户原文里的 <script>/<iframe>/<img onerror> 全部转义
  const html = getMd().render(mathReplaced)

  // 第三步：把哨兵替换成受控的占位符 HTML（属性值已经过转义）
  return injectPlaceholders(html, mermaidSources, mathBlocks)
}

/** 从最终 HTML 中抽取 Mermaid 占位符及对应的源码。 */
export function extractMermaidBlocks(html: string): { placeholder: string; source: string }[] {
  const out: { placeholder: string; source: string }[] = []
  MERMAID_PLACEHOLDER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MERMAID_PLACEHOLDER_RE.exec(html)) !== null) {
    out.push({
      placeholder: m[0],
      source: unescapeAttr(m[1])
    })
  }
  return out
}

/** 从最终 HTML 中抽取数学占位符及对应 TeX。 */
export function extractMathBlocks(
  html: string
): { placeholder: string; tex: string; display: boolean }[] {
  const out: { placeholder: string; tex: string; display: boolean }[] = []
  MATH_PLACEHOLDER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MATH_PLACEHOLDER_RE.exec(html)) !== null) {
    out.push({
      placeholder: m[0],
      tex: unescapeAttr(m[1]),
      display: m[2] === 'true'
    })
  }
  return out
}