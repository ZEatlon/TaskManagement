// ESLint v9 flat config for TaskPilot
//
// 历史：仓库以前没有 eslint 配置文件，npm run lint 一启动就报
// "Couldn't find an eslint.config.(js|mjs|cjs) file"。
//
// 目标：覆盖高价值 bug 类规则（未使用变量 / unsafe any / react-hooks
// 依赖一致性），关掉对 TS 代码库冗余或反咬的规则（no-undef 已被 tsc
// 覆盖；no-control-regex 在 sanitizer 场景里是故意写的）。
//
// 不覆盖：
//   - node_modules（默认忽略）
//   - out/、dist/、release/、logs/、coverage/、docs/（构建产物 / 文档）
//   - scripts/*.cjs / scripts/*.mjs（CommonJS / ESM 脚本，tsc 不管它们，
//     eslint 在 TS 规则下也容易误报）
//   - .claude-workflows/、.claude/（本地 Agent 运行时产物）
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'logs/**',
      'coverage/**',
      'docs/**',
      '.claude/**',
      '.claude-workflows/**',
      'scripts/**/*.cjs',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      '*.config.cjs',
      '*.config.mjs',
      '*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react: reactPlugin, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      // TS 项目里 tsc 已经覆盖；no-undef 容易对 DOM API / 全局类型误报
      'no-undef': 'off',
      // JSX 17+ 不再需要显式 import React
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      'react/no-unknown-property': ['error', { ignore: ['css'] }],
      'react/jsx-key': 'warn',
      'react/jsx-no-duplicate-props': 'error',
      'react/jsx-no-undef': 'error',
      // 这两条在 TS 4.x 后语义变化 / 频繁误报
      'react/no-children-prop': 'off',
      'react/void-dom-elements-no-children': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // 仓库里有合法用途：模板字面量里写 `${err}` 时只想吞掉异常
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // prefer-const 在 destructure + long-branch 场景经常误报，关掉以减噪
      'prefer-const': 'off',
      // 同上，刻意控制字符做 sanitization
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': 'off',
      'prefer-const': 'off',
      'no-control-regex': 'off',
    },
  },
]
