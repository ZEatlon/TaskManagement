/**
 * CodeBlockWithHighlight - 基于 lowlight 的代码块高亮扩展
 *
 * - 替代 StarterKit 自带的 codeBlock
 * - 使用 lowlight v3 + highlight.js 自动识别语言（fallback 到 plaintext）
 * - 通过 renderHTML 输出带 class 的 token 元素，CSS 用 .hljs-* 选择器着色
 */
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'

// 使用 common 语言集合（覆盖主流语言），按需通过 setLanguage API 切换
export const lowlight = createLowlight(common)

export const CodeBlockWithHighlight = CodeBlockLowlight.extend({
  name: 'codeBlock',
  // 默认语言为空字符串，让 lowlight 自动推断
}).configure({
  lowlight,
  defaultLanguage: 'plaintext',
  // 不在 HTML 中输出 language class，由 CSS 处理
  HTMLAttributes: {
    class: 'code-block',
  },
})
