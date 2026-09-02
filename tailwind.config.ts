import type { Config } from 'tailwindcss'

/**
 * Tailwind 配置 —— 接 TaskPilot 现有 CSS 变量主题
 *
 * 单一真源仍是 src/renderer/src/styles/index.css 里的 :root 与 [data-theme='light'] 块。
 * Tailwind 只是把这些变量映射成 utility class（如 bg-bg-base / text-text-primary），
 * 实际取值仍由现有 CSS 变量提供，避免主题逻辑分裂。
 */
export default {
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{ts,tsx}',
  ],
  // 复用现有 [data-theme="dark"] attribute —— 不引入 next-themes
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: 'var(--bg-base)',
          elevated: 'var(--bg-elevated)',
          overlay: 'var(--bg-overlay)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        // shadcn 标准语义色 —— 映射到现有 token，与未迁移组件保持一致
        background: 'var(--bg-base)',
        foreground: 'var(--text-primary)',
        primary: {
          DEFAULT: 'var(--accent)',
          foreground: '#ffffff',
        },
        muted: {
          DEFAULT: 'var(--bg-overlay)',
          foreground: 'var(--text-muted)',
        },
        ring: 'var(--accent)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
} satisfies Config