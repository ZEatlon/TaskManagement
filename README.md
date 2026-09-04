# TaskPilot

> 本地优先的个人任务 + 笔记 + AI 助手桌面应用

## 特性

- 📋 **便签任务**：按日 / 按颜色 / 按状态分组，支持步骤子项、截止时间、归档、跨日、逾期高亮
- 📝 **Markdown 笔记**：TipTap WYSIWYG 编辑器 + 代码高亮 + Mermaid 图表 + KaTeX 公式
- 🔥 **贡献热力图**：GitHub 风格可视化每日完成度，可调时间窗与一周起始日
- 🤖 **AI 助手**：⌘K 命令面板 + 多 provider（MiniMax / OpenAI / Anthropic / 自定义 OpenAI 兼容），流式输出 / 工具调用 / 笔记引用
- ⏱ **番茄钟**：工作 / 短休 / 长休三段计时，绑定任务后自动写入热力图
- 🗂 **笔记库**：本地 SQLite + JSON 快照 + isomorphic-git 推送任意 Git 仓库
- 🔒 **离线 + 加密**：SQLCipher 加密本地数据库，API key 走 OS keychain（safeStorage）

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Electron 33 LTS |
| 构建 | electron-vite + electron-builder |
| UI | React 18 + TypeScript 5.7 |
| 路由 | TanStack Router（memory history） |
| 状态 | Zustand |
| 编辑器 | TipTap v2（含 lowlight / katex / mermaid 扩展） |
| 数据库 | better-sqlite3 v13（sidecar Node 子进程）+ SQLCipher |
| 同步 | isomorphic-git |
| AI | 多 provider 抽象（OpenAI 兼容协议），自家 MiniMax / OpenAI / Anthropic adapter |
| 图像 | Sharp（lazy import，asarUnpack） |
| 样式 | Tailwind + CSS Variables（深 / 浅主题切换） |

## 快速开始

```bash
# 安装依赖（自动处理原生模块 + Electron 二进制）
npm install

# 开发模式（HMR + DevTools）
npm run dev

# 类型检查（main + renderer 两套 tsconfig）
npm run typecheck

# 代码风格
npm run lint

# 打包（dir 模式 —— 不压缩，便于调试）
npm run package

# 打包（生成 portable.exe / dmg 安装包）
npm run dist
```

> 详细安装与排错（含 better-sqlite3 sidecar、原生模块镜像、Electron 镜像）参见 [`docs/setup.md`](docs/setup.md)。

## 项目结构

```
src/
├── main/                # 主进程（Node）
│   ├── index.ts         # 入口 + 全局 IPC 注册 + 安全网关
│   ├── window/          # BrowserWindow 生命周期
│   ├── ipc/             # 17 个 IPC handler 模块（白名单 channel）
│   ├── db/              # better-sqlite3 + 子进程 worker
│   ├── git/             # isomorphic-git 封装
│   ├── ai/              # AI provider 路由 + 工具调用 + 自动标题
│   ├── notes/           # 笔记文件 IO + path safety + frontmatter
│   ├── security/        # safeStorage 密钥管理
│   ├── scheduler/       # cron + RRULE 定时
│   ├── attachments/     # 图片 / 文件附件（Sharp 处理）
│   ├── pomodoro/        # 番茄钟状态机
│   └── notifications/   # 系统通知
├── preload/             # contextBridge 暴露 window.api
├── renderer/            # 渲染进程（Chromium + React）
│   ├── index.html
│   └── src/
│       ├── main.tsx     # React 入口（ErrorBoundary + 路由）
│       ├── router.tsx   # TanStack Router 配置
│       ├── routes/      # 5 个页面（dashboard / today / notes / settings / ai）
│       ├── components/  # layout / sticky-notes / notes / ai / dashboard / ...
│       ├── stores/      # Zustand（stickyNotes / notes / ai / pomodoro / settings / git / heatmap / draft）
│       ├── lib/         # 工具（ipc / 日期 / fuzzy / ipc channels）
│       └── styles/      # CSS + Tailwind
└── shared/              # 主/渲染进程共用（type + ipc channel 常量）
    ├── ipc/
    └── types/
```

## 架构要点

- **三层进程**：`main`（Node）/ `preload`（contextBridge）/ `renderer`（React）。Renderer 只能通过 `window.api.invoke` 进入主进程，主进程的 IPC channel 是白名单（`src/shared/ipc/channels.ts`）。
- **本地优先 + 可选同步**：默认数据全在 `%APPDATA%/taskpilot/data.db`（SQLCipher 加密）。同步是可选的：在设置里配置 Git 仓库，应用以 JSON snapshot 推上去。
- **命令面板 ⌘K**：跨页面的统一入口，可跳转 / 新建便签 / 新建笔记 / 切换主题 / 切换 AI provider / 触发番茄钟。所有操作可纯键盘完成。
- **可拖拽 Dashboard**：widget 布局存 `localStorage`，最多 3 列，支持预设切换 + 单 widget 隐藏 + 拖拽重排。
- **安全**：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`；renderer 所有外链走 `setWindowOpenHandler` 白名单（http/https/mailto）+ DNS 反查防 SSRF；API key 走 safeStorage 加密后存盘。

## 开发路线图

- [x] **P0-模块 1**：脚手架（electron-vite + React + Vite + TanStack Router + Zustand）
- [x] **P0-模块 2**：DB 层（better-sqlite3 sidecar + SQLCipher + 迁移）
- [x] **P0-模块 3**：便签任务（CRUD + 步骤 + 跨天 + 逾期 + 归档）
- [x] **P0-模块 4**：笔记库（chokidar 文件监听 + 三态机 + frontmatter）
- [x] **P0-模块 5**：TipTap WYSIWYG 编辑器（lowlight / mermaid / katex）
- [x] **P0-模块 6**：图片粘贴拖拽（Sharp）
- [x] **P0-模块 7**：自动保存 + IndexedDB 草稿（draftStore）
- [x] **P0-模块 8**：系统通知（任务到期 + 番茄完成）
- [x] **P0-模块 9**：库目录选择模态框
- [x] **P0-模块 10**：热力图 + 历史回填
- [x] **P0-模块 11**：Dashboard 骨架 + 可拖拽 widget
- [x] **P0-模块 12**：Git 同步（isomorphic-git + 安全网关）
- [x] **P0-模块 13**：设置页 + AI 多 provider
- [x] **P0-模块 14**：番茄钟 + 仪表盘日历
- [x] **P0-模块 15**：AI 命令面板（⌘K）+ 工具调用
- [x] **P0-模块 16**：Mermaid / KaTeX 渲染 + 暗色主题适配
- [x] **P0-模块 17**：a11y 收敛（ARIA / keyboard trap / focus restore）
- [ ] **P1**：插件机制（沙箱 worker + 权限白名单）
- [ ] **P1**：多窗口（便签独立窗口）
- [ ] **P2**：移动端伴侣（仅查看 + 勾选）

## 脚本一览

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（自愈 zombie electron 进程、清 ELECTRON_RUN_AS_NODE） |
| `npm run build` | electron-vite 三段构建（main + preload + renderer） |
| `npm run typecheck` | tsc 检查（main + web 两套 tsconfig） |
| `npm run lint` | ESLint v9 flat config + react-hooks |
| `npm run format` | Prettier |
| `npm run fuses` | Electron fuses（关闭特定 surface） |
| `npm run rebuild:native` | `electron-builder install-app-deps` |
| `npm run package` | electron-builder --dir（不打包，便于调试） |
| `npm run dist` | electron-builder 生成 portable.exe / dmg |
| `npm run icons` | 从 `build/icon.svg` 生成 ICO / PNG / ICNS |

## 许可证

MIT
