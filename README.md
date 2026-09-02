# TaskPilot

> 本地优先的个人任务 + 笔记 + AI 助手桌面应用

## 特性

- 📋 **任务管理**：四象限、标签嵌套、子任务、番茄钟
- 📝 **Markdown 笔记**：WYSIWYG 编辑器 + Mermaid + KaTeX
- 🔥 **贡献热力图**：GitHub 风格可视化进度
- 🤖 **AI 助手**：OpenAI / Anthropic 双 Provider，云端优先
- ☁ **Git 同步**：本地笔记库自动备份
- ⏰ **定时任务**：cron 与 RRULE 双重支持
- 🍅 **番茄钟**：内置专注计时

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Electron 33 LTS |
| 构建 | electron-vite |
| UI | React 18 + TypeScript 5.7 |
| 路由 | TanStack Router |
| 状态 | Zustand |
| 编辑器 | TipTap v2 |
| 数据库 | better-sqlite3 |
| 图表 | Mermaid + KaTeX |
| 同步 | isomorphic-git |

## 快速开始

```bash
# 安装依赖（自动重新编译原生模块）
npm install

# 开发模式
npm run dev

# 类型检查
npm run typecheck

# 打包（dir 模式）
npm run package

# 打包（生成安装包）
npm run dist
```

> **关于 better-sqlite3**：当前脚手架阶段（模块1）暂未引入 `better-sqlite3`，避免与 Node v24 的预编译二进制兼容性问题。将在 **P0-模块2（DB 层）** 中引入，预期使用 `v11.7+` 或 `v12.x` 已带 Node 24 prebuild 的版本，并通过 `electron-builder install-app-deps` 自动重建为 Electron 33 的 Node ABI。

## 项目结构

```
src/
├── main/              # 主进程
│   ├── index.ts       # 入口
│   ├── window/        # 窗口管理
│   ├── ipc/           # IPC 路由
│   └── log.ts         # 日志
├── preload/           # Preload 脚本
│   └── index.ts       # contextBridge
├── renderer/          # 渲染进程
│   ├── index.html
│   └── src/
│       ├── main.tsx   # React 入口
│       ├── router.tsx
│       ├── routes/    # 页面
│       ├── components/
│       ├── stores/    # Zustand
│       └── styles/
└── shared/            # 主/渲染进程共用
    ├── ipc/
    └── types/
```

## 开发路线图

- [x] **P0-模块 1**：脚手架（electron-vite + React + Vite + TanStack Router + Zustand）
- [ ] **P0-模块 2**：DB 层（better-sqlite3 + Keychain + 迁移）
- [ ] **P0-模块 3**：任务模块（CRUD + Today 视图）
- [ ] **P0-模块 4**：笔记库（chokidar + 三态机）
- [ ] **P0-模块 5**：TipTap WYSIWYG 编辑器
- [ ] **P0-模块 6**：图片粘贴拖拽（Sharp）
- [ ] **P0-模块 7**：自动保存 + IndexedDB 草稿
- [ ] **P0-模块 8**：系统通知（任务到期）
- [ ] **P0-模块 9**：库目录选择模态框
- [ ] **P0-模块 10**：热力图 + 历史回填
- [ ] **P0-模块 11**：Dashboard 骨架
- [ ] **P0-模块 12**：Git 同步基础
- [ ] **P0-模块 13**：设置页 8 tab 骨架

## 许可证

MIT