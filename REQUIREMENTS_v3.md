# TaskPilot 需求规格说明书 v3

## 0. 文档元信息

- **版本**：v3.0
- **日期**：2026-08-30
- **变更说明**：
  - **架构变更**：技术栈从 Next.js 切换至 **Vite + React + electron-vite**（Next.js 在 Electron 中需要静态导出，得不偿失；Vite + React 更适合纯桌面应用）。
  - **加密决策**：移除 SQLCipher，改为 **better-sqlite3 不加密**；仅 API Key 等凭据走系统 Keychain（safeStorage / keytar）。
  - **重复规则升级**：从通用 cron 思路升级为 **RRULE (RFC 5545)**，使用 `rrule.js` 解析，桥接 `croner` 调度器。
  - **同步方案升级**：从"仅 `.gitignore` 模板"升级为 **isomorphic-git 自动 commit + push/pull 按钮**。
  - **新增 LLM 智能化集成**（最大新增章节）：纳入 A+B+C+D 共 **20 项 AI 功能**，含多 Provider 路由、本地优先、Function Calling 规范、隐私脱敏、成本控制、评估体系。
  - **Dashboard 默认落地页**明确为 **Today 视图**（Things/TickTick 风格）。
  - **热力图回填历史**：存量数据纳入统计，不再仅从启用日起算。
  - **笔记自动文件名**：沿用 Obsidian 风格 `YYYY-MM-DD-未命名.md`，首个 H1 自动重命名。
  - **子任务层级**：锁定仅两级（主 + 子），不再下分。
  - **KaTeX 数学公式**：升级为 v1 必含（v2 列为 P1 可选）。
  - **番茄钟**：保留 P1 路线图（按钮可空缺）。
  - **库目录**：首次启动模态框让用户自选，不再安装时强制。
  - **快捷键**：MVP 内置默认键全，但开放设置页用户改键。
  - **i18n**：v1 全中文。
  - **模块扩展**：从 v2 的 8 大块扩展为 **9 大块**，新增 **I. AI 智能化集成**作为 v3 标志性章节。
- **与 v2 核心差异**：从「任务 + 笔记 + 文档 + 仪表盘 + 编辑器 + 导出」扩展为「任务 + 笔记 + AI 编排 + LLM 智能化集成」的 AI-first 个人生产力工具。
- **覆盖率**：14/14 用户原话需求 + 16/16 A 类盲点 + 20/20 AI 功能 + 9 大模块。

---

## 1. 用户原话需求清单

> 优先级标记：**M** = 必须有（MVP 阻塞） · **S** = 应该有（v1 必交付） · **C** = 可以有（P1+） · **W** = 看情况

| 编号 | 用户原话 | 优先级 | 对应需求 | 状态 |
|---|---|---|---|---|
| O-1 | 贡献热力图 | S | R-1 | 纳入 |
| O-2 | 其他快捷图表 | S | R-2 | 纳入 |
| O-3 | 快捷功能 | S | R-2 | 纳入 |
| O-4 | 方便安排任务 | M | R-4 / R-5 | 纳入 |
| O-5 | 时钟表，实时显示当前的时间日历等 | S | R-3 | 纳入 |
| O-6 | 今日任务 | M | R-4 | 纳入（默认落地页）|
| O-7 | 任务编排使用 markdown 编辑器 | S | R-5 | 纳入（WYSIWYG 锁定）|
| O-8 | 支持渲染 | S | R-6 | 纳入 |
| O-9 | 支持 mermaid 内嵌渲染 | S | R-7 | 纳入 |
| O-10 | 支持 plantUML 内嵌渲染 | — | R-8 | **【已主动放弃】** |
| O-11 | 支持我来做笔记 | S | R-9 | 纳入 |
| O-12 | 和技术文档编写 | S | R-10 | 纳入 |
| O-13 | 管理本地文档（md 格式） | M | R-11 | 纳入（Obsidian 风格锁定）|
| O-14 | md 文档导出 pdf 功能 | S | R-12 | 纳入 |

**覆盖率**：14/14 = 100%，放弃项已显式标注。

### 结构化需求（来自 R-1 ~ R-12）

#### R-1 贡献热力图 【S】
- **描述**：日历网格可视化每日活跃度，颜色深浅 = 「已完成任务数 × w1」+ 「笔记写作活跃度 × w2」。
- **验收要点**：
  - GitHub contribution graph 布局，至少 365 天可滚动/缩放
  - 数据源 = `tasks_done × w1 + (chars_written 或 notes_edited) × w2`，权重在设置页可调
  - hover 显示当日明细（任务标题、笔记标题、字数）
  - 支持切换「纯任务 / 纯笔记 / 混合」三种模式
  - 当日单元格高亮
  - **【v3 新增】** **回填历史**：存量笔记和任务也参与统计（扫描全库 + 启发式推断），不仅从启用日开始
- **关键约束**：必须捕获应用外编辑（VSCode / Typora）的写作活动，外部编辑器保存一次 = 恰好一条事件。

#### R-2 快捷图表与快捷功能面板 【S】
- **描述**：主页提供常用图表 + 一键操作按钮。
- **验收要点**：
  - 至少 3 类图表（完成率趋势、状态分布、优先级分布）
  - 至少 3 个快捷入口（新建任务、新建笔记、快速搜索）
  - 图表数据实时反映当前任务库
  - 图表可点击下钻到对应任务列表
  - 快捷入口可由用户自定义顺序/增删

#### R-3 实时时钟与日历组件 【S】
- **描述**：页面常驻实时时钟 + 迷你月历。
- **验收要点**：
  - 时间每秒/分钟刷新（可配置粒度，**默认分钟**避免每秒重渲）
  - 同时显示当前日期、星期
  - 迷你月历高亮"今天"，可点击切换月份
  - 支持 12/24 小时制切换
  - 鼠标悬停显示农历/节假日（可选扩展）

#### R-4 今日任务面板 【M】
- **描述**：主页展示"今天到期 + 今日新建 + 已逾期未完成"，按优先级/时间排序。
- **验收要点**：
  - **【v3 新增】** **Dashboard 启动默认落地页 = Today 视图**（Things/TickTick 风格）
  - 自动按"今日到期 + 逾期"分组排序
  - 一键勾选完成（完成态写入 R-1 热力图统计）
  - 快速编辑任务标题/优先级/截止日期
  - 显示完成进度（如 3/8 已完成）
  - 空状态友好提示

#### R-5 任务编排用 Markdown 编辑器 【S】
- **描述**：任务描述字段使用**纯 WYSIWYG** Markdown 编辑器。
- **验收要点**：
  - **纯 WYSIWYG 模式**（不做分屏预览，已锁定）
  - 支持标准 Markdown（标题、列表、引用、代码块、表格、加粗、斜体、链接、图片）
  - `/` 命令面板插入块（标题、列表、代码块、表格、Mermaid 等）
  - 图片粘贴/拖拽上传
  - 快捷键（Ctrl+B、Ctrl+I 等）
  - 编辑器内容与任务描述双向绑定
  - **【v3 新增】** 描述字段使用 Markdown WYSIWYG（与笔记同等渲染管线）

#### R-6 Markdown 渲染 【S】
- **验收要点**：
  - 支持 GFM 规范
  - 代码块高亮（至少 50 种语言）
  - **【v3 升级】** **数学公式 LaTeX（KaTeX，必含）**
  - 渲染性能：1000 行文档 < 500ms
  - 支持复制为 Markdown 源码 / 富文本

#### R-7 Mermaid 内嵌渲染 【S】
- **验收要点**：
  - 支持 flowchart、sequenceDiagram、gantt、classDiagram、stateDiagram、erDiagram、pie 等
  - 编辑实时渲染（防抖 300ms）
  - 支持主题切换（默认/暗色/自定义）
  - 渲染失败时给出明确错误位置
  - 支持导出为 SVG/PNG

#### R-8 ~~PlantUML 内嵌渲染~~ 【已放弃】
- **状态**：用户主动决策"只支持 Mermaid，不支持 PlantUML"。
- **禁令**：研究/实现/依赖引入阶段均不得引入 PlantUML 渲染器、PlantUML 服务端、PlantUML 相关依赖。

#### R-9 笔记功能 【S】
- **验收要点**：
  - 列表支持按更新时间/创建时间/标题排序
  - 全文搜索（标题 + 正文）
  - 标签分类
  - 按笔记本/标签/时间筛选
  - 创建/编辑活动自动写入 R-1 热力图
  - 删除支持回收站（30 天可恢复）
  - **【v3 新增】** 自动文件名 `YYYY-MM-DD-未命名.md`，首个 H1 自动重命名

#### R-10 技术文档编写能力 【S】
- **验收要点**：
  - 代码块右上角"复制"按钮 + 语言标识
  - 文档头部自动生成 TOC
  - 支持 Markdown 导入/导出
  - 多级标题折叠/展开
  - 行内代码 + 语法高亮

#### R-11 本地 MD 文档管理（Obsidian 风格）【M】
- **验收要点**：
  - 存储模型 = 文件夹树 + 纯 `.md` 文件（已锁定）
  - **【v3 修订】** **文档根目录在首次打开应用时弹模态框由用户自选**，保存到 `appConfig.json`
  - 文件夹的 CRUD 与 UI 完全同步
  - 应用内编辑后自动写回磁盘（debounce 500ms）
  - 磁盘文件被外部修改后 UI 自动检测并提示重载
  - 支持 `.md` 文件的导入（拖入文件夹即出现在笔记列表）
  - 文件名/文件夹名不与应用层 ID 耦合

#### R-12 Markdown 文档导出 PDF 【S】
- **验收要点**：
  - 一键导出按钮位于编辑器工具栏
  - PDF 正确渲染 Markdown、Mermaid、代码高亮、图片、数学公式（KaTeX）
  - 自定义页眉页脚（标题、日期、作者）
  - A4 / Letter 切换
  - 选择导出范围（整篇 / 选中部分）
  - 默认存放用户指定目录，可重命名
  - **【v3 确认】** 不支持 PDF 密码（与 printToPDF 兼容性差，V2 再加）

---

## 2. 用户已锁定的关键决策（v3 更新）

> 约束传导规则：以下决策具有最高优先级，与之冲突的任何研究结论、用户后续口述、第三方推荐一律以决策为准。

| # | 决策项 | 决策内容 | 违反后果 |
|---|---|---|---|
| **D-1** | 热力图数据源 | **任务完成数 + 笔记写作活动**（字数/编辑次数混合）| 缺一项则热力图漏掉一半生产活动 |
| **D-2** | 本地文档存储 | **文件夹 + 纯 .md 文件**（Obsidian 风格）| 数据库内嵌存储直接违反；外部工具必须能直接打开 |
| **D-3** | PlantUML | **不支持**，研究/实现/依赖引入均禁止 | 引入即视为违反用户决策，需立即回滚 |
| **D-4** | Markdown 编辑器模式 | **纯 WYSIWYG**（Notion/飞书文档风格），不做分屏预览 | 分屏预览模式直接违反 |
| **D-5** 【v3 新增】 | 技术栈 | **Vite + React + electron-vite**（**不是** Next.js）| Next.js 在 Electron 静态导出得不偿失 |
| **D-6** 【v3 新增】 | 数据库加密 | **better-sqlite3 不加密**；仅 API Key 等凭据走系统 Keychain（safeStorage / keytar）| 引入 SQLCipher 即违反 |
| **D-7** 【v3 新增】 | 库目录选择时机 | **首次打开应用时让用户自选**（不强制安装时一次性选定）| 安装向导硬编码路径即违反 |
| **D-8** 【v3 新增】 | 热力图回填 | **回填历史**（已存在的笔记/任务也纳入统计）| 仅从启用日起算即违反 |
| **D-9** 【v3 新增】 | Dashboard 默认视图 | **Today 视图**（Things/TickTick 风格）| 默认进 Dashboard 总览即违反 |
| **D-10** 【v3 新增】 | 笔记自动文件名 | **Obsidian 风格** `YYYY-MM-DD-未命名.md`，首个 H1 自动重命名 | 强制起名/UUID 即违反 |
| **D-11** 【v3 新增】 | 重复任务规则 | **RRULE (RFC 5545)** + `rrule.js`，桥接 `croner` | 自造 cron DSL 即违反 |
| **D-12** 【v3 新增】 | 子任务层级 | **仅两级**（主 + 子），不再下分 | 多级树状即违反 |
| **D-13** 【v3 新增】 | 内置模板 | **v1 不做**（用户拍板）| 内置 5 个模板即违反 |
| **D-14** 【v3 新增】 | 标签嵌套 | **支持 `#项目/前端` 嵌套标签** | 扁平标签即违反 |
| **D-15** 【v3 新增】 | 数学公式 | **KaTeX 必须**（包体 +300KB 可接受）| 跳过 LaTeX 渲染即违反 |
| **D-16** 【v3 新增】 | PDF 密码 | **v1 不做** | printToPDF 兼容性问题留 V2 |
| **D-17** 【v3 新增】 | Git 同步 | **自动 commit + 简易 push/pull 按钮**（非仅 `.gitignore` 模板）；用 isomorphic-git | 只给模板不做自动化即违反 |
| **D-18** 【v3 新增】 | 多库 | **单库**（v1） | 上线即支持多库即违反 |
| **D-19** 【v3 新增】 | 快捷键 | **MVP 内置默认键全，但用户可在设置里改** | 锁定硬编码即违反 |
| **D-20** 【v3 新增】 | i18n | **v1 全中文**（不做多语言）| 引入 i18n 框架即过度设计 |
| **D-21** 【v3 新增】 | 协同编辑 | **不做**（Yjs 不引入）| 上线即引入 Yjs 即违反 |
| **D-22** 【v3 新增】 | 库加密 | **不做**（与 D-2 冲突）| 引入加密 Vault 即违反 |
| **D-23** 【v3 新增】 | 番茄钟 | **纳入 P1 路线图**（不做不阻塞 MVP，但 P1 必须有） | 永久不做即违反 |
| **D-24** 【v3 新增】 | LLM 智能化 | **20 项 AI 功能全部进入 v1**（A+B+C+D 类合计 20 项）| 拆分到 V2 即违反 |

---

## 3. 用户未提但建议的需求（盲点）

> 来源：`gaps` 报告 A/B/C 三类分组。所有 A 类建议纳入 v1；B 类按优先级讨论；C 类仅作远期储备。**v3 中 B/C 类已大幅收缩**，多数升级为 v1 必含项。

### A 类 — 强烈建议纳入 v1

| 编号 | 需求 | 场景 | 建议 |
|---|---|---|---|
| **A1** | Wiki 双向链接 `[[笔记名]]` + 反向链接面板 | 笔记互相引用、构建知识网络 | **做**。没有双链 = "Obsidian 风格"仅停留在存储层 |
| **A2** | 外部编辑器与应用并发编辑的冲突解决 | VSCode 改稿 vs 应用内编辑 | **做**。三态机 + 静默窗口 + contentHash |
| **A3** | 任务 ↔ 笔记双向链接 | 任务引用笔记、笔记内嵌任务 checkbox | **做**。`[[note:path]]` + `[[task:uuid]]` 语法 |
| **A4** | Daily Note 自动创建 | 每天自动生成 `daily/YYYY-MM-DD.md` | **做**。模板可设置，默认含日期/任务占位符 |
| **A5** | 版本历史/快照 | 误删、覆盖、查看历史 | **做**。`.taskpilot/history/<id>/<ts>.md.gz`，最近 50 个 + 30 天 |
| **A6** | 任务提醒与系统通知 | 截止时间提前 15 分钟 Toast | **做**。Electron Notification + 系统托盘 |
| **A7** | 重复任务 / 周期性任务 | 每周站会、每月月报 | **做**。**RRULE（RFC 5545）+ rrule.js + croner** |
| **A8** | 任务层级 / 子任务（两级） | 主任务拆解为子任务 | **做但简化**。**仅两级**（主 + 子），不再下分 |
| **A9** | 自动保存 + 崩溃恢复 | 断电/崩溃后内容不丢 | **做**。debounce 写盘 + IndexedDB 草稿栈 + SQLite WAL |
| **A10** | 图片/附件管理（不仅粘贴插入）| 库目录图片检索、清理、跨设备同步 | **做**。`assets/images/YYYY-MM/<hash>.<ext>` + SHA-256 去重 |
| **A11** | 数据导入向导 | 从 Obsidian / Notion / 通用文件夹迁移 | **做**。P0 通用文件夹；P1 Obsidian Vault；P2 Notion .zip |
| **A12** | 暗色模式 + 跨模块联动 | 夜间使用 | **做**。三档（亮/暗/跟随系统）；图表、Mermaid、代码块、PDF 全联动 |
| **A13** | 标签组合筛选（AND/OR/NOT）| "工作 AND 重要 NOT 已完成" | **做**。三种组合 + 嵌套标签 `#项目/前端` |
| **A14** | Quick Capture 全局快捷键 | `Ctrl+Shift+T` 弹窗即建 | **做**。chrono-node 解析自然语言时间 |
| **A15** | 数据备份策略 | 一键 zip 导出 | **做**。本地增量备份 7 天 + **Git 自动 commit** |
| **A16** | 模板系统（日报/周报/会议/技术方案）| 重复写作场景 | **不做**（D-13 用户拍板 v1 不内置模板）。仅留 `templates/` 用户自建目录 |

### B 类 — 值得讨论（v1 纳入 / P1）

| 编号 | 需求 | 建议 |
|---|---|---|
| **B1** | 番茄钟 / 专注计时 | **P1 纳入**（D-23 用户拍板）。与 R-1 热力图联动 |
| **B2** | 看板视图（Kanban）| P1，与今日视图共存 |
| **B3** | 全日历视图 | P1.5；先做 mini 月历 + 今日 |
| **B4** | 任务依赖关系 | 先做"前置任务列表"，依赖图 P2 |
| **B5** | Web Clipper 浏览器剪藏 | P2；MVP 通过复制粘贴临时方案 |
| **B6** | 数学公式（KaTeX）| **v1 必含**（D-15 用户拍板） |
| **B7** | 任务评论/讨论 | 延后；单用户场景价值有限 |
| **B8** | 多端同步方案 | **升级为 Git 自动 commit + push/pull**（D-17 用户拍板）。用 isomorphic-git |
| **B9** | 多库支持 | **v1 不做**（D-18 用户拍板）。仅单库 |
| **B10** | 快捷键自定义 | **v1 内置默认键 + 设置页用户改键**（D-19 用户拍板） |
| **B11** | 国际化 i18n | **v1 全中文**（D-20 用户拍板） |
| **B12** | 导出 HTML / DOCX | 做 HTML（零成本），DOCX 可选 |
| **B13** | 时间块（Time Blocking）| P2，依赖全日历 |
| **B14** | 代码片段库（Snippets）| 延后；先靠模板系统覆盖 |
| **B15** | 任务关联附件 | 简化；走附件管线 |
| **B16** | 任务完成证据链 | 简化；可选 markdown 说明 |

### C 类 — 远期（V2+ 储备）

C1 协同编辑（CRDT/Yjs） · C2 库目录加密 Vault · C3 移动端 APP · C4 习惯打卡 · C5 知识图谱可视化 · C6 插件系统 · C7 语音输入 · C8 OCR · C9 优先级矩阵 · C10 OKR 管理 · C11 桌面通知插件化。

### D 类 — LLM 智能化（v3 重大补充）

> 详见第 9 章 LLM 智能化集成设计。D 类全部 20 项（A+B+C+本地优先隐私）全部纳入 v1。

| 编号 | 类别 | AI 功能 | 状态 |
|---|---|---|---|
| **D-AI-1** | A 必含 | 自然语言 → 结构化任务/笔记 | v1 |
| **D-AI-2** | A 必含 | 笔记自动生成反向链接 | v1 |
| **D-AI-3** | A 必含 | AI 任务拆解（"我要学 Rust" → 树形任务）| v1 |
| **D-AI-4** | A 必含 | 任务 ↔ 笔记双向智能关联 | v1 |
| **D-AI-5** | B 应该做 | 语义搜索（向量 + FTS5 混合）| v1 |
| **D-AI-6** | B 应该做 | AI 总结每日/每周 | v1 |
| **D-AI-7** | B 应该做 | 智能标签建议 | v1 |
| **D-AI-8** | B 应该做 | Mermaid 图自动生成 | v1 |
| **D-AI-9** | B 应该做 | 会议纪要 → 任务清单 | v1 |
| **D-AI-10** | B 应该做 | 代码块解释 / 找 Bug | v1 |
| **D-AI-11** | B 应该做 | 上下文对话（"我今天该做什么？"）| v1 |
| **D-AI-12** | C 可以做 | 写作助手（续写/润色/翻译/简化）| v1 |
| **D-AI-13** | C 可以做 | 模板智能填充 | v1 |
| **D-AI-14** | C 可以做 | 智能调度建议 | v1 |
| **D-AI-16** | D 隐私 | 本地 LLM 路由（Ollama 优先）| v1 |
| **D-AI-17** | D 隐私 | 敏感数据脱敏 | v1 |
| **D-AI-18** | D 隐私 | 离线降级队列 | v1 |
| **D-AI-19** | D 隐私 | 对话本地加密 | v1 |
| **D-AI-20** | D 隐私 | "本地优先"开关 | v1 |

> **关键判断**：A1+A3+A4 是"Obsidian 风格 + 任务 + 笔记"的事实标准；A2+A5+A9 是数据安全三件套；A6+A7+A8 是任务模块从 MVP 升级到"可用"的临界点；**D-AI-1 ~ D-AI-20** 是 v3 相对 v2 的最大新增，体现"AI-first 个人生产力"的产品定位。

---

## 4. 模块清单（v3 扩展为 9 大块）

```
┌────────────────────────────────────────────────────────────┐
│ A. 任务管理                   │ F. Obsidian 笔记库          │
│ B. AI 编排（v1 既有，作为 I 的总入口）│ G. 文档导出        │
│ C. 定时调度                   │ H. 跨模块                  │
│ D. Dashboard / 仪表盘         │ I. 【v3 新增】AI 智能化集成  │
│ E. WYSIWYG 编辑器 + 渲染      │                            │
└────────────────────────────────────────────────────────────┘
```

| 模块 | 包含内容 | 优先级 |
|---|---|---|
| **A. 任务管理** | CRUD、四象限、子任务（两级）、RRULE 重复、依赖、提醒、AI 拆解、AI 关联 | M |
| **B. AI 编排** | Provider 路由、Function Calling、上下文管理、对话存储 | M |
| **C. 定时调度** | croner + RRULE 桥接、Reminder、Pomodoro 触发 | S |
| **D. Dashboard** | 时钟、Today（默认）、Heatmap、Charts、Quick Actions | S |
| **E. WYSIWYG 编辑器** | TipTap v2、Mermaid、代码高亮、KaTeX、Markdown WYSIWYG | M |
| **F. 笔记库** | chokidar、冲突解决、标签/双链、FTS5、自动命名 | M |
| **G. 文档导出** | printToPDF、批量合并、ZIP | S |
| **H. 跨模块** | 一致性、安全、性能、主题、快捷键、附件、库目录、Git 同步 | M |
| **I. AI 智能化集成【v3 新增】** | 20 项 AI 功能的总集成点：能力地图、架构、数据采集、Function Calling、隐私、成本控制、评估 | M |

---

## 5. 各模块详细需求

### D. Dashboard / 仪表盘

#### D-1 实时时钟与日历（R-3）
- **功能**：顶栏常驻"下午好 · 周日 8 月 30 日 15:42"；独立 mini 月历部件（6×7 网格，有截止任务的日期打圆点）。
- **验收**：分钟刷新；单 `useNow(60_000)` hook 全应用共享；绑定 `powerMonitor.on('resume')` 与 `visibilitychange` 强制对时；首次 timeout 对齐到整分边界。
- **风险**：后台 setInterval 被 Chromium 节流到 ≥1 分钟，休眠唤醒会漂移。

#### D-2 今日任务面板（R-4）
- **功能**：Dashboard 摘要卡片（前 5 条 + "查看全部 (12)"）+ 独立 `/today` 路由作为**应用启动默认落地页**（**D-9 锁定**）。
- **验收**：Dashboard 摘要卡 checkbox 可直接勾完成 → 即时反馈到热力图；逾期任务优先占位 + 红色标记。
- **数据**：从 `tasks` 表 WHERE due_date = today OR status = overdue ORDER BY priority DESC, due_date ASC。

#### D-3 贡献热力图（R-1）
- **数据采集**：
  ```sql
  -- 双表：原始事件 + 日聚合（物化）
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY, ts INTEGER, local_date TEXT,
    kind TEXT, -- task_completed | note_created | note_edited | note_chars
    entity_type TEXT, entity_id TEXT,
    delta_chars INTEGER, weight REAL, meta TEXT
  );
  CREATE TABLE activity_daily (
    local_date TEXT PRIMARY KEY,
    tasks_done INTEGER, notes_created INTEGER, notes_edited INTEGER,
    chars_written INTEGER, score REAL, updated_at INTEGER
  );
  ```
- **混合评分公式**（封顶防爆）：
  ```
  score = tasks_done * 1.0
        + notes_created * 1.0
        + min(notes_edited, 5) * 0.5
        + min(chars_written / 250, 8) * 1.0
  ```
- **【v3 新增】历史回填**：
  - 首次启用时执行一次性 `BackfillService.backfillFromVault(libraryPath)`：
    1. 扫描所有 `.md` 文件的 `ctime/mtime` → 生成 `note_created` / `note_edited` 事件
    2. 解析 YAML front matter 的 `created` / `modified` 字段（若有，覆盖文件系统时间）
    3. 解析正文字数 → 估算 `chars_written`（按文件大小 / 字符平均）
    4. 已有任务表的 `created_at` / `completed_at` → 生成 `task_completed` 事件
  - 全过程异步 + 进度条 + 可中止
  - 设置页提供"重新构建历史活动"按钮
- **视觉**：5 级离散色阶（OKLCH 单色相 hue 250），分位数分级（p25/p50/p75/p90）；11×11px 圆角 2px，gap 3px；深色模式 level 0 略亮于背景。
- **交互**：hover 用 `@floating-ui/react` 显示明细；click 打开右侧 Sheet 当日详情；`role="grid"` + 方向键导航；不显示秒表动画；`prefers-reduced-motion` 禁用 hover 缩放。
- **外部编辑器兼容**：主进程 `chokidar` 监听 vault，**rename 合并**（原子保存 unlink+add）防重复计数；10 分钟会话合并同 entity_id 编辑事件；`content_hash` 去重。
- **依赖**：chokidar（主进程）、`@floating-ui/react`、自建 SVG 组件（约 150 行）。

#### D-4 快捷图表（R-2）
- **首屏规则**：Dashboard 最多 6 个部件，其中最多 3 个是图表。
- **必含图表**：

 | 图表 | 形式 | 理由 |
  |---|---|---|
  | 完成率（今日/本周/本月）| P0 KPI 磁贴 + sparkline + 同环比 | 数字磁贴信息密度最高 |
  | 项目/标签分布 | P1 横向条形 Top7 + 其他 | 标签可精确比较 |
  | 时间投入趋势 | P1 堆叠柱状（按周，按项目着色）| ≥7 天工时数据才显示 |
  | 优先级分布 | P2 4 个 P0-P3 chip | 数字而非占比 |
  | 笔记字数/篇数趋势 | P1 面积图按周累计 | 写作量累积型适合 fill |
  | 逾期与阻塞 | **非图表，但最高优先级**| "3 逾期 · 2 被阻塞" |
  | **【v3 新增】** AI 周报摘要 | P1 文本卡片 + "生成新摘要" 按钮 | 调 AI-6 |

- **明确排除**：旭日图、雷达图、双轴图（均为可视化反模式）。
- **通用规范**：Y 轴从 0；空态显示引导而非空坐标系；配色 token 与热力图同源。
- **库选型**：Recharts 3.x + 自建 SVG 热力图 + 自建 sparkline（10 行 polyline）。备选：ECharts（仅当 P2 做甘特时 lazy import）。

#### D-5 快捷功能（R-2）
- **按钮组**（Dashboard 顶栏，问候语下方）：

  | 动作 | 形式 | 快捷键 |
  |---|---|---|
  | 快建任务 | 主按钮（filled）+ 内联输入 | `N` / `Ctrl+Shift+T` |
  | 快建笔记 | 次按钮 | `Shift+N` |
  | 今日视图 | 文字链接 + 计数徽标 | `T` |
  | 开始番茄钟 | 图标按钮（P1 上线前空缺，标注"即将到来"）| `P` |
  | AI 助手 | 图标按钮 → 打开对话侧边栏 | `Ctrl+Space` |
  | 最近活动 | 独立时间线（非按钮组）| — |

- **约束**：按钮组 ≤4 个 + 溢出菜单；命令面板（`Ctrl+K`）配套提供。

### E. WYSIWYG 编辑器 + 渲染

#### E-1 编辑器选型
- **首选 TipTap v2**（基于 ProseMirror）：生态成熟、自定义节点方便、Markdown 序列化社区方案完整。
- **备选**：BlockNote（MVP 阶段快速出 Notion 风）；Lexical（性能优先但 Markdown 兼容性弱）；milkdown（输入触发感不符合纯 WYSIWYG）；Slate（不推荐）。
- **推荐扩展组合**：
  ```ts
  StarterKit, Table, TableRow, TableHeader,
  TaskList, TaskItem, Image, Link,
  CodeBlockLowlight, Markdown, MermaidBlock(自定义),
  Mathematics(自定义, KaTeX), WikiLink(自定义)
  ```

#### E-2 Mermaid 内嵌渲染（R-7）
- **核心思路**：自定义 Node `MermaidBlock`（`group: 'block'`, `atom: true`, `code: string`）+ React NodeView。
- **挑战与方案**：
  - 实时渲染 + 防抖：`useDebounce(500ms)`，渲染前显示骨架屏
  - 编辑/渲染切换：默认渲染态，hover 显示"编辑"按钮或双击进入编辑态
  - 主题切换：主题变化时遍历所有 mermaid 节点调 `mermaid.render()` 重新生成 SVG
  - 大图性能：>5s 渲染超时显示"图表过大已降级"；高度 >2000px 显示缩略图 + 点击放大
  - **必须 dynamic import**：`const mermaid = (await import('mermaid')).default`，减少首屏体积
  - 多实例隔离：每 NodeView 用 `mermaid-${nanoid()}` 唯一 ID
  - 导出：SVG → Canvas → PNG；`navigator.clipboard.write()`（Electron 需主进程桥接）
  - **【v3 新增】** "描述文字 → 流程图" 按钮：调 AI-8，传入当前段落，AI 返回 mermaid 源码并替换
- **风险**：mermaid v10/v11 之间有破坏性变更（securityLevel 默认值），必须锁定版本。

#### E-3 代码块高亮
- **MVP**：lowlight + highlight.js，异步加载语言，10000 行 <100ms。
- **进阶**：主进程 Shiki 预渲染（renderer 端不引入 shiki），包体更小效果更好。
- **推荐语言集**：js, ts, python, java, go, rust, css, html, json, bash, sql, markdown（~200KB 总）。

#### E-4 数学公式（KaTeX）【v3 升级为必含】
- **KaTeX**（~300KB）优于 MathJax（~1MB+）：速度快 10x+，LaTeX 95%+ 常用语法。
- **实现**：自定义 `math` 节点 + KaTeX renderToString；序列化识别 `$...$` 和 `$$...$$`。
- **行内与块级**：支持 `$E=mc^2$` 与 `$$\int f(x)dx$$`。
- **复制**：选中后复制为 LaTeX 源码（而非渲染后的 Unicode）。
- **性能**：预编译常用公式，缓存 renderToString 结果。

#### E-5 Markdown 序列化
- **库**：tiptap-markdown（社区版 `aguingand/tiptap-markdown`）比官方方案成熟。
- **Round-trip 完整性**（关键）：
  - 表格合并单元格、taskItem 勾选状态、数学公式、Mermaid 块、图片 alt/title 全部需自定义 serializer/deserializer
  - 保留 token：HTML 注释 `<!-- tiptap-meta: {...} -->` 存元数据
  - 快照测试：每个文档做 `parse(serialize(parse(md))) === parse(md)` 断言

#### E-6 图片/附件处理
- **流程**：拖拽/粘贴/选择 → IPC 主进程 → SHA-256 去重 → Sharp 压缩（>2MB 自动 1920px / jpeg 85）→ 写入 `<library>/assets/<hash>.<ext>` → 返回相对路径。
- **关键技术**：
  - **Sharp**（~30MB 含 native binary）需 `electron-rebuild`；备选 jimp（纯 JS 慢 5-10x）
  - 相对路径 `path.relative()` / `path.resolve()` 在主进程处理
  - 多附件支持：PDF/zip/视频，统一归类 `assets/`

### F. Obsidian 风格笔记库

#### F-1 目录结构
```
<library_root>/
├── notes/                          # 普通笔记
│   ├── 项目A/
│   └── 随笔/
├── daily/                          # 日记
├── assets/
│   ├── images/
│   └── files/
├── templates/                      # 用户自建模板（D-13 v1 不内置）
└── .taskpilot/                     # 应用私有元数据（隐藏）
    ├── meta.sqlite                 # 标签/字数/反链/任务引用/AI 索引
    ├── history/                    # 版本快照
    ├── cache/                      # FTS5 + 向量索引
    └── ai/                         # AI 对话历史/缓存
```

#### F-2 元数据双轨制
| 类型 | 位置 | 写入者 |
|---|---|---|
| YAML front matter（标题、别名、tags）| `.md` 文件顶部 | 用户 |
| 应用私有元数据（字数、task_links、内部 id）| `meta.sqlite` | 应用 |
| 索引（FTS5、反链、向量）| SQLite | 应用 |
| AI 元数据（向量 embedding、摘要缓存）| `.taskpilot/ai/` | 应用 |

**关键策略**：应用元数据**绝不写回 `.md`**（避免污染 + 避免新一轮 watch 事件）。

#### F-3 chokidar 配置 + 冲突解决三态机
```ts
chokidar.watch(libraryPath, {
  ignored: [/(^|[\/\\])\../, /\.taskpilot/, /\.trash/, /\.tmp$/, '~$*'],
  awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
})
```

**三态机**：
```
当前是否有 pendingBuffer? ─否─► 直接应用外部变更 │
               是
                ▼
距上次应用保存 < 静默窗口(2s)? ─是─► 以应用为准（写者胜）
                │
               否
                ▼
弹出 UI 三选一：①保留应用版本（先快照外部版到 history/）
                ② 保留外部版本 ③ 手动合并
```

**rename 合并**：原子保存产生 unlink+add → 以 path 为键合并成一次变更。**关键**：外部编辑器保存一次 = 恰好一条事件。

#### F-4 标签系统
- 来源：YAML `tags:` + SQLite `note_tags`，解析时合并去重
- **【v3 锁定】嵌套标签**：`#项目/前端` 用 `/` 表示层级（Obsidian 兼容，D-14）
- 组合过滤：`tag:工作 AND tag:重要` → SQL 拼接
- 嵌套筛选：`tag:项目/前端` 精确匹配；`tag:项目/*` 通配整子树

#### F-5 双链 / Wiki 链接 `[[笔记名]]`
- 自定义 ProseMirror 节点 `wikiLink`，渲染为可点击 chip
- 解析扫描 `[[...]]` 和 `[[...|alias]]`，建边入 `links` 表
- **自动补全**：`[[` 触发下拉
- **未创建链接（孤儿）**：灰色显示，点击弹"新建"对话框
- **反向链接**：每篇笔记底部面板
- **【v3 新增】AI-2 自动反向链接**：保存笔记时自动扫描正文 + 已有笔记标题/标签，建议 3-5 条反向链接候选，用户一键采纳

#### F-6 任务 ↔ 笔记双向链接（A3）
- 任务 → 笔记：`task.linked_note_ids: TEXT[]`
- 笔记 → 任务：`[[task:uuid]]` 语法 + checkbox 节点交互
- 笔记内嵌任务：`note_tasks` 表（note_id, task_id, checkbox_pos）
- **【v3 新增】AI-4 双向智能关联**：任务保存时调 AI 扫描相关笔记，推荐 3-5 条；笔记保存时调 AI 扫描相关任务

#### F-7 Daily Note 自动创建（A4）
- 设置中配置模板路径（默认 `templates/Daily.md`，不存在则用内置空白模板但**不写入模板目录**——D-13）
- 首次打开某日日记时若不存在，按模板创建
- 模板变量：`{{date}}`、`{{weekday}}`、`{{today_tasks}}`

#### F-8 笔记自动文件名（**D-10 v3 锁定**）
- 新建空白笔记时文件名：`YYYY-MM-DD-未命名.md`
- 用户写下第一个 H1 标题后 → 自动重命名为 `YYYY-MM-DD-<slug(H1)>.md`
- slug 规则：保留中文 + ASCII，去除特殊符号，空格转 `-`，截断 50 字符
- 若目标文件名已存在 → 追加 `-2`、`-3` 等后缀
- 重命名走应用层 → 同步触发 chokidar 的 `rename` 事件，SQLite 中更新 entity_id 映射

#### F-9 搜索（FTS5 + MiniSearch + 向量）
```
SearchService.search(query, filters)
  ├─ 标题模糊: MiniSearch（内存索引，启动构建）
  ├─ 内容全文: SQLite FTS5 MATCH (BM25)
  ├─ 语义搜索【v3】: sqlite-vec 或本地 ONNX embedding → 余弦相似度
  ├─ 标签过滤: SQL JOIN
  └─ 文件名: LIKE 兜底
```
- 启动构建 1000 篇 < 500ms
- 运行时增量：watcher 触发 `reindex(noteId)`，单篇 < 50ms
- 搜索 UI 防抖 150ms
- 单篇 > 100KB 不入 FTS5（仅入标题）
- **【v3 混合排序**：BM25 分数 + 向量相似度按 0.6/0.4 加权

#### F-10 版本历史（A5）
- 快照存 `.taskpilot/history/<noteId>/<timestamp>.md.gz`
- 保留：最近 50 个 + 30 天
- 差异对比：`diff-match-patch` 可视化
- "还原到此版本"= 创建新版本而非覆盖（保留追溯链）
- 触发：自动（1.5s 防抖后）+ 手动 Ctrl+S + 外部变更前

#### F-11 导入向导（A11）
- **P0**：通用文件夹递归扫描
- **P1**：Obsidian Vault 一键接入（解析 front matter + wiki + 附件）
- **P2**：Notion .zip 转换（`notion-to-md`）
- 流程：选源 → 选目标子目录 → 进度条 → 冲突时"重命名/合并/跳过"

### G. 文档导出

#### G-1 单篇导出
- **引擎**：`webContents.printToPDF()`（Electron 自带，**零依赖**）
- **流水线**：
  ```
  [主窗口] WYSIWYG DOM ─serializeHTML()─► [隐藏 BrowserWindow #print]
                                            ├─ 注入 mermaid.run()
                                            ├─ 等 <img> onload
                                            ├─ 等 mermaid svg[data-rendered=true]
                                            ├─ 等 KaTeX 字体加载
                                            └─ webContents.printToPDF()
  ```

#### G-2 批量导出
- **合并 PDF（默认）**：`PDFDocument.create().copyPages()`，文件名 `{Notebook名}-导出-{YYYY-MM-DD}.pdf`
- **ZIP 打包（备选）**：`jszip`，文件名 `{Notebook名}-导出-{YYYY-MM-DD}.zip` 内含 `{NN}-{标题}.pdf`

#### G-3 打印 CSS 关键规则
```css
@page {
  size: A4; margin: 18mm 16mm 20mm 16mm;
  @top-left { content: string(doc-title); font-size: 9pt; color: #888; }
  @bottom-right { content: counter(page) " / " counter(pages); font-size: 9pt; }
}
@page :first { @top-left { content: ''; } }

body {
  word-break: break-word;
  overflow-wrap: anywhere;
  line-break: strict;
  hanging-punctuation: allow-end;
}

h1,h2,h3,h4 { page-break-after: avoid; }
img,svg,video,figure { max-width: 100% !important; page-break-inside: avoid; }
pre { page-break-inside: auto; white-space: pre-wrap !important; }
blockquote,table,ul,ol { page-break-inside: avoid; }
.toolbar,.editor-chrome,.no-print { display: none !important; }
.katex-display { page-break-inside: avoid; }
```

#### G-4 导出选项
- 范围：单篇 / 多篇 / 整本
- 纸张：A4 / A5 / Letter / Legal
- 字号：9/10/10.5/11/12/14/16pt
- 配色：当前主题 / 浅色 / 深色 / 黑白
- 链接：显示文本+URL / 仅文本
- **【D-16 确认】不做密码（V1）**：与 printToPDF 兼容性差，留 V2

#### G-5 风险与缓解
- Mermaid 重绘慢：编辑器内已渲染 SVG，序列化时直接带走
- 中文长字符串断行：`overflow-wrap: anywhere` + `line-break: strict`
- 大图超出页面：`max-width: 100%; height: auto`
- 代码块跨页截断：`pre { page-break-inside: auto; white-space: pre-wrap }`
- 隐藏窗口 font 未加载：`document.fonts.ready` 等待 promise 后再 printToPDF
- 大文件 OOM：分批合并（每 30 篇一组 → 中间 PDF → 二次合并）
- KaTeX 字体在隐藏窗口未加载：等待 `document.fonts.check('1em KaTeX_Main')`

### H. 跨模块（全局性）

#### H-1 数据一致性
- 单数据源：所有元数据进 SQLite；`.md` 文件是用户视角单一来源
- 应用元数据绝不入 `.md`
- 跨模块事件总线：`activity_log` 同时被热力图、sticker、统计模块读取
- AI 调用结果统一进 `.taskpilot/ai/cache.sqlite`，避免重复请求

#### H-2 安全
- XSS：TipTap 默认安全，自定义 Node 的 `renderHTML` 严格转义；外部 HTML 导入用 DOMPurify
- Mermaid：`securityLevel: 'strict'`（v11 默认）
- 附件路径：规范化 + 校验最终路径在 library 根目录内（防 path traversal）
- CSP：`default-src 'self'`、`script-src 'self'`、`style-src 'self' 'unsafe-inline'`（TipTap 需要）
- Electron：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`
- **【v3 新增】AI-17 脱敏**：AI 请求前正则替换邮箱/手机号/身份证/URL token（详见第 9 章）
- **【v3 新增】AI-19 对话加密**：SQLCipher 替代方案 = 应用层 AES-256-GCM 加密 `.taskpilot/ai/conversations.enc`，密钥来自 Keychain

#### H-3 性能
| 场景 | 策略 |
|---|---|
| 启动索引 | 扫描 → 比对 SQLite → 增量添加；1000 文件 < 1.5s |
| 文件监听 | 批量防抖 200ms，每批最多 50 个并发 |
| 编辑器加载 | 侧栏虚拟滚动（`react-window`）|
| 大文件 | > 1MB 提示拆分；> 5MB 强制只读 |
| 热力图渲染 | 365 个 `<rect>` + 事件委托 + `React.memo` |
| IPC | TypedArray 零拷贝（`MessageChannelMain`）|
| **【v3 新增】** AI 响应流式 | SSE/stream 减少 TTFT；本地 LLM 用 stream Ollama API |
| **【v3 新增】** 向量索引 | 单库 1k 笔记用 sqlite-vec < 200ms 启动 |

#### H-4 主题 / i18n（A12）
- 三档：亮 / 暗 / 跟随系统
- 联动：热力图色阶（OKLCH）、Mermaid 主题、代码高亮主题、图表色 token、PDF 导出配色、AI 助手 UI
- 优先级：**【D-20】MVP 全中文**，i18n 延后

#### H-5 快捷键体系
- 全局：`Ctrl+Shift+T` Quick Capture / `Ctrl+K` 命令面板 / `Ctrl+S` 强制保存 / `Ctrl+Space` AI 助手
- 编辑器：`Ctrl+B` 加粗 / `Ctrl+I` 斜体 / `/` 块菜单 / `Ctrl+M` 插入 Mermaid / `Ctrl+Shift+M` 插入数学公式
- 导航：`Ctrl+1~5` 切 Today/Inbox/Project/Notes/Dashboard
- AI：`Alt+Enter` 提交 AI 对话 / `Ctrl+.` 中断流式响应
- **【D-19 自定义】**：设置页"快捷键"tab 列出所有动作 + 当前绑定 + 输入框"按下新键录制" → 写入 `appConfig.json`

#### H-6 附件管理（A10）
- `assets/images/YYYY-MM/<hash>.<ext>` 自动按月归档
- SHA-256 去重，相同图片只存一份
- 缩略图缓存（lazy 生成）
- 未引用附件清理工具（P1）

#### H-7 库目录管理（**D-7 v3 修订**）
- **首次启动**：模态框"请选择你的笔记库目录" + 三个示例按钮（新建 / 选择已有 / 使用默认 `~/Documents/MyTaskVault/`）
- 保存到 `appConfig.json`
- 允许一键切换库
- 库目录被移动/重命名：监听父目录 rename，提示用户重新选择
- 多库支持：**【D-18】v1 单库**，P1 最多 3 库，顶部下拉切换

#### H-8 备份策略（A15）
- 一键导出 zip 备份
- 可选每日本地增量备份（保留 7 天到 `~/Documents/TaskPilot-backups/`）
- **【v3 新增】Git 自动同步**：详见第 11 章

#### H-9 任务模块字段（**v3 详细设计**）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID v4 |
| `project_id` | TEXT NULL | 关联项目（v1 简化：可选） |
| `parent_task_id` | TEXT NULL | **仅两级**，指向主任务；空 = 主任务 |
| `title` | TEXT NOT NULL | 任务标题 |
| `description` | TEXT | Markdown WYSIWYG 内容（与笔记同等渲染） |
| `status` | TEXT | enum: `todo` / `in_progress` / `done` / `cancelled` / `overdue`（计算字段） |
| `priority` | TEXT | enum: `P0` / `P1` / `P2` / `P3` |
| `due_at` | INTEGER NULL | 截止时间（UTC ms） |
| `started_at` | INTEGER NULL | 开始时间 |
| `completed_at` | INTEGER NULL | 完成时间 |
| `estimate_minutes` | INTEGER NULL | 预估工时 |
| `actual_minutes` | INTEGER NULL | 实际工时（番茄钟累加） |
| `recurrence` | TEXT NULL | **RRULE 字符串**（详见第 10 章） |
| `recurrence_anchor_id` | TEXT NULL | 重复任务链的锚点 ID（"父模板"） |
| `linked_note_ids` | TEXT NULL | JSON 数组，反向链接笔记 |
| `tags` | TEXT NULL | JSON 数组，支持嵌套 `项目/前端` |
| `position` | REAL | 同级排序权重（浮点支持拖拽插入） |
| `is_archived` | INTEGER | 0 / 1 |
| `deleted_at` | INTEGER NULL | 软删除时间 |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

### I. AI 智能化集成（v3 新增，最大模块）

> 完整设计见第 9 章。此处仅给出模块边界。
- **模块定位**：20 项 AI 功能的总集成点，包含架构、数据采集、Function Calling、隐私、成本控制、评估。
- **依赖关系**：B（AI 编排）是 I 的运行时支撑；I 是用户感知的"AI 能力总览"。
- **入口**：Dashboard 顶栏 `Ctrl+Space` 唤起 AI 助手侧边栏；编辑器右侧悬浮 AI 按钮。

---

## 6. 技术决策摘要（v3 更新）

### 6.0 总体技术栈（**v3 重构**）

| 层 | 选型 | 说明 |
|---|---|---|
| **桌面框架** | **electron-vite** | main / preload / renderer 三套独立 Vite 配置 |
| **前端框架** | **Vite + React 19** | **取代 v2 的 Next.js**（D-5 锁定） |
| **前端路由** | **TanStack Router** | type-safe memory router，文件路由 |
| **状态管理** | **Zustand** | 轻量 + TS 友好 |
| **数据库** | **better-sqlite3**（**不加密**，D-6 锁定）| WAL 模式；元数据 / FTS5 / 活动日志 |
| **凭据存储** | **safeStorage**（主）/** keytar**（备）| 仅存 API Key |
| **编辑器** | **TipTap v2** | WYSIWYG |
| **数学渲染** | **KaTeX**（**v1 必含**，D-15 锁定）| |
| **重复规则** | **rrule.js**（**D-11 锁定**）+ croner | RRULE → cron 桥接 |
| **Git 同步** | **isomorphic-git**（**D-17 锁定**）| 纯 JS 适合打包 |
| **本地 LLM** | **Ollama**（HTTP API）+ llama.cpp 备选 | AI-16 本地路由 |
| **向量索引** | **sqlite-vec** 或 **@xenova/transformers**（ONNX）| AI-5 语义搜索 |
| **图表** | Recharts 3.x | |
| **搜索** | SQLite FTS5 + MiniSearch | |
| **文件监听** | chokidar | |
| **图片处理** | Sharp（主进程）| |
| **PDF 导出** | `webContents.printToPDF()` | 零依赖 |
| **自然语言日期** | chrono-node | |
| **差异对比** | diff-match-patch | |
| **定时调度** | croner | RRULE 桥接后传入 |

### 6.1 编辑器选型
（同 v2，主选 TipTap v2）

### 6.2 图表库
（同 v2，主选 Recharts 3.x）

### 6.3 PDF 导出引擎
（同 v2，主选 `printToPDF()`，**D-16 确认无密码**）

### 6.4 搜索
| 引擎 | 用途 | 包体 |
|---|---|---|
| **SQLite FTS5** | 全文 BM25 | 已集成 |
| **MiniSearch** | 标题模糊匹配 | ~10KB |
| **sqlite-vec / ONNX【v3】** | 语义搜索（AI-5） | 视模型而定 |

### 6.5 包体影响（renderer 端，**v3 重新估算**）

| 依赖 | gzip | 引入策略 |
|---|---|---|
| react + react-dom 19 | ~50KB | 主包 |
| @tanstack/react-router | ~20KB | 主包 |
| zustand | ~3KB | 主包 |
| @tiptap/core + starter-kit + 扩展 | ~400KB | 主包 |
| tiptap-markdown | ~20KB | 主包 |
| lowlight + highlight.js 核心 | ~50KB | 主包 |
| **mermaid** | **500KB-1MB** | **必须 dynamic import** |
| **katex【v3 必含】** | **~300KB** | 主包 |
| DOMPurify | ~20KB | 主包 |
| recharts | ~100KB | 主包 |
| @floating-ui/react | ~10KB | 主包 |
| @xenova/transformers（mini LM）【v3】 | ~5MB 模型文件 + ~200KB 运行时 | dynamic import，首次 AI-5 时下载 |
| chokidar | 主进程 | 不计入 renderer |
| sharp | ~30MB native | 主进程 |
| **新增总计 v3** | | **首屏主包目标 < 700KB gzip；全功能加载 ~6MB gzip（含本地模型）** |

### 6.6 文件监控
（同 v2，主选 chokidar）

### 6.7 项目结构（**v3 新增**）
```
taskpilot/
├── package.json
├── electron.vite.config.ts          # electron-vite 配置
├── tsconfig.json
├── src/
│   ├── main/                         # 主进程
│   │   ├── index.ts                  # 入口
│   │   ├── ipc/                      # IPC handlers
│   │   ├── db/                       # SQLite + 迁移
│   │   ├── notes/                    # VaultWatcher / BackfillService
│   │   ├── stats/                    # AggregationService
│   │   ├── pdf/                      # 导出引擎
│   │   ├── scheduler/                # croner + RRULE 桥接
│   │   ├── git/                      # isomorphic-git 封装
│   │   └── ai/                       # AI Provider 路由（主进程）
│   ├── preload/                      # contextBridge
│   │   └── index.ts
│   └── renderer/                     # React + Vite
│       ├── index.html
│       ├── main.tsx
│       ├── routes/                   # TanStack Router 文件路由
│       ├── components/
│       ├── stores/                   # Zustand
│       ├── extensions/               # TipTap 自定义节点
│       ├── ai/                       # AI client 端
│       └── styles/
└── .gitignore
```

---

## 7. 风险清单与对策（v3 扩展）

### P0 — 严重（数据丢失 / 不可逆）

| 风险 | 对策 |
|---|---|
| **R-1 笔记编辑事件重复与漏计** | content_hash 去重 + 10 分钟会话合并 + rename 路径合并三层防护；单元测试覆盖"外部工具保存一次 = 恰好一条事件" |
| **R-1 混合评分无封顶爆色阶** | `min()` 三处封顶（notes_edited≤5、chars/250≤8）|
| **R-1 历史回填扫描阻塞启动** | 异步 + 进度条 + 可中止；启动时仅预热最近 30 天，全量后台跑 |
| **R-11 应用/外部同时编辑丢稿** | 三态机 + 静默窗口 + contentHash；应用胜强制快照到 history/ |
| **R-11 磁盘崩溃 / 误删** | 版本历史 + 一键 zip 备份 + **Git 自动 commit** |
| **R-9 编辑中应用崩溃** | debounce 写盘（tmp+rename 原子）+ IndexedDB 草稿栈 + SQLite WAL |
| **R-5 mermaid v10/v11 破坏性变更** | 锁定版本；升级前跑 round-trip 测试 |
| **【v3 新增】AI 调用成本失控** | token 预算看板 + 硬上限 + 用户确认开关 |
| **【v3 新增】AI-19 对话明文落盘泄漏隐私** | 应用层 AES-256-GCM 加密 `.taskpilot/ai/conversations.enc` |
| **【v3 新增】Git push 冲突丢历史** | push 前 fetch + 三方合并检测 + 用户确认 |

### P1 — 高（功能/性能退化）

| 风险 | 对策 |
|---|---|
| **R-3 时钟休眠唤醒后停摆** | 绑定 `powerMonitor.resume` + `visibilitychange` 强制对时；首次 timeout 对齐整分边界 |
| **R-5 WYSIWYG 序列化信息丢失** | 自定义 serializer/deserializer；HTML 注释保留 token；快照测试 |
| **R-5 mermaid 包体过大** | dynamic import + 编辑器初始化不引入 |
| **R-7 mermaid 多实例渲染冲突** | 每 NodeView 唯一 ID `mermaid-${nanoid()}` |
| **R-11 FTS5 中文分词不友好** | `tokenize='trigram'` 或 jieba 注入；MVP 可先 LIKE 兜底 |
| **R-11 附件路径跨平台同步破裂** | 统一正斜杠存储；读取时 `path.normalize()` |
| **R-12 PDF mermaid 重绘慢** | 编辑器内已渲染 SVG，序列化时直接带走 |
| **R-12 中文长字符串断行** | `overflow-wrap: anywhere` + `line-break: strict` + `word-break: break-word` |
| **R-12 大文件 OOM** | 分批合并：每 30 篇一组 → 中间 PDF → 二次合并 |
| **E-2 mermaid SVG 注入 XSS** | `securityLevel: 'strict'`（v11 默认）|
| **【v3 新增】RRULE 解析与 cron 桥接偏差** | round-trip 单测覆盖；用户可视化的"下一次触发"预览必须一致 |
| **【v3 新增】isomorphic-git native 模块依赖** | 锁定 `isomorphic-git` 纯 JS 路径，禁用 lightning-fs 外的绑定 |
| **【v3 新增】AI-5 向量索引启动慢** | 启动 lazy + 后台 warm-up；首次查询允许 1s |
| **【v3 新增】本地 LLM 模型下载体积** | 用户显式确认；下载进度条；可跳过先用云端 |
| **【v3 新增】AI 输出幻觉** | 关键操作（创建任务/删除笔记）必须经用户二次确认 |
| **【v3 新增】AI 调用延迟** | 流式响应 + 本地优先 + 离线队列（AI-18）|

### P2 — 中（体验/可用性）

| 风险 | 对策 |
|---|---|
| Dashboard 部件过多变数据墓地 | 首屏 ≤6 个部件，≤3 个图表 |
| 番茄钟 P1 上线前空按钮伤体验 | 按钮存在但标"即将到来"+灰显 |
| 跨平台 sharp native 编译失败 | README 标注 `npm rebuild`；备选 jimp |
| 库目录被移动 | 监听父目录 rename；提示重新选择 |
| Git 同步冲突 | 提供"重新基线/丢弃本地/保留远端"三选项 + diff 预览 |
| 色盲 | 单色相顺序色阶（靠明度区分），保证相邻两级 ΔL ≥ 0.08 |
| streak 制造焦虑 | 默认展示但可在设置关闭；不用警示色渲染断掉 streak |
| `prefers-reduced-motion` 用户体验 | 禁用格子 hover 缩放动画 |
| **【v3 新增】** AI 提供商宕机 | 多 Provider 路由 + 离线降级队列 + 友好提示 |
| **【v3 新增】** AI Key 泄露 | 仅存 Keychain；UI 输入框不显示明文 |
| **【v3 新增】** 脱敏误伤（如邮箱是任务标题）| 用户白名单 + 预览"已脱敏内容"确认 |
| **【v3 新增】** 自动 commit 频率过高产生噪音 | debounce 5 分钟 + squash 同 5 分钟内多次提交 |

---

## 8. 路线图（v3 修订）

> 考虑 20 项 AI 功能入 v1 后重新划分阶段。

### P0 — MVP（v1 阶段 1）
- 项目脚手架（electron-vite + React 19 + TanStack Router + Zustand）
- better-sqlite3 集成 + 迁移脚本 + Keychain（safeStorage）
- 任务模块完整字段（含 RRULE 列、linkedNoteIds、tags、position、parentTaskId）
- 任务 CRUD + 列表视图 + Today 视图作为默认落地页
- 笔记库：chokidar + 三态机 + 自动文件名 + YAML 解析
- TipTap WYSIWYG 编辑器（基础 Markdown + KaTeX 节点 + Mermaid 节点）
- 图片粘贴/拖拽（主进程 Sharp + SHA-256 去重）
- 自动保存（debounce 500ms）+ Ctrl+S + IndexedDB 草稿栈
- 系统通知（任务到期）
- 单库目录选择模态框（**D-7**）
- 热力图 + 历史回填（**D-8**）
- Dashboard 骨架：问候条 + 3 个 KPI 磁贴 + 今日摘要卡 + Quick Action 按钮组

### P0.5 — 编辑器与渲染
- Mermaid 自定义 NodeView（dynamic import + 防抖）
- KaTeX 完整接入（**D-15**）
- 代码高亮（lowlight + highlight.js）
- tiptap-markdown 序列化集成
- 自建 SVG 热力图（365 天 + hover tooltip + 5 级分位色阶 + 深色适配）
- 最近活动时间线

### P1 — AI 智能化集成（v3 最大新增章节）
> 详见第 9 章。P1 必须完成 20 项 AI 功能中的至少 15 项，剩余 5 项在 P1.5 完成。
- AI 编排层：B 模块完整实现（多 Provider、Function Calling、上下文管理）
- AI-1 自然语言 → 任务/笔记
- AI-3 AI 任务拆解
- AI-4 任务 ↔ 笔记双向关联
- AI-5 语义搜索（向量 + FTS5 混合）
- AI-6 AI 总结每日/每周
- AI-7 智能标签建议
- AI-8 Mermaid 自动生成
- AI-11 上下文对话
- AI-16 本地 LLM 路由
- AI-17 敏感数据脱敏
- AI-18 离线降级队列
- AI-19 对话本地加密
- AI-20 本地优先开关

### P1.5 — Dashboard 完整化 + AI 收尾
- Recharts 接入（笔记字数趋势 + 时间投入趋势 + 项目分布）
- 逾期与阻塞部件
- AI 周报摘要卡片
- 贡献权重设置项 + 统计重建按钮
- mini 月历部件
- streak 统计 + 年份切换
- 当日详情抽屉
- AI-2 / AI-9 / AI-10 / AI-12 / AI-13 / AI-14 收尾

### P2 — 体验增强 + 笔记库扩展
- 双链 `[[wiki]]` + 反向链接面板
- FTS5 完整调优
- Daily Note 自动创建（**D-13 不内置模板但保留入口**）
- 版本历史（最近 50 + 30 天）
- 看板视图（Kanban）
- 全日历视图
- ZIP 打包批量导出
- 深色主题 PDF 导出
- 多库支持（最多 3 个，**D-18 v1 不做**）
- 番茄钟（**D-23**）
- Typst CLI 高保真导出模式
- 任务依赖关系图

### P3+ — 远期
- Web Clipper · 时间块 · 代码片段库 · 协同编辑（Yjs）· 库目录加密 Vault · 插件系统 · 移动端 APP

### 新增文件清单（**v3 实施路径**）

**主进程新增**：
- `src/main/ai/Router.ts` — 多 Provider 路由
- `src/main/ai/providers/OpenAIProvider.ts` / `AnthropicProvider.ts` / `OllamaProvider.ts`
- `src/main/ai/FunctionRegistry.ts` — Function Calling 工具注册表
- `src/main/ai/ContextManager.ts` — 上下文压缩 / 检索
- `src/main/ai/PiiScrubber.ts` — 敏感数据脱敏
- `src/main/ai/OfflineQueue.ts` — 离线降级队列
- `src/main/ai/Crypto.ts` — AES-256-GCM 对话加密
- `src/main/scheduler/RRuleBridge.ts` — RRULE → cron 翻译
- `src/main/git/SyncService.ts` — isomorphic-git 封装
- `src/main/notes/BackfillService.ts` — 历史活动回填
- `src/main/db/migrations/0003_ai.sql` — AI 表

**Renderer 新增**：
- `src/renderer/ai/AssistantPanel.tsx` — AI 助手侧边栏
- `src/renderer/ai/MessageList.tsx` / `InputBox.tsx`
- `src/renderer/ai/SemanticSearch.tsx` — AI-5
- `src/renderer/extensions/MathNode.tsx` — KaTeX
- `src/renderer/extensions/MermaidBlock.tsx`
- `src/renderer/extensions/WikiLink.tsx`
- `src/renderer/components/dashboard/ContributionHeatmap.tsx`
- `src/renderer/components/dashboard/Sparkline.tsx`
- `src/renderer/components/dashboard/QuickActions.tsx`
- `src/renderer/components/dashboard/TodaySummaryCard.tsx`
- `src/renderer/components/dashboard/MiniCalendar.tsx`
- `src/renderer/hooks/useNow.ts`
- `src/renderer/hooks/useAiAssistant.ts`
- `src/renderer/stores/aiStore.ts` — Zustand
- `src/renderer/stores/taskStore.ts` — Zustand
- `src/renderer/stores/noteStore.ts` — Zustand
- `src/renderer/styles/chart-tokens.css`

---

## 9. LLM 智能化集成设计（v3 新增，最大章节）

### 9.1 智能化能力地图（20 项 AI 功能）

> 标签：**触发场景** 指用户操作 / 系统事件 / 编辑器上下文。**依赖** 指除基础 AI 编排外的前置依赖。

#### A 类 — 必含（4 项）

| ID | 名称 | 触发场景 | 技术实现 | 依赖 | 优先级 |
|---|---|---|---|---|---|
| **AI-1** | 自然语言 → 结构化任务/笔记 | Quick Capture 弹窗 / 命令面板输入"明天下午 3 点和张三 review 代码" | LLM Function Call → `create_task` / `create_note`（详见 9.4）| chrono-node 解析时间 | **P1 前** |
| **AI-2** | 笔记自动生成反向链接 | 笔记保存（debounce 5s 后） | 扫描全文 → 嵌入生成（bi-encoder 或 BM25 + 候选 rerank）→ 写入 `links` 表 | 向量索引 | **P1.5** |
| **AI-3** | AI 任务拆解 | 任务详情页"AI 拆解"按钮，输入"我要学 Rust" | LLM Function Call `decompose_task` → 返回树形 JSON → 弹窗用户确认 → 批量 `create_task` | — | **P1 前** |
| **AI-4** | 任务 ↔ 笔记双向智能关联 | 任务保存 / 笔记保存 | 互相扫描候选 → Top-K 余弦相似度 + 用户确认 | 向量索引 | **P1 前** |

#### B 类 — 应该做（7 项）

| ID | 名称 | 触发场景 | 技术实现 | 依赖 | 优先级 |
|---|---|---|---|---|---|
| **AI-5** | 语义搜索（向量 + FTS5 混合）| 命令面板 / 搜索面板输入 | sqlite-vec + FTS5 BM25 加权 0.4/0.6 混合排序 | 向量模型 | **P1 前** |
| **AI-6** | AI 总结每日/每周 | Dashboard 卡片 / 设置定时（每周日 21:00）| LLM 接收当日/当周 activity_log 摘要 + 完成的笔记片段 | — | **P1 前** |
| **AI-7** | 智能标签建议 | 笔记保存 | LLM 接收正文 → 返回 tags[] → 与已有标签 fuzzy 匹配 | — | **P1 前** |
| **AI-8** | Mermaid 图自动生成 | 编辑器"插入图表" → 选"AI 生成" → 输入描述 | LLM 返回 mermaid 源码 → 插入 MermaidBlock 节点 | — | **P1 前** |
| **AI-9** | 会议纪要 → 任务清单 | 命令面板"AI 提取任务" → 粘贴纪要 | LLM Function Call `extract_tasks` 返回结构化列表 → 用户确认创建 | chrono-node | **P1.5** |
| **AI-10** | 代码块解释 / 找 Bug | 代码块右上角"AI 解释" / "AI 找 Bug" | LLM 接收 code + 上下文（所在笔记标题）| — | **P1.5** |
| **AI-11** | 上下文对话（"我今天该做什么？"）| `Ctrl+Space` 唤起助手面板 | 多轮对话 + Function Call 查任务/笔记 → 自然语言回答 | — | **P1 前** |

#### C 类 — 可以做（4 项）

| ID | 名称 | 触发场景 | 技术实现 | 依赖 | 优先级 |
|---|---|---|---|---|---|
| **AI-12** | 写作助手（续写/润色/翻译/简化）| 编辑器选中文本 → 右键菜单 / `Ctrl+J` | LLM 接收 selectedText + 前文 500 字上下文 + system prompt 指定动作 | — | **P1.5** |
| **AI-13** | 模板智能填充 | 新建笔记选模板 → 弹"AI 填充" → 填主题 | LLM 接收模板 + 主题 → 返回填充后的正文 | — | **P1.5** |
| **AI-14** | 智能调度建议 | 任务详情页"AI 建议时间" | LLM 接收任务标题/描述/预估工时 + 用户日历（可空） + 已排期任务列表 → 返回建议时段 | — | **P1.5** |
| **AI-15**【v3 隐含】 | 番茄钟自动汇总 | 番茄钟完成后 | LLM 接收本番茄钟期间修改的笔记 diff → 1 句话总结 | — | **P1.5** |

#### D 类 — 隐私与本地优先（5 项）

| ID | 名称 | 触发场景 | 技术实现 | 依赖 | 优先级 |
|---|---|---|---|---|---|
| **AI-16** | 本地 LLM 路由（Ollama 优先）| 设置页配置 Ollama URL + 模型名 | 检测本地可用 → 自动路由到本地；不可用降级云端 | Ollama 守护进程 | **P1 前** |
| **AI-17** | 敏感数据脱敏 | 所有 AI 调用前 | 正则替换邮箱/手机/身份证/URL token + 用户自定义词典 | — | **P1 前** |
| **AI-18** | 离线降级队列 | 网络中断 / Provider 5xx | 请求进 IndexedDB 队列 → 网络恢复后批量重试 | — | **P1 前** |
| **AI-19** | 对话本地加密 | 每次保存对话 | AES-256-GCM 加密 → `.taskpilot/ai/conversations.enc`，密钥来自 Keychain | Keychain | **P1 前** |
| **AI-20** | "本地优先"开关 | 设置页 toggle | 全局开关：开启时所有请求走 Ollama，关闭时按 9.6 路由策略 | Ollama | **P1 前** |

### 9.2 LLM 架构设计

#### 9.2.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│ Renderer 层（React）                                         │
│  ├─ AssistantPanel（侧边栏 UI）                              │
│  ├─ 上下文 Hooks（useAiAssistant / useSemanticSearch）      │
│  └─ 流式响应渲染（eventsource-parser）                       │
└──────────────┬──────────────────────────────────────────────┘
               │ IPC（type-safe, MessageChannelMain）
┌──────────────▼──────────────────────────────────────────────┐
│ Preload 层（contextBridge）                                  │
│  window.ai.chat / window.ai.stream / window.ai.cancel       │
└──────────────┬──────────────────────────────────────────────┘
               │ ipcMain.handle / webContents.send
┌──────────────▼──────────────────────────────────────────────┐
│ Main 层                                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ AI Router（核心调度器）                                │   │
│  │  ├─ 1. 读取 user config（本地优先 / Provider 偏好）   │   │
│  │  ├─ 2. 成本估算 & token 预算检查                      │   │
│  │  ├─ 3. PiiScrubber.scrub(messages)                    │   │
│  │  ├─ 4. ContextManager.compress(history)               │   │
│  │  ├─ 5. FunctionRegistry.bind(tools)                   │   │
│  │  ├─ 6. 选 Provider（按 9.6 路由策略）                 │   │
│  │  ├─ 7. 离线 → OfflineQueue.enqueue                    │   │
│  │  └─ 8. stream → renderer                              │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │ Providers（独立模块）                                   │   │
│  │  ├─ OpenAIProvider（gpt-4o / gpt-4o-mini）            │   │
│  │  ├─ AnthropicProvider（claude-sonnet-4 / haiku）      │   │
│  │  ├─ OllamaProvider（llama3.1 / qwen2.5 / deepseek）   │   │
│  │  └─ CustomProvider（用户自填 OpenAI 兼容 endpoint）   │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │ FunctionRegistry（工具表）                              │   │
│  │  ├─ create_task / create_note / update_task           │   │
│  │  ├─ search_semantic / search_fts                      │   │
│  │  ├─ summarize_period / extract_tasks                  │   │
│  │  ├─ suggest_tags / generate_mermaid                   │   │
│  │  └─ list_today_tasks / get_recent_notes               │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │ 持久化                                                  │   │
│  │  ├─ AIConversationStore（AES-256-GCM 加密）           │   │
│  │  ├─ Cache（embedding / 摘要 / 分类结果）              │   │
│  │  └─ CostLedger（每次调用的 token / cost）             │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### 9.2.2 Provider 接口规范

```ts
// src/main/ai/types.ts
export interface Provider {
  readonly id: string;                       // "openai" | "anthropic" | "ollama" | "custom"
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;  // 流式
  cancel(handle: string): void;
  healthCheck(): Promise<ProviderHealth>;
}

export interface ProviderCapabilities {
  functionCalling: boolean;                  // Ollama 部分模型支持
  vision: boolean;                           // 未来扩展
  jsonMode: boolean;
  streaming: boolean;
  contextWindow: number;                     // 128k / 200k / ...
}

export interface ChatRequest {
  handle: string;                            // 唯一 ID，用于取消
  model: string;                             // "gpt-4o" / "claude-sonnet-4-5" / "qwen2.5:14b"
  messages: ChatMessage[];
  tools?: ToolSpec[];                        // Function Calling schema
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  metadata?: Record<string, any>;
}

export interface ChatChunk {
  deltaText?: string;
  deltaToolCall?: PartialToolCall;
  finishReason?: 'stop' | 'tool_use' | 'length' | 'error';
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ToolSpec {
  name: string;                              // "create_task"
  description: string;
  inputSchema: JSONSchema;                   // 标准 JSON Schema
}
```

#### 9.2.3 路由策略（9.6 详述）

```ts
// src/main/ai/Router.ts
class AiRouter {
  async route(req: ChatRequest): Promise<ProviderDecision> {
    const cfg = await this.configStore.get();
    
    // 1. 本地优先（AI-20）
    if (cfg.localFirst || this.shouldForceLocal(req)) {
      const local = await this.providers.get('ollama').healthCheck();
      if (local.ok) return { provider: 'ollama', reason: 'local-first' };
    }
    
    // 2. 离线检测
    if (!this.networkMonitor.isOnline()) {
      if (req.allowQueue) {
        await this.offlineQueue.enqueue(req);
        return { provider: null, reason: 'queued-offline' };
      }
      throw new OfflineError();
    }
    
    // 3. 成本路由
    if (req.estimatedCost > cfg.hardCostLimit) {
      if (cfg.localFirst) throw new CostLimitError();
      // 降级到本地
      const local = await this.providers.get('ollama').healthCheck();
      if (local.ok) return { provider: 'ollama', reason: 'cost-cap' };
    }
    
    // 4. 用户偏好 Provider
    const preferred = cfg.preferredProvider ?? 'anthropic';
    return { provider: preferred, reason: 'user-preference' };
  }
}
```

#### 9.2.4 上下文管理（ContextManager）

```ts
class ContextManager {
  /** 多轮对话压缩：保留 system + 最近 4 轮 + 中段摘要 */
  async compress(history: ChatMessage[]): Promise<ChatMessage[]> {
    if (this.estimateTokens(history) <= 8000) return history;
    
    const sysMsg = history.find(m => m.role === 'system');
    const recent = history.slice(-8); // 最近 4 轮
    const middle = history.slice(1, -8); // 中段
    
    if (middle.length === 0) return history;
    
    // 用便宜模型生成摘要
    const summary = await this.router.summarize({
      messages: middle,
      modelHint: 'cheap',  // claude-haiku / gpt-4o-mini / qwen2.5:1.5b
      systemPrompt: '请用 200 字内总结以下对话的关键决策、事实、待办。'
    });
    
    return [
      sysMsg,
      { role: 'system', content: `[Earlier summary]: ${summary.text}` },
      ...recent
    ];
  }
  
  /** 为 LLM 调用准备检索上下文（AI-11 等场景）*/
  async retrieveContext(query: string, opts: RetrieveOpts): Promise<ContextPack> {
    const [semantic, fts, recent] = await Promise.all([
      this.semanticSearch.search(query, { topK: 8 }),
      this.ftsSearch.search(query, { topK: 8 }),
      this.recentActivity.list({ days: 3 })
    ]);
    
    // 去重 + 排序
    const merged = this.mergeAndRank(semantic, fts, recent);
    return { snippets: merged.slice(0, 12), totalTokens: this.estimate(merged) };
  }
}
```

### 9.3 数据采集

> 热力图与 AI 能力都依赖 activity_log。统一采集，统一消费。

```ts
// src/main/stats/ActivityTracker.ts
class ActivityTracker {
  async record(event: ActivityEvent): Promise<void> {
    const enriched: ActivityEvent = {
      ...event,
      id: nanoid(),
      ts: Date.now(),
      localDate: this.toLocalDate(new Date()),
      weight: this.weightFor(event.kind)
    };
    await this.db.insert('activity_log', enriched);
    await this.aggregationService.realtimeUpdate(enriched.localDate);
  }
  
  /** chokidar 监听笔记 → 触发 */
  async onNoteChange(path: string, changeType: 'created' | 'modified' | 'deleted'): Promise<void> {
    const before = await this.readFileSafely(this.lastContentCache.get(path));
    const after = await this.readFileSafely(path);
    
    // rename 合并 + content_hash 去重 + 10 分钟会话合并
    const dedupKey = sha256(after);
    if (await this.isRecentDuplicate(path, dedupKey)) return;
    
    await this.record({
      kind: changeType === 'created' ? 'note_created' : 'note_edited',
      entityType: 'note',
      entityId: await this.getNoteIdByPath(path),
      deltaChars: changeType === 'modified' ? Math.max(0, after.length - before.length) : after.length,
      meta: { path, hash: dedupKey }
    });
  }
  
  /** 任务完成钩子 */
  async onTaskCompleted(taskId: string): Promise<void> {
    const task = await this.db.getTask(taskId);
    await this.record({
      kind: 'task_completed',
      entityType: 'task',
      entityId: taskId,
      meta: { title: task.title, priority: task.priority }
    });
  }
}
```

**事件类型枚举**：
- `task_completed` / `task_created` / `task_status_changed`
- `note_created` / `note_edited` / `note_chars`（细粒度字符 diff）
- `ai_call`（调 AI 时记录成本）/ `ai_offline_queued`
- `pomodoro_completed`（P1）
- `git_commit` / `git_push` / `git_pull`（**v3 新增**）

### 9.4 Function Calling 工具列表（完整 schema）

> 所有工具统一注册到 `FunctionRegistry`。每个工具有：
> 1. JSON Schema（传给 LLM）
> 2. 本地 handler（LLM 返回 tool_call 时执行）
> 3. 权限分级（自动 / 用户确认 / 需输入）

#### 9.4.1 任务类（4 个）

**create_task**
```json
{
  "name": "create_task",
  "description": "创建一个新任务。需要用户确认（除非在 AI-1 弹窗已确认）。",
  "input_schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "description": "任务标题" },
      "description": { "type": "string", "description": "Markdown 描述" },
      "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"], "default": "P2" },
      "dueAt": { "type": "string", "format": "date-time", "description": "ISO 8601" },
      "estimateMinutes": { "type": "integer" },
      "tags": { "type": "array", "items": { "type": "string" } },
      "parentTaskId": { "type": "string", "description": "父任务 ID，子任务两级" },
      "linkedNotePaths": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["title"]
  }
}
```
Handler：
```ts
async (input, ctx) => {
  const task = await ctx.db.createTask({
    ...input,
    id: nanoid(),
    status: 'todo',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  await ctx.activity.record({ kind: 'task_created', entityId: task.id });
  return { success: true, taskId: task.id, task };
}
```

**update_task** / **complete_task** / **decompose_task**（AI-3 专用）

**decompose_task**：
```json
{
  "name": "decompose_task",
  "description": "把任务拆解为子任务树。仅两层。返回 JSON 数组，每个元素是子任务对象（含 title / description / estimateMinutes / priority）。",
  "input_schema": {
    "type": "object",
    "properties": {
      "parentTitle": { "type": "string" },
      "children": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" },
            "estimateMinutes": { "type": "integer" },
            "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] }
          },
          "required": ["title"]
        }
      }
    },
    "required": ["children"]
  }
}
```

#### 9.4.2 笔记类（3 个）

**create_note** / **update_note** / **append_to_note**

**create_note**：
```json
{
  "name": "create_note",
  "description": "创建新笔记。path 相对于库根目录。",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "如 'notes/项目A/设计稿.md'" },
      "content": { "type": "string", "description": "完整 Markdown 内容" },
      "tags": { "type": "array", "items": { "type": "string" } },
      "frontMatter": { "type": "object", "description": "额外 YAML 字段" }
    },
    "required": ["path", "content"]
  }
}
```

#### 9.4.3 检索类（4 个）

**search_semantic**（AI-5 专用）：
```json
{
  "name": "search_semantic",
  "description": "用自然语言查询返回最相关的笔记片段。结合向量相似度 + FTS5 BM25。",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "topK": { "type": "integer", "default": 10, "maximum": 30 },
      "filters": {
        "type": "object",
        "properties": {
          "tags": { "type": "array", "items": { "type": "string" } },
          "dateRange": {
            "type": "object",
            "properties": { "from": { "type": "string", "format": "date-time" }, "to": { "type": "string", "format": "date-time" } }
          },
          "excludeArchived": { "type": "boolean", "default": true }
        }
      }
    },
    "required": ["query"]
  }
}
```

**search_fts** / **get_note_by_path** / **get_recent_notes**

#### 9.4.4 时间与任务上下文（3 个）

**list_today_tasks** / **list_overdue_tasks** / **list_tasks_by_tag**

**list_today_tasks**：
```json
{
  "name": "list_today_tasks",
  "description": "列出今日到期 / 今日新建 / 逾期的任务。",
  "input_schema": {
    "type": "object",
    "properties": {
      "includeCompleted": { "type": "boolean", "default": false },
      "priorityFilter": { "type": "array", "items": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] } }
    }
  }
}
```

#### 9.4.5 摘要与提取（4 个）

**summarize_period**（AI-6）/ **extract_tasks**（AI-9）/ **suggest_tags**（AI-7）/ **generate_mermaid**（AI-8）

**extract_tasks**：
```json
{
  "name": "extract_tasks",
  "description": "从会议纪要中提取任务清单。",
  "input_schema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "会议纪要原文" },
      "defaultAssignee": { "type": "string", "description": "默认执行人" }
    },
    "required": ["text"]
  }
}
```
返回每个任务：title, description, dueAt (parsed via chrono-node), priority (inferred), tags。

**generate_mermaid**：
```json
{
  "name": "generate_mermaid",
  "description": "把自然语言描述转换为 Mermaid 图源码。",
  "input_schema": {
    "type": "object",
    "properties": {
      "description": { "type": "string" },
      "diagramType": { "type": "string", "enum": ["flowchart", "sequence", "class", "state", "er", "gantt", "auto"], "default": "auto" }
    },
    "required": ["description"]
  }
}
```

#### 9.4.6 元操作（2 个）

**explain_code**（AI-10）/ **rewrite_text**（AI-12）

**rewrite_text**：
```json
{
  "name": "rewrite_text",
  "description": "对选中文本执行指定动作（续写/润色/翻译/简化）。",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["continue", "polish", "translate", "simplify", "expand"] },
      "text": { "type": "string" },
      "context": { "type": "string", "description": "前文 500 字上下文" },
      "targetLanguage": { "type": "string", "description": "翻译目标语言，en/zh-CN/ja 等" }
    },
    "required": ["action", "text"]
  }
}
```

#### 9.4.7 工具权限分级

| 工具 | 默认权限 | 二次确认场景 |
|---|---|---|
| create_task / create_note | **用户确认**（除非 AI-1 弹窗已确认）| 永远确认 |
| update_task / update_note | **用户确认** | 永远确认 |
| complete_task / delete_task / delete_note | **用户确认 + 输入"确认删除"** | 强确认 |
| decompose_task | **用户确认**（弹窗预览树形）| 永远确认 |
| search_* / list_* / get_* | **自动**（只读）| — |
| summarize_period / extract_tasks / suggest_tags / generate_mermaid | **自动**（返回结果让用户决定）| — |
| explain_code / rewrite_text | **自动**（返回结果，弹窗预览）| — |

### 9.5 隐私保护设计

#### 9.5.1 敏感数据脱敏（AI-17）

```ts
// src/main/ai/PiiScrubber.ts
const PATTERNS = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phoneCN: /\b1[3-9]\d{9}\b/g,
  idCardCN: /\b[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  urlWithToken: /\bhttps?:\/\/[^\s]+(?:token|key|api_key|secret)=[A-Za-z0-9_-]+/gi,
  creditCard: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
  jwt: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  privateKey: /-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----[\s\S]+?-----END/g
};

class PiiScrubber {
  private userDict: Map<string, string> = new Map(); // 自定义敏感词 → 占位
  
  scrub(input: string | ChatMessage[]): ScrubResult {
    const original = typeof input === 'string' ? input : JSON.stringify(input);
    let scrubbed = original;
    const replacements: Array<{ from: string; to: string }> = [];
    
    for (const [kind, pattern] of Object.entries(PATTERNS)) {
      scrubbed = scrubbed.replace(pattern, (match) => {
        const placeholder = `[${kind.toUpperCase()}_${hashCode(match) % 10000}]`;
        replacements.push({ from: match, to: placeholder });
        return placeholder;
      });
    }
    
    for (const [word, placeholder] of this.userDict) {
      if (scrubbed.includes(word)) {
        scrubbed = scrubbed.split(word).join(placeholder);
        replacements.push({ from: word, to: placeholder });
      }
    }
    
    return { scrubbed, replacements, previewDiff: this.diffPreview(original, scrubbed) };
  }
  
  /** 预览给用户"已脱敏 N 处"，可一键还原 */
  restore(text: string, replacements: Array<{ from: string; to: string }>): string {
    return replacements.reduce((acc, r) => acc.split(r.to).join(r.from), text);
  }
}
```

**用户控制**：
- 设置页"AI 隐私"tab：勾选哪些 PII 类型需要脱敏
- 自定义敏感词列表（公司内部代号、客户姓名）
- "本次请求不脱敏"复选框（弹窗级别）

#### 9.5.2 本地优先（AI-16 + AI-20）

- 设置页"AI 提供方"：下拉选择 `OpenAI / Anthropic / Ollama / 自定义`
- "本地优先"开关（AI-20）：开启后所有请求先尝试 Ollama
- Ollama 健康检查：每 60s ping 一次 `http://localhost:11434/api/tags`
- 用户自选 Ollama 模型：`qwen2.5:7b`（中文好）/ `llama3.1:8b`（英文好）/ `deepseek-r1:7b`（推理）

#### 9.5.3 对话本地加密（AI-19）

```ts
// src/main/ai/Crypto.ts
class ConversationCrypto {
  private key: Buffer;
  
  async init(): Promise<void> {
    // 从 Keychain 读取；不存在则生成并保存
    let stored = await safeStorage.get('ai-conversation-key');
    if (!stored) {
      this.key = randomBytes(32);
      await safeStorage.set('ai-conversation-key', this.key.toString('base64'));
    } else {
      this.key = Buffer.from(stored, 'base64');
    }
  }
  
  encrypt(plaintext: string): EncryptedBlob {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: tag.toString('base64') };
  }
  
  decrypt(blob: EncryptedBlob): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}
```

存储路径：`.taskpilot/ai/conversations.enc`（每行一条对话 JSON）。

#### 9.5.4 用户可见的隐私控制台

设置页"AI 隐私"tab 显示：
- 本月 token 用量 + 估算成本
- 本月调用次数（按 Provider 分布饼图）
- 脱敏命中次数
- 离线队列长度
- 一键导出所有 AI 对话（明文） / 一键删除所有 AI 历史

### 9.6 成本与性能控制

#### 9.6.1 路由策略（决策表）

| 场景 | 优先级 | 决策 |
|---|---|---|
| 本地优先开关开启 + Ollama 可用 | 1 | **走 Ollama**（0 成本、低延迟、隐私）|
| 本地优先开关开启 + Ollama 不可用 + 网络可用 | 2 | 走云端用户偏好 Provider |
| 本地优先关闭 + 估算成本 < 阈值 + 网络可用 | 3 | 走云端用户偏好 Provider |
| 估算成本 ≥ 单次上限（默认 $0.10）| 4 | **降级到 Ollama**（即使本地优先关闭）|
| 网络不可用 + 任务允许排队 | 5 | 进 OfflineQueue |
| 网络不可用 + 任务不允许排队 | 6 | 抛错给 UI 提示 |

#### 9.6.2 Token 预算

| 维度 | 默认值 | 可调 |
|---|---|---|
| 单次请求 token 上限 | 16k input + 4k output | 是 |
| 单日总成本上限 | $5.00 | 是 |
| 单月总成本上限 | $50.00 | 是 |
| 命中上限后行为 | 弹窗"已达上限" + 提供"继续用本地 LLM" | — |

#### 9.6.3 缓存策略

| 内容 | 缓存 key | TTL |
|---|---|---|
| Embedding | `emb:<model>:<sha256(text)>` | 永久 |
| AI-7 标签建议 | `tags:<sha256(text)>` | 永久 |
| AI-6 每日总结 | `summary:daily:<local_date>` | 当日 |
| AI-6 每周总结 | `summary:weekly:<iso_week>` | 当周 |
| AI-8 Mermaid 生成 | `mermaid:<sha256(description)>` | 永久 |
| Function Call 结果 | `fn:<name>:<sha256(args)>` | 10 分钟 |

**实现**：SQLite 表 `ai_cache` + `cache_metadata`，启动时预热最近 1000 条。

#### 9.6.4 批处理与异步

- **AI-4 双向关联**：用户保存笔记时不阻塞 UI，异步批处理（5 分钟窗口合并多次保存）
- **AI-6 周报**：周日 21:00 定时触发，异步生成，第二天 Dashboard 显示
- **AI-7 标签建议**：保存后 debounce 5s 再调
- **AI-2 反向链接**：同 AI-4

#### 9.6.5 性能指标（必须监控）

| 指标 | 目标 | P95 上限 |
|---|---|---|
| TTFT（首字时间）| 800ms | 2s |
| 全响应时间（500 token 输出）| 3s | 8s |
| 流式 chunk 间隔 | 50ms | 200ms |
| Function Call 总耗时（含本地执行）| 1.5s | 4s |
| 向量搜索（1000 笔记）| 100ms | 300ms |

### 9.7 评估体系

#### 9.7.1 离线评测（CI 跑）

每个 AI 功能配一个评测集（开发者侧，**不上传到用户**）：

| AI 功能 | 评测集 | 指标 |
|---|---|---|
| AI-1 自然语言→任务 | 200 句中文指令 + 期望结构化结果 | 字段准确率 ≥ 85%、时间解析准确率 ≥ 90% |
| AI-3 任务拆解 | 50 个真实任务场景 | 树形覆盖率 ≥ 80%、子任务粒度合理率 ≥ 75% |
| AI-5 语义搜索 | 100 个查询 + 人工标注的相关笔记 | nDCG@10 ≥ 0.75 |
| AI-6 总结 | 30 个真实一周活动 | 关键事件覆盖率 ≥ 80%、幻觉率 ≤ 10% |
| AI-8 Mermaid 生成 | 50 个自然语言描述 | 语法正确率 ≥ 90%、语义匹配率 ≥ 70% |
| AI-10 代码解释 | 30 个代码片段 + 标准答案 | 教师评分 ≥ 4/5（5 分制）|
| AI-11 上下文对话 | 100 个"今天做什么"类问题 | 调对 Function Call 的比例 ≥ 85% |

#### 9.7.2 在线反馈（用户侧，可选）

- 每个 AI 响应下方 thumbs up/down + 可选评论
- 数据匿名化后用于改进 prompt（用户可一键关闭）
- **隐私承诺**：反馈数据不上传服务器（v1 不做服务端，全部本地统计）

#### 9.7.3 A/B 测试（v1 不上，但预留）

- 配置层 key 包含 `variant` 字段
- 评测集可指定 variant

### 9.8 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| AI 调用成本失控 | 经济 | 9.6.2 硬上限 + 月预算看板 |
| AI 输出幻觉 | 功能正确性 | 关键操作二次确认（9.4.7）；AI-6 总结注明"基于以下事件"并展示原始数据 |
| AI 调用延迟 | 体验 | 流式 + 本地优先 + 离线队列 |
| 隐私泄漏（即使脱敏）| 法律 + 信任 | 本地优先默认开启；脱敏白名单用户可控；加密对话 |
| 本地 LLM 模型选择 | 效果 | 设置页"模型推荐"根据用户机器配置（RAM/VRAM）推荐合适 size |
| Ollama 进程崩溃 | 可用性 | 健康检查 + 自动重启 + 降级云端 |
| 模型版本升级破坏 Function Calling | 功能 | 锁定版本 + 升级前回归评测 |
| 评测集过期 | 模型漂移 | 每季度跑一次离线评测 |
| 用户 prompt 注入 | 安全 | 系统 prompt 与用户内容严格分隔；用户消息不参与 system prompt 拼接 |
| Function Call 死循环 | 资源 | 最大重试次数 3 + 超时 30s + 兜底"AI 出错了，请重试" |

---

## 10. RRULE 集成设计（新增小节）

### 10.1 用例

| 场景 | 描述 |
|---|---|
| 每周站会 | `FREQ=WEEKLY;BYDAY=MO` 每周一 09:00 |
| 每月月报 | `FREQ=MONTHLY;BYMONTHDAY=1` 每月 1 号 |
| 工作日通勤 | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` 工作日 18:00 |
| 每季度复盘 | `FREQ=MONTHLY;INTERVAL=3` 每 3 个月 |
| 复杂规则 | "每周二四六的最后一个工作日" → `FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYDAY=SA`（更复杂组合）|

### 10.2 库选型

- **`rrule`**（npm：~80KB）：事实标准，支持 RFC 5545 完整语法。
- **`rrule.js` vs `@rschedule` vs `ical.js`**：选 `rrule.js` 因 API 简洁 + 文档完整 + 体积小。

### 10.3 与 croner 的桥接

```ts
// src/main/scheduler/RRuleBridge.ts
import { RRule, RRuleSet, rrulestr } from 'rrule';
import { Cron } from 'croner';

class RRuleBridge {
  /** RRULE → cron 表达式（仅支持常见子集）*/
  toCron(rrule: string, anchorLocalDate: Date): { expr: string; next: Date } {
    const rule = rrulestr(rrule, { dtstart: anchorLocalDate });
    
    // RRULE 频率 → cron 字段
    const freq = this.extractFreq(rule); // 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
    const interval = rule.options.interval ?? 1;
    
    switch (freq) {
      case 'DAILY':
        return {
          expr: interval === 1 ? `${rule.options.byminute?.[0] ?? 0} ${rule.options.byhour?.[0] ?? 9} * * *`
                                : `0 9 */${interval} * *`,
          next: rule.after(new Date(), false)
        };
      case 'WEEKLY':
        // RRULE BYDAY → cron DOW
        const days = rule.options.byweekday?.map(d => d === RRule.SU ? 0 : d + 1).join(',') ?? '1';
        return {
          expr: `${rule.options.byminute?.[0] ?? 0} ${rule.options.byhour?.[0] ?? 9} * * ${days}`,
          next: rule.after(new Date(), false)
        };
      case 'MONTHLY':
        const dom = rule.options.bymonthday?.[0] ?? 1;
        return {
          expr: `${rule.options.byminute?.[0] ?? 0} ${rule.options.byhour?.[0] ?? 9} ${dom} */${interval} *`,
          next: rule.after(new Date(), false)
        };
      // YEARLY / HOURLY / MINUTELY 等较少用，留 TODO
      default:
        throw new UnsupportedRRuleError(`频率 ${freq} 暂不支持，请简化规则`);
    }
  }
  
  /** RRULE → 用户友好的中文描述 */
  describe(rrule: string): string {
    return RRule.prototype.toText.call(rrulestr(rrule));
  }
  
  /** 用户预览"下一次触发" */
  nextOccurrences(rrule: string, count = 5): Date[] {
    const rule = rrulestr(rrule);
    return rule.all((_, i) => i < count);
  }
}
```

### 10.4 任务调度架构

```
┌──────────────────────────────────────────────────┐
│ Main: SchedulerService                            │
│  ├─ 启动时加载所有 task.recurrence                 │
│  ├─ 对每条 RRULE → RRuleBridge.toCron → croner    │
│  ├─ cronexpr 触发 → 任务检查                       │
│  │   ├─ 任务本身是模板（recurrence_anchor_id == self）│
│  │   │   → 复制生成新 occurrence                    │
│  │   │   → 设置新 due_at                            │
│  │   │   → 写 activity_log (task_created)           │
│  │   └─ 否则是已展开的 occurrence                    │
│  │       → 标记状态 / 触发提醒                       │
│  └─ 任务删除/修改 → 重排 cron                        │
└──────────────────────────────────────────────────┘
```

### 10.5 UI 设计

**新建/编辑任务** → "重复"字段：
- **简单模式**（默认）：下拉 `不重复 / 每天 / 每周 / 每月 / 每年 / 自定义`
- **高级模式**：文本框 + RRULE 编辑器（带语法高亮 + 实时预览"下一次：2026-09-05 09:00" + 未来 5 次列表）
- **自然语言输入**（AI-14 辅助）：输入"每周二四早上 9 点" → 自动转 RRULE → 用户确认

### 10.6 边界与约束

- **不支持**：`BYDAY=20MO`（第几个星期几）这类复杂组合留 TODO，UI 提示"请用高级模式手动编辑"
- **时区**：RRULE 存储本地时区偏移，跨时区设备同步由 Git 处理（详见第 11 章）
- **异常**：跳过周末 / 节假日 → 用户手动调整，不在 v1 范围

---

## 11. Git 自动同步设计（新增小节）

### 11.1 技术选型

- **首选 `isomorphic-git`**（npm：~200KB，纯 JS，无 native 依赖，Electron 友好）
- **备选** `simple-git`（包一层 `git` CLI，需要系统安装 git，不适合跨平台 Electron）
- **结论**：选 **isomorphic-git**

### 11.2 仓库配置

设置页"同步"tab：
- **仓库地址**（必填）：HTTPS URL（`https://github.com/user/repo.git`）或 SSH（需用户提供 SSH key）
- **分支**：默认 `main`，可改
- **用户名 / Email**：用于 git commit author
- **凭据**：HTTPS 用 Personal Access Token（存 Keychain）；SSH 用 ssh-agent 桥接
- **首次同步**：点击"初始化"按钮 → `git init`（如本地无仓库）+ `git remote add origin <url>` + 首次 `fetch` + `reset --hard origin/main`（**确认弹窗**，避免覆盖本地）

### 11.3 自动 commit 策略

```ts
// src/main/git/SyncService.ts
class GitSyncService {
  private debounceTimer: NodeJS.Timeout | null = null;
  private static DEBOUNCE_MS = 5 * 60 * 1000; // 5 分钟
  
  /** 主进程监听 file_change / task_change / note_change 事件 → 触发 */
  onChange(event: ChangeEvent): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.commit(), GitSyncService.DEBOUNCE_MS);
  }
  
  /** 用户主动保存（Ctrl+S）也触发一次 */
  async commit(force = false): Promise<void> {
    if (!this.shouldCommit()) return;
    
    const status = await this.git.statusMatrix({ fs, dir: this.libraryPath });
    const changes = status.filter(([_, workdir, stage, HEAD]) =>
      workdir !== stage || stage !== HEAD
    );
    
    if (changes.length === 0) return;
    
    // 1. git add
    for (const [filepath, workdir, ,] of changes) {
      if (workdir !== 0) await this.git.add({ fs, dir: this.libraryPath, filepath });
    }
    
    // 2. git commit
    const summary = this.buildCommitMessage(changes);
    await this.git.commit({
      fs, dir: this.libraryPath,
      message: summary,
      author: { name: this.config.gitUser, email: this.config.gitEmail }
    });
    
    await this.activityLog.record({
      kind: 'git_commit',
      meta: { filesChanged: changes.length, message: summary }
    });
  }
  
  /** squash 同 5 分钟内的多次提交 */
  private buildCommitMessage(changes): string {
    const counts = { notes: 0, tasks: 0, others: 0 };
    for (const [filepath] of changes) {
      if (filepath.endsWith('.md')) counts.notes++;
      else if (filepath.includes('tasks.sqlite')) counts.tasks++;
      else counts.others++;
    }
    return `Auto: ${counts.notes} 笔记, ${counts.tasks} 任务更新`;
  }
}
```

**触发源**：
- 笔记保存（debounce 1.5s 已写盘）→ 5 分钟 debounce → commit
- 任务创建/完成/更新 → 立即触发 5 分钟 debounce
- 设置项变更（同步开关） → 不触发
- AI 调用结果写入 → 不触发（写到 `.taskpilot/ai/` 但被 `.gitignore` 排除）

### 11.4 排除规则

```gitignore
# .taskpilot 目录不进入 Git（应用私有元数据 + AI 缓存 + 对话加密文件）
.taskpilot/

# 系统垃圾
.DS_Store
Thumbs.db
*.swp
*.tmp
~$*

# 大附件（可选）
assets/files/*.zip
assets/files/*.pdf
```

### 11.5 push / pull 按钮

Dashboard 顶栏"Sync"按钮（图标）：
- 点击下拉菜单：
  - **Push**：本地 commit → 推送到 `origin/main`
  - **Pull**：远端 → 本地 rebase/merge（弹窗让用户选）
  - **状态**：显示 ahead/behind 计数（如 `↑ 3 ↓ 0`）

**冲突检测**：
```ts
async pull(): Promise<PullResult> {
  await this.git.fetch({ ... });
  const local = await this.git.resolveRef({ ref: 'HEAD' });
  const remote = await this.git.resolveRef({ ref: 'origin/main' });
  
  if (local === remote) return { status: 'up-to-date' };
  
  const baseCommit = await this.git.findMergeBase({ ... });
  const diverged = (local !== baseCommit) && (remote !== baseCommit);
  
  if (diverged) {
    // 拉取并尝试 rebase
    try {
      await this.git.pull({ ... });
      return { status: 'fast-forward' };
    } catch (e) {
      return { status: 'conflict', conflictingFiles: this.detectConflicts() };
    }
  }
  
  // 简单情况
  await this.git.merge({ ... });
  return { status: 'merged' };
}
```

**冲突 UI**：弹窗列出冲突文件 + 三选项（"保留我的"/"保留远端"/"手动合并"打开编辑器）。

### 11.6 多设备场景

| 设备 A 修改 + commit + push | 设备 B 离线 | 设备 B 上线 |
|---|---|---|
| ✓ | ✓ | 点 Pull → rebase → 看到 A 的变更 |

| 设备 A 修改 + 未 push | 设备 B 修改 + push | A 上线 |
|---|---|---|
| ✓ | ✓ | Pull → 冲突 → 三选项 UI |

**典型保证**：
- 同一笔记两设备同时编辑 → 内容冲突（文本合并由用户在编辑器手解决）
- 任务字段两设备同时改 → SQLite 用 last-write-wins（updatedAt 较新的为准），记录 `git_conflict_resolved` 事件

### 11.7 风险

| 风险 | 对策 |
|---|---|
| 凭据泄露 | HTTPS Token 存 Keychain；UI 不显示明文 |
| 推送大文件 | `.gitignore` 排除 `assets/files/`；设置项"最大单文件 5MB 警告"|
| 网络中断 push 失败 | 重试 3 次 + 退避指数；失败入 OfflineQueue（复用 AI 队列）|
| 强制 push 覆盖远端历史 | **禁用** `--force`；只在用户明确"我接受覆盖"时允许 |
| 仓库被删除 | 健康检查 + 友好提示"仓库不可达" |

### 11.8 首次使用向导

设置页首次进入"Sync"tab 显示向导：
1. 选择 GitHub / Gitee / 自建 Git（输入 URL）
2. 填 Token（GitHub PAT 示例：`ghp_xxx`）
3. 选库目录作为仓库根（自动 init）
4. 测试连接
5. 完成 → 主进程开始监听

---

## 12. 待确认的剩余问题（v3 缩小清单）

> v2 的 20 个问题中绝大部分已确认。剩余需要确认的：

### 必须确认（影响 AI 上线）

1. **【必】** AI 默认路由策略：开启后是 `本地优先 + 降级云端`（推荐）还是 `云端优先 + 用户手动切换本地`？
2. **【必】** 自动 commit 的默认 debounce 间隔：5 分钟（推荐）还是 1 分钟（更频繁）？
3. **【必】** AI 单日成本上限默认值：$5 / $10 / $20？
4. **【必】** Ollama 模型推荐策略：自动检测机器配置推荐？还是让用户自己选？

### 建议确认（影响细节体验）

5. **【建】** RRULE 高级模式是否 v1 暴露给普通用户？还是仅 P1.5 解锁？
6. **【建】** AI-12 写作助手是否区分"中文润色"和"英文润色"两套 system prompt？
7. **【建】** Git push 频率：仅手动 push / 每次 commit 后自动 push / 每天定时 push？
8. **【建】** 多设备同步时，AI 对话历史是否同步到 Git？（默认否，因已加密且量大；但提供"包含 AI 历史到 Git"选项）
9. **【建】** 番茄钟 P1 阶段是否纳入？用户已拍板纳入但需确认时间窗（P1 前 / P1 中 / P1 末）。

### 可选确认（未来扩展）

10. **【选】** Function Call 工具开放给第三方插件？（v1 不做，预留 hook）

---

## 附：合规性自查（v3）

- ✅ D-1 热力图数据源 = 任务 + 笔记 + **回填历史**
- ✅ D-2 存储 = Obsidian 风格 .md 文件
- ✅ D-3 PlantUML = 不支持（文档无任何 PlantUML 字样）
- ✅ D-4 编辑器 = 纯 WYSIWYG（TipTap）
- ✅ D-5 技术栈 = Vite + React（非 Next.js）
- ✅ D-6 数据库 = better-sqlite3 不加密；Keychain 存 Key
- ✅ D-7 库目录 = 首次打开模态框自选
- ✅ D-8 热力图回填历史
- ✅ D-9 Dashboard 默认 = Today 视图
- ✅ D-10 笔记自动文件名 = Obsidian 风格 + 首个 H1 重命名
- ✅ D-11 重复任务 = RRULE + croner 桥接
- ✅ D-12 子任务 = 仅两级
- ✅ D-13 内置模板 = v1 不做
- ✅ D-14 标签嵌套 = `#项目/前端`
- ✅ D-15 KaTeX = v1 必含
- ✅ D-16 PDF 密码 = v1 不做
- ✅ D-17 Git 同步 = isomorphic-git 自动 commit + push/pull
- ✅ D-18 多库 = v1 单库
- ✅ D-19 快捷键 = MVP 内置 + 设置页可改
- ✅ D-20 i18n = v1 全中文
- ✅ D-21 协同编辑 = 不做
- ✅ D-22 库加密 = 不做
- ✅ D-23 番茄钟 = P1 纳入
- ✅ D-24 LLM 智能化 = 20 项 AI 功能全部 v1

---

## 附：v3 关键数字一览

| 项 | 数字 |
|---|---|
| 用户原话需求 | 14 条（100% 覆盖） |
| A 类盲点 | 16 条全部纳入 |
| B 类盲点 | 16 条，10 条 v1，6 条 P1+ |
| AI 功能 | 20 项（D-AI-1 ~ D-AI-20，跳过 15 因与 RRULE 同号） |
| Function Call 工具 | 18 个（create/update/complete/decompose task × 4，create/update/append note × 3，search × 4，list × 3，summarize/extract/suggest/mermaid × 4，explain/rewrite × 2）|
| 数据库表 | tasks / notes / note_tasks / tags / links / activity_log / activity_daily / ai_conversations / ai_cache / cost_ledger / git_state 等 |
| 主进程模块 | 12+ 个（db / notes / stats / pdf / scheduler / git / ai / ipc 等） |
| Renderer 模块 | 10+ 个（routes / components / stores / extensions / ai） |
| 路线图阶段 | P0 / P0.5 / P1 / P1.5 / P2 / P3+ 共 6 阶段 |
| 风险项 | P0: 10 条 / P1: 18 条 / P2: 14 条 |
| RRULE → cron 桥接 | 支持 DAILY / WEEKLY / MONTHLY / YEARLY 四种频率 |
| Git 同步 debounce | 5 分钟 |
| AI 单次成本上限 | 默认 $0.10 |
| AI 单日成本上限 | 默认 $5.00 |
| AI 单月成本上限 | 默认 $50.00 |
| 首屏主包目标 | < 700KB gzip |
| 全功能加载 | ~6MB gzip（含本地 LLM 模型） |

---

**文档完成。**

v3 相对 v2 的关键升级：
1. **架构**：Next.js → Vite + React + electron-vite + TanStack Router + Zustand
2. **加密**：移除 SQLCipher，明确 better-sqlite3 不加密 + Keychain 存 Key
3. **重复规则**：从 cron 思路升级为 RRULE (RFC 5545) + rrule.js + croner 桥接
4. **同步**：从 `.gitignore` 模板升级为 isomorphic-git 自动 commit + push/pull
5. **20 项 AI 功能**：A+B+C+D 类共 20 项全部纳入 v1，含 Function Calling schema、脱敏、本地优先、离线队列、对话加密
6. **数学公式**：KaTeX 从 P1 升级为 v1 必含
7. **Dashboard 默认**：明确 Today 视图
8. **热力图**：新增历史回填

下一步：等待用户回复第 12 章的 10 个待确认问题后即可进入实施。