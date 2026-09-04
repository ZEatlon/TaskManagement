/**
 * 数学公式块
 *
 * 使用 KaTeX 把 TeX 源码渲染成 HTML 字符串，再注入到 DOM。
 * 失败时回退到原始 TeX 文本（用 <code> 包裹），避免整条消息崩溃。
 */
import katex from 'katex'
// 引入 KaTeX 的内置样式，组件被使用时 CSS 自动加载
import 'katex/dist/katex.min.css'

interface Props {
  tex: string
  /** true → 块级居中显示；false → 行内。 */
  display: boolean
}

export function MathBlock({ tex, display }: Props) {
  let html = ''
  let hasError = false
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      // R13 修复 (low)：显式 trust: false。KaTeX 默认是 false，
      // 但 MathNode.tsx 已经显式设置了，这里保持一致以防 KaTeX 升级或
      // 全局 .setConfig({ trust: true }) 后整条 AI 聊天路径出现 XSS。
      trust: false,
      // 输出 'html' 即 KaTeX 自带的 MathML + 字体回退样式，最适合在 Electron 渲染进程使用
      output: 'html'
    })
  } catch (err) {
    hasError = true
     
    console.warn('[MathBlock] katex render failed:', err)
  }

  if (hasError) {
    return <code className="ai-math-fallback">{tex}</code>
  }

  return (
    <span
      className={display ? 'katex-display' : 'katex-inline'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default MathBlock