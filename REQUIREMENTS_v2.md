```markdown
# TaskPilot需求规格说明书 v2

## 0. 文档元信息

- **版本**：v2.0
- **日期**：2026-08-30
- **变更说明**：
  - 在 v1 基础上，新增12 条结构化需求（R-1 ~ R-12），其中 R-8（PlantUML）已主动放弃。
  - 整合 5 份专题研究（Dashboard、热力图、WYSIWYG/Mermaid、PDF 导出、文档库）与 1 份盲点清单。
  - 模块结构由3 大块（任务/AI/调度）扩展为 8 大块，新增 D/E/F/G/H 五大模块群。
  - 加入 A/B/C 三类潜在盲点（A 类16 条建议纳入）。
- **与 v1 核心差异**：从「任务 + AI 编排 + 调度」扩展为「任务 + 笔记 + 文档 + 仪表盘 + 编辑器 + 导出」的复合型个人生产力工具。

---

## 1. 用户原话需求清单

> 优先级标记：**M** = 必须有（MVP阻塞） · **S** =应该有（v1 必交付） · **C** = 可以有（P1+） · **W** = 看情况

| 编号 | 用户原话 | 优先级 | 对应需求 | 状态 |
|---|---|---|---|---|
| O-1 | 贡献热力图 | S | R-1 | 纳入 |
| O-2 | 其他快捷图表 | S | R-2 | 纳入 |
| O-3 | 快捷功能 | S | R-2 | 纳入 |
| O-4 | 方便安排任务 | M | R-4 / R-5 | 纳入 |
| O-5 | 时钟表，实时显示当前的时间日历等 | S | R-3 | 纳入 |
| O-6 | 今日任务 | M | R-4 | 纳入 |
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
- **关键约束**：必须捕获应用外编辑（VSCode / Typora）的写作活动，外部编辑器保存一次 = 恰好一条事件。

#### R-2 快捷图表与快捷功能面板 【S】
- **描述**：主页提供常用图表 + 一键操作按钮。
- **验收要点**：
  -至少 3 类图表（完成率趋势、状态分布、优先级分布）
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

#### R-6 Markdown 渲染 【S】
- **验收要点**：
  - 支持 GFM 规范
  - 代码块高亮（至少 50 种语言）
  - 数学公式（LaTeX，可选扩展）
  - 渲染性能：1000 行文档 < 500ms
  - 支持复制为 Markdown源码 / 富文本

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
  -文档根目录可在设置中自定义（如 `~/Documents/MyTaskVault/`）
  - 文件夹的 CRUD 与 UI 完全同步
  - 应用内编辑后自动写回磁盘（debounce 500ms）
  - 磁盘文件被外部修改后 UI 自动检测并提示重载
  - 支持 `.md` 文件的导入（拖入文件夹即出现在笔记列表）
  - 文件名/文件夹名不与应用层 ID 耦合

#### R-12 Markdown 文档导出 PDF 【S】
- **验收要点**：
  - 一键导出按钮位于编辑器工具栏
  - PDF 正确渲染 Markdown、Mermaid、代码高亮、图片
  - 自定义页眉页脚（标题、日期、作者）
  - A4 / Letter 切换
  - 选择导出范围（整篇 / 选中部分）
  - 默认存放用户指定目录，可重命名

---

## 2. 用户已锁定的 4 项关键决策

| # | 决策项 | 决策内容 | 违反后果 |
|---|---|---|---|
| **D-1** | 热力图数据源 | **任务完成数 + 笔记写作活动**（字数/编辑次数混合）| 缺一项则热力图漏掉一半生产活动，是用户首要不满来源 |
| **D-2** | 本地文档存储 | **文件夹 + 纯 .md 文件**（Obsidian 风格）| 数据库内嵌存储直接违反；外部工具（VSCode/Typora）必须能直接打开 |
| **D-3** | PlantUML | **不支持**，研究/实现/依赖引入均禁止 | 引入即视为违反用户决策，需立即回滚 |
| **D-4** | Markdown 编辑器模式 | **纯 WYSIWYG**（Notion/飞书文档风格），不做分屏预览 | 分屏预览模式直接违反；必须所见即所得 |

**约束传导规则**：以上 4 项决策具有最高优先级，与之冲突的任何研究结论、用户后续口述、第三方推荐一律以决策为准。

---

## 3. 用户未提但建议的需求（盲点）

> 来源：`gaps` 报告 A/B/C 三类分组。所有 A 类建议纳入 v1；B 类按优先级讨论；C 类仅作远期储备。

### A 类 — 强烈建议纳入 v1

| 编号 | 需求 | 场景 | 建议 |
|---|---|---|---|
| **A1** | Wiki 双向链接 `[[笔记名]]` + 反向链接面板 | 笔记互相引用、构建知识网络 | **做**。没有双链 = "Obsidian 风格"仅停留在存储层 |
| **A2** | 外部编辑器与应用并发编辑的冲突解决 | VSCode 改稿 vs 应用内编辑 | **做**。三态机 + 静默窗口 + contentHash；丢稿 =弃用 |
| **A3** | 任务 ↔ 笔记双向链接 | 任务引用笔记、笔记内嵌任务 checkbox | **做**。`[[note:path]]` + `[[task:uuid]]` 语法 |
| **A4** | Daily Note 自动创建 | 每天自动生成 `daily/YYYY-MM-DD.md` | **做**。模板可设置，默认含日期/任务占位符 |
| **A5** | 版本历史/快照 | 误删、覆盖、查看历史 | **做**。`.taskpilot/history/<id>/<ts>.md.gz`，最近 50 个 + 30 天 |
| **A6** | 任务提醒与系统通知 | 截止时间提前15 分钟 Toast | **做**。Electron Notification + 系统托盘 |
| **A7** | 重复任务 / 周期性任务 | 每周站会、每月月报 | **做**。RRULE（RFC 5545） |
| **A8** | 任务层级 / 子任务（两级） | 主任务拆解为子任务 | **做但简化**。仅两级（主+子），不再下分 |
| **A9** | 自动保存 + 崩溃恢复 | 断电/崩溃后内容不丢 | **做**。debounce 写盘 + IndexedDB 草稿栈 + SQLite WAL |
| **A10** | 图片/附件管理（不仅粘贴插入）| 库目录图片检索、清理、跨设备同步 | **做**。`assets/images/YYYY-MM/<hash>.<ext>` + SHA-256 去重 |
| **A11** | 数据导入向导 | 从 Obsidian / Notion / 通用文件夹迁移 | **做**。P0 通用文件夹；P1 Obsidian Vault；P2 Notion .zip |
| **A12** | 暗色模式 + 跨模块联动 | 夜间使用 | **做**。三档（亮/暗/跟随系统）；图表、Mermaid、代码块、PDF 全联动 |
| **A13** | 标签组合筛选（AND/OR/NOT）| "工作 AND 重要 NOT 已完成" | **做但简化**。三种组合 + 嵌套标签 `#项目/前端` |
| **A14** | Quick Capture 全局快捷键 | `Ctrl+Shift+T` 弹窗即建 | **做**。chrono-node 解析自然语言时间 |
| **A15** | 数据备份策略 | 一键 zip导出 | **做但简化**。本地增量备份 7 天，不做云备份 |
| **A16** | 模板系统（日报/周报/会议/技术方案）| 重复写作场景 | **做**。内置 5模板 + `templates/` 用户自建 |

### B 类 — 值得讨论（v1+/P1）

| 编号 | 需求 | 建议 |
|---|---|---|
| B1 | 番茄钟 / 专注计时 | P2；若近期路线图无则 Quick Action 不放灰按钮 |
| B2 | 看板视图（Kanban）| P1，与今日视图共存 |
| B3 | 全日历视图 | P1.5；先做 mini 月历 +今日 |
| B4 | 任务依赖关系 | 先做"前置任务列表"，依赖图 P2 |
| B5 | Web Clipper 浏览器剪藏 | P2；MVP 通过复制粘贴临时方案 |
| B6 | 数学公式（KaTeX）| P1；包体 +300KB |
| B7 | 任务评论/讨论 | 延后；单用户场景价值有限 |
| B8 | 多端同步方案 | **不做应用层同步**；提供 `.gitignore` 模板 |
| B9 | 多库支持 | P1；最多 3 库 |
| B10 | 快捷键自定义 | P1；先默认键全 |
| B11 | 国际化 i18n | 延后；MVP 全中文 |
| B12 | 导出 HTML / DOCX | 做 HTML（零成本），DOCX 可选 |
| B13 | 时间块（Time Blocking）| P2，依赖全日历 |
| B14 | 代码片段库（Snippets）| 延后；先靠模板系统覆盖 |
| B15 | 任务关联附件 | 简化；走附件管线 |
| B16 | 任务完成证据链 | 简化；可选 markdown 说明 |

### C 类 — 远期（V2+储备）

C1 本地 LLM 集成 · C2 协同编辑（CRDT/Yjs）· C3 库目录加密 Vault · C4 移动端 APP · C5 习惯打卡 · C6 知识图谱可视化 · C7 插件系统 · C8 语音输入 · C9 OCR · C10 优先级矩阵 · C11 OKR 管理 · C12 AI 标签建议 · C13 向量语义搜索。

> **关键判断**（来自 gaps 报告）：A1+A3+A4 是"Obsidian 风格 + 任务 + 笔记"的事实标准，缺一不可；A2+A5+A9 是数据安全三件套，缺一即可能丢稿；A6+A7+A8 是任务模块从 MVP 升级到"可用"的临界点。

---

## 4. 模块清单（按新结构组织）

```
┌─────────────────────────────────────────────────────┐
│ A. 任务管理（v1 保留） │ F. Obsidian 风格笔记库（新增）│
│ B. AI 编排（v1 保留） │ G. 文档导出（新增）       │
│ C. 定时调度（v1 保留） │ H. 跨模块（新增）          │
│ D. Dashboard / 仪表盘（新增） │ │
│ E. WYSIWYG 编辑器 + 渲染（新增） │                   │
└─────────────────────────────────────────────────────┘
```

| 模块 | 包含内容 | 优先级 |
|---|---|---|
| **A. 任务管理** | CRUD、四象限、子任务、重复、依赖、提醒 | M |
| **B. AI 编排** | 本地 LLM 调度、Agent 编排、上下文 | M |
| **C. 定时调度** | Cron / Reminder / Pomodoro 触发 | S |
| **D. Dashboard** | 时钟、Today、Heatmap、Charts、Quick Actions | S |
| **E. WYSIWYG 编辑器** | TipTap、Mermaid、代码高亮、数学 | M |
| **F. 笔记库** | chokidar、冲突解决、标签/双链、FTS5 | M |
| **G. 文档导出** | printToPDF、批量合并、ZIP | S |
| **H. 跨模块** | 一致性、安全、性能、主题、快捷键、附件、库目录 | M |

---

## 5. 各模块详细需求

### D. Dashboard / 仪表盘

#### D-1 实时时钟与日历（R-3）
- **功能**：顶栏常驻"下午好 · 周日 8月30日 15:42"；独立 mini 月历部件（6×7 网格，有截止任务的日期打圆点）。
- **验收**：分钟刷新；单 `useNow(60_000)` hook 全应用共享；绑定 `powerMonitor.on('resume')` 与 `visibilitychange` 强制对时；首次 timeout 对齐到整分边界。
- **风险**：后台 setInterval 被 Chromium 节流到 ≥1 分钟，休眠唤醒会漂移。

#### D-2 今日任务面板（R-4）
- **功能**：Dashboard摘要卡片（前 5 条 + "查看全部 (12)"）+ 独立 `/today` 路由作为**应用启动默认落地页**。
- **验收**：Dashboard 摘要卡 checkbox 可直接勾完成 → 即时反馈到热力图；逾期任务优先占位 + 红色标记。
- **数据**：从 `tasks` 表 WHERE due_date = today OR status = overdue ORDER BY priority DESC, due_date ASC。

#### D-3 贡献热力图（R-1）
- **数据采集**：
  ```sql
  -- 双表：原始事件 + 日聚合（物化）
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY, ts INTEGER, local_date TEXT,
    kind TEXT, -- task_completed | note_created | note_edited
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
- **视觉**：5 级离散色阶（OKLCH 单色相 hue 250），分位数分级（p25/p50/p75/p90）；11×11px 圆角 2px，gap 3px；深色模式 level 0 略亮于背景。
- **交互**：hover 用 `@floating-ui/react` 显示明细；click 打开右侧 Sheet 当日详情；`role="grid"` + 方向键导航；不显示秒表动画；`prefers-reduced-motion` 禁用 hover 缩放。
- **外部编辑器兼容**：主进程 `chokidar` 监听 vault，**rename 合并**（原子保存 unlink+add）防重复计数；10 分钟会话合并同 entity_id 编辑事件；`content_hash` 去重。
- **依赖**：chokidar（主进程）、`@floating-ui/react`、自建 SVG 组件（约 150 行）。

#### D-4 快捷图表（R-2）
- **首屏规则**：Dashboard 最多 6 个部件，其中最多 3 个是图表。
- **必含图表**：

 | 图表 | 形式 | 理由 |
  |---|---|---|
  | 完成率（今日/本周/本月）| P0 KPI 磁贴 + sparkline + 同环比 |数字磁贴信息密度最高 |
  | 项目/标签分布 | P1 横向条形 Top7 + 其他 | 标签可精确比较 |
  | 时间投入趋势 | P1 堆叠柱状（按周，按项目着色）| ≥7 天工时数据才显示 |
  | 优先级分布 | P2 4 个 P0-P3 chip |数字而非占比 |
  | 笔记字数/篇数趋势 | P1 面积图按周累计 | 写作量累积型适合 fill |
  | 逾期与阻塞 | **非图表，但最高优先级**| "3 逾期 · 2 被阻塞" |

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
  | 开始番茄钟 | 图标按钮（运行中变倒计时）| `P` |
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
  CodeBlockLowlight, Markdown, MermaidBlock(自定义), Mathematics(可选)
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
- **风险**：mermaid v10/v11 之间有破坏性变更（securityLevel 默认值），必须锁定版本。

#### E-3 代码块高亮
- **MVP**：lowlight + highlight.js，异步加载语言，10000 行 <100ms。
- **进阶**：主进程 Shiki 预渲染（renderer 端不引入 shiki），包体更小效果更好。
- **推荐语言集**：js, ts, python, java, go, rust, css, html, json, bash, sql, markdown（~200KB 总）。

#### E-4 数学公式（可选）
- **KaTeX**（~300KB）优于 MathJax（~1MB+）：速度快 10x+，LaTeX 95%+ 常用语法。
- **实现**：自定义 `math` 节点 + KaTeX renderToString；序列化识别 `$...$` 和 `$$...$$`。

#### E-5 Markdown 序列化- **库**：tiptap-markdown（社区版 `aguingand/tiptap-markdown`）比官方方案成熟。
- **Round-trip 完整性**（关键）：
  - 表格合并单元格、taskItem 勾选状态、数学公式、Mermaid 块、图片 alt/title全部需自定义 serializer/deserializer
  -保留 token：HTML 注释 `<!-- tiptap-meta: {...} -->` 存元数据
  - 快照测试：每个文档做 `parse(serialize(parse(md))) === parse(md)` 断言

#### E-6 图片/附件处理
- **流程**：拖拽/粘贴/选择 → IPC 主进程 → SHA-256 去重 → Sharp 压缩（>2MB 自动1920px / jpeg 85）→ 写入 `<library>/assets/<hash>.<ext>` → 返回相对路径。
- **关键技术**：
  - **Sharp**（~30MB 含 native binary）需 `electron-rebuild`；备选 jimp（纯 JS慢 5-10x）
  - 相对路径 `path.relative()` / `path.resolve()` 在主进程处理
  - 多附件支持：PDF/zip/视频，统一归类 `assets/`

### F. Obsidian 风格笔记库

#### F-1 目录结构
```
<library_root>/
├── notes/ # 普通笔记
│   ├── 项目A/
│   └── 随笔/
├── daily/                           # 日记
├── assets/
│   ├── images/
│   └── files/
└── .taskpilot/                      # 应用私有元数据（隐藏）
    ├── meta.sqlite                  # 标签/字数/反链/任务引用
    ├── history/                     # 版本快照
    └── cache/                       # FTS5 索引
```

#### F-2 元数据双轨制
| 类型 | 位置 | 写入者 |
|---|---|---|
| YAML front matter（标题、别名、tags）| `.md` 文件顶部 | 用户 |
| 应用私有元数据（字数、task_links、内部 id）| `meta.sqlite` | 应用 |
| 索引（FTS5、反链）| SQLite | 应用 |

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
- 嵌套标签：`#项目/前端` 用 `/` 表示层级（Obsidian 兼容）
- 组合过滤：`tag:工作 AND tag:重要` → SQL 拼接

#### F-5 双链 / Wiki 链接 `[[笔记名]]`
- 自定义 ProseMirror 节点 `wikiLink`，渲染为可点击 chip
- 解析扫描 `[[...]]` 和 `[[...|alias]]`，建边入 `links` 表
- **自动补全**：`[[` 触发下拉
- **未创建链接（孤儿）**：灰色显示，点击弹"新建"对话框
- **反向链接**：每篇笔记底部面板#### F-6 任务 ↔ 笔记双向链接（A3）
- 任务 → 笔记：`task.linked_note_ids: TEXT[]`
- 笔记 → 任务：`[[task:uuid]]` 语法 + checkbox 节点交互
- 笔记内嵌任务：`note_tasks` 表（note_id, task_id, checkbox_pos）

#### F-7 Daily Note 自动创建（A4）
- 设置中配置模板路径
- 首次打开某日日记时若不存在，按模板创建- 模板变量：`{{date}}`、`{{weekday}}`、`{{today_tasks}}`

#### F-8 搜索（FTS5 + MiniSearch）
```
SearchService.search(query, filters)
  ├─ 标题模糊: MiniSearch（内存索引，启动构建）
  ├─ 内容全文: SQLite FTS5 MATCH (BM25)
  ├─ 标签过滤: SQL JOIN  └─ 文件名: LIKE 兜底
```
- 启动构建 1000 篇 < 500ms
- 运行时增量：watcher 触发 `reindex(noteId)`，单篇 < 50ms
- 搜索 UI 防抖 150ms
- 单篇 > 100KB 不入 FTS5（仅入标题）

#### F-9 版本历史（A5）
- 快照存 `.taskpilot/history/<noteId>/<timestamp>.md.gz`
- 保留：最近 50 个 + 30 天
- 差异对比：`diff-match-patch` 可视化
- "还原到此版本"= 创建新版本而非覆盖（保留追溯链）
- 触发：自动（1.5s 防抖后）+ 手动 Ctrl+S + 外部变更前

#### F-10 导入向导（A11）
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
                                            ├─ 等<img> onload
                                            ├─ 等 mermaid svg[data-rendered=true]
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
```

#### G-4 导出选项
- 范围：单篇 / 多篇 / 整本
- 纸张：A4 / A5 / Letter / Legal
- 字号：9/10/10.5/11/12/14/16pt
- 配色：当前主题 / 浅色 / 深色 / 黑白
- 链接：显示文本+URL / 仅文本
- **不做密码（V1）**：与 printToPDF 兼容性差，留 V2

#### G-5 风险与缓解
- Mermaid 重绘慢：编辑器内已渲染 SVG，序列化时直接带走
- 中文长字符串断行：`overflow-wrap: anywhere` + `line-break: strict`
- 大图超出页面：`max-width: 100%; height: auto`
- 代码块跨页截断：`pre { page-break-inside: auto; white-space: pre-wrap }`
- 隐藏窗口 font 未加载：`document.fonts.ready` 等待 promise 后再 printToPDF
- 大文件 OOM：分批合并（每 30 篇一组 → 中间 PDF → 二次合并）

### H. 跨模块（全局性）

#### H-1 数据一致性
- 单数据源：所有元数据进 SQLite；`.md` 文件是用户视角单一来源
- 应用元数据绝不入 `.md`
- 跨模块事件总线：`activity_log` 同时被热力图、sticker、统计模块读取

#### H-2 安全
- XSS：TipTap 默认安全，自定义 Node 的 `renderHTML`严格转义；外部 HTML 导入用 DOMPurify
- Mermaid：`securityLevel: 'strict'`（v11 默认）
- 附件路径：规范化 + 校验最终路径在 library 根目录内（防 path traversal）
- CSP：`default-src 'self'`、`script-src 'self'`、`style-src 'self' 'unsafe-inline'`（TipTap 需要）
- Electron：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`

#### H-3 性能
| 场景 | 策略 |
|---|---|
| 启动索引 | 扫描 → 比对 SQLite → 增量添加；1000 文件 < 1.5s |
| 文件监听 | 批量防抖 200ms，每批最多 50 个并发 |
| 编辑器加载 | 侧栏虚拟滚动（`react-window`）|
| 大文件 | > 1MB 提示拆分；> 5MB 强制只读 |
| 热力图渲染 | 365 个 `<rect>` + 事件委托 + `React.memo` |
| IPC | TypedArray 零拷贝（`MessageChannelMain`）|

#### H-4 主题 / i18n（A12）
- 三档：亮 / 暗 / 跟随系统
- 联动：热力图色阶（OKLCH）、Mermaid 主题、代码高亮主题、图表色 token、PDF 导出配色
- 优先级：MVP 全中文，i18n 延后

#### H-5 快捷键体系
- 全局：`Ctrl+Shift+T` Quick Capture / `Ctrl+K` 命令面板 / `Ctrl+S` 强制保存
- 编辑器：`Ctrl+B` 加粗 / `Ctrl+I` 斜体 / `/` 块菜单
- 导航：`Ctrl+1~5` 切 Today/Inbox/Project/Notes/Dashboard
- 自定义：P1；MVP 先默认键全

#### H-6 附件管理（A10）
- `assets/images/YYYY-MM/<hash>.<ext>` 自动按月归档
- SHA-256 去重，相同图片只存一份
- 缩略图缓存（lazy 生成）
- 未引用附件清理工具（P1）

#### H-7 库目录管理
- 首次启动：模态框让用户选择库目录（保存到 `appConfig.json`）
- 允许一键切换库
- 库目录被移动/重命名：监听父目录 rename，提示用户重新选择
- 多库支持（B9）：P1，最多 3 库，顶部下拉切换

#### H-8 备份策略（A15）
- 一键导出 zip 备份
- 可选每日本地增量备份（保留 7 天到 `~/Documents/TaskPilot-backups/`）
- 不做云备份（P1）

---

## 6. 技术决策摘要

### 6.1 编辑器选型

| 候选 | WYSIWYG | Mermaid | Markdown 互操作 | 包体 | 推荐 |
|---|---|---|---|---|---|
| **TipTap v2** | ✓成熟 | 自定义 Node | tiptap-markdown 完整 | ~400KB | **主选** |
| BlockNote | ✓ Notion 风 | 需扩展 | 弱 | ~500KB+ | MVP 阶段备选 |
| Lexical | ✓ 性能最佳 | 需 DecoratorNode | 兼容性弱 | ~100KB | 性能优先 |
| milkdown | ✓ | 有插件 | 较强 | ~200KB | 输入触发感不符 WYSIWYG |
| Slate | ✓ | — | — | — | 不推荐 |

### 6.2 图表库

| 库 | 包体 | React 契合 | 推荐 |
|---|---|---|---|
| **Recharts 3.x** | ~100KB | 声明式 | **主选**（柱/线/面/条）|
| ECharts | ~400KB-1MB | 命令式（需包一层）| P2 甘特 lazy import |
| Visx | 零件库 | d3 风格 | 单人不划算 |
| Chart.js | 中 | canvas 无 DOM节点 | 不推荐 |
| **自建 SVG** | 0 | 纯 React | 热力图 + sparkline |

### 6.3 PDF 导出引擎

| 方案 | 包体 | 与 WYSIWYG 一致性 | 推荐 |
|---|---|---|---|
| **`printToPDF()`** | **0** | 完全一致 | **主选** |
| Puppeteer/Playwright | +80-150MB | 同内核略不同 | 非 Electron 备选 |
| md-to-pdf | +100MB | 两条管线不一致 | 不推荐 |
| Typst CLI | +30MB | 完全脱节 | V2 高保真模式 |
| WeasyPrint | +60-120MB Python | 嵌入 Python 是噩梦 | Pass |

### 6.4 搜索

| 引擎 | 用途 | 包体 |
|---|---|---|
| **SQLite FTS5** | 全文 BM25 | 已集成 |
| **MiniSearch** | 标题模糊匹配（内存索引）| ~10KB |

### 6.5 包体影响（renderer 端）

| 依赖 | gzip | 引入策略 |
|---|---|---|
| @tiptap/core + starter-kit + 扩展 | ~400KB | 主包 |
| tiptap-markdown | ~20KB | 主包 |
| lowlight + highlight.js 核心 | ~50KB | 主包 |
| highlight.js 异步语言包 | 每语言 5-20KB | dynamic import |
| **mermaid** | **500KB-1MB** | **必须 dynamic import** |
| katex | ~300KB | 主包（数学重功能）|
| DOMPurify | ~20KB | 主包 |
| recharts | ~100KB | 主包 |
| @floating-ui/react | ~10KB | 主包 |
| chokidar | 主进程 | 不计入 renderer |
| sharp | ~30MB native | 主进程 |

**首屏主包目标**：< 600KB gzip  
**全功能加载**：~1.5MB gzip（可接受）

### 6.6 文件监控

| 库 | 用途 |
|---|---|
| **chokidar** | 跨平台文件监听，Electron 友好 |

---

## 7. 风险清单与对策

### P0 — 严重（数据丢失 / 不可逆）

| 风险 | 对策 |
|---|---|
| **R-1笔记编辑事件重复与漏计** | content_hash 去重 + 10 分钟会话合并 + rename 路径合并三层防护；单元测试覆盖"外部工具保存一次 = 恰好一条事件" |
| **R-1 混合评分无封顶爆色阶** | `min()` 三处封顶（notes_edited≤5、chars/250≤8）|
| **R-11 应用/外部同时编辑丢稿** | 三态机 + 静默窗口 + contentHash；应用胜强制快照到 history/ |
| **R-11磁盘崩溃 / 误删** | 版本历史 + 一键 zip 备份 |
| **R-9 编辑中应用崩溃** | debounce 写盘（tmp+rename 原子）+ IndexedDB 草稿栈 + SQLite WAL |
| **R-5 mermaid v10/v11 破坏性变更** | 锁定版本；升级前跑 round-trip 测试 |

### P1 — 高（功能/性能退化）

| 风险 | 对策 |
|---|---|
| **R-3 时钟休眠唤醒后停摆** | 绑定 `powerMonitor.resume` + `visibilitychange` 强制对时；首次 timeout 对齐整分边界 |
| **R-5 WYSIWYG 序列化信息丢失**（表格合并、taskItem 勾选状态、数学、Mermaid）| 自定义 serializer/deserializer；HTML 注释保留 token；快照测试 |
| **R-5 mermaid 包体过大** | dynamic import + 编辑器初始化不引入 |
| **R-7 mermaid 多实例渲染冲突** | 每 NodeView 唯一 ID `mermaid-${nanoid()}` |
| **R-11 FTS5 中文分词不友好** | `tokenize='trigram'` 或 jieba 注入；MVP 可先 LIKE 兜底 |
| **R-11 附件路径跨平台同步破裂** | 统一正斜杠存储；读取时 `path.normalize()` |
| **R-12 PDF mermaid 重绘慢** | 编辑器内已渲染 SVG，序列化时直接带走 |
| **R-12 中文长字符串断行** | `overflow-wrap: anywhere` + `line-break: strict` + `word-break: break-word` |
| **R-12 大文件 OOM** | 分批合并：每 30 篇一组 → 中间 PDF → 二次合并 |
| **E-2 mermaid SVG 注入 XSS** | `securityLevel: 'strict'`（v11 默认）|

### P2 — 中（体验/可用性）

| 风险 | 对策 |
|---|---|
| Dashboard 部件过多变数据墓地 | 首屏 ≤6 个部件，≤3 个图表 |
| 番茄钟灰按钮伤体验 | 近期路线图无则不放占位 |
| 跨平台 sharp native编译失败 | README 标注 `npm rebuild`；备选 jimp |
| 库目录被移动 | 监听父目录 rename；提示重新选择 |
| Git 同步冲突 | 提供 `.gitattributes` 一键生成（`.taskpilot` export-ignore）|
| 色盲 | 单色相顺序色阶（靠明度区分），保证相邻两级 ΔL ≥ 0.08 |
| streak 制造焦虑 | 默认展示但可在设置关闭；不用警示色渲染断掉 streak |
| `prefers-reduced-motion` 用户体验 | 禁用格子 hover 缩放动画 |

---

## 8. 路线图（修订版）

>阶段划分考虑：编辑器 /笔记库 / 仪表盘三者相互依赖，需有序推进。

### P0 — MVP（与 v1 阶段 1 同步）
- `activity_log` + `activity_daily` 表与迁移脚本
- 任务完成埋点；chokidar 监听 vault（rename 合并 + 字数 diff）
- Dashboard 骨架：问候条（含时间）+ 3 个 KPI 磁贴 + 今日摘要卡 + Quick Action 按钮组
- TipTap WYSIWYG 编辑器集成（基础 Markdown）
- 文件树 + 笔记 CRUD + chokidar + SQLite 元数据
- 单库目录选择 + 一键切换
- 自动保存（debounce 500ms）+ Ctrl+S + IndexedDB 草稿栈
- 系统通知（任务到期）

### P0.5 — 编辑器与渲染
- Mermaid 自定义 NodeView（dynamic import + 防抖）
- 代码高亮（lowlight + highlight.js）
- tiptap-markdown 序列化集成
- 图片粘贴/拖拽（主进程 Sharp + SHA-256 去重）
- 自建 SVG 热力图（365 天 + hover tooltip + 5 级分位色阶 + 深色适配）
- 最近活动时间线

### P1 — 笔记库 + 任务增强
- 双链 `[[wiki]]` + 反向链接面板
- FTS5 + MiniSearch 搜索
- Daily Note 自动创建 + 模板系统
- 版本历史（最近 50 + 30 天）
- 重复任务（RRULE）+ 子任务（两级）+ 任务提醒
- 任务 ↔ 笔记双向链接（A3）
- 标签组合筛选（AND/OR/NOT）
- 冲突解决 UI 三态机（保留应用 / 保留外部 / 手动合并）
- PDF 导出（printToPDF + 打印 CSS + 中文断行）
- 数据导入向导（通用文件夹 + Obsidian Vault）
- 暗色模式全模块联动
- Quick Capture 全局快捷键

### P1.5 — Dashboard 完整化
- Recharts 接入（笔记字数趋势 + 时间投入趋势 + 项目分布）
- 逾期与阻塞部件
- 贡献权重设置项 + 统计重建按钮
- mini 月历部件
- streak 统计 + 年份切换
- 当日详情抽屉（点击热力图格子）

### P2 — 体验增强
- 看板视图（Kanban）
- 全日历视图
- 数学公式（KaTeX）
- ZIP 打包批量导出
- 深色主题 PDF 导出
- 多库支持（最多 3 个）
- 快捷键自定义
- 番茄钟（若路线图纳入）
- Typst CLI 高保真导出模式

### P3+ — 远期
- Web Clipper · 时间块 · 代码片段库 · 本地 LLM 集成 · 协同编辑（Yjs）· 库目录加密 Vault · 插件系统

### 新增文件清单（实施路径）

**主进程**：
- `src/main/db/migrations/0002_activity.sql`
- `src/main/db/repository/activity.ts`
- `src/main/notes/VaultWatcher.ts`
- `src/main/stats/AggregationService.ts`
- `src/main/pdf/export.ts`
- `src/main/pdf/print.css.ts`
- `src/main/ipc/export.ts`

**Renderer**：
- `src/renderer/components/dashboard/ContributionHeatmap.tsx`
- `src/renderer/components/dashboard/Sparkline.tsx`
- `src/renderer/components/dashboard/QuickActions.tsx`
- `src/renderer/components/dashboard/TodaySummaryCard.tsx`
- `src/renderer/components/dashboard/MiniCalendar.tsx`
- `src/renderer/extensions/MermaidBlock.tsx`
- `src/renderer/extensions/WikiLink.tsx`
- `src/renderer/hooks/useNow.ts`
- `src/renderer/styles/chart-tokens.css`

---

## 9. 待用户确认的问题清单

### 必须确认（影响架构走向）

1. **【必】** UI 框架：React 还是 Vue？TipTap 都有官方绑定，示例以 React 居多——是否锁定 React 19？
2. **【必】** 数据库：是否锁定 better-sqlite3 + SQLCipher（v1 PLAN已有）？是否启用加密？
3. **【必】** 库目录选择：是否支持启动时模态框让用户选择库路径？还是首次安装时一次性选定？
4. **【必】** 热力图数据回溯：用户切换到本应用后，存量数据（已存在的笔记和任务）是否回填历史活动？还是仅从启用日开始记录？
5. **【必】** Dashboard 启动落地页：选 (a) Dashboard / (b) 今日（Things/TickTick 风格）/ (c) 上次离开时的页面？研究推荐 (b)。
6. **【必】** 任务模块现状：v1 阶段 1 的任务数据结构是否已实现？还是本需求文档需要补全任务模块的字段（priority/due_date/recurring/subject/tags/linked_note_ids/deps）？

### 建议确认（影响细节体验）

7. **【建】** 笔记创建时机：自动文件名 `YYYY-MM-DD-未命名.md`，用户写下第一行 H1 后自动重命名（Obsidian 行为）——是否接受？
8. **【建】** 重复任务规则：是否锁定 RRULE（RFC 5545）？是否需要 cron表达式？
9. **【建】** 子任务层级：是否仅两级（主+子），不再下分？
10. **【建】** 模板系统：是否内置 5 个模板（日报/周报/会议/技术方案/OKR）？
11. **【建】** 标签嵌套：是否支持 `#项目/前端` 风格嵌套？
12. **【建】**番茄钟：是否纳入近期路线图？若否，Quick Action 按钮不放占位。
13. **【建】** 数学公式（KaTeX）：是否 v1 必须？包体 +300KB。
14. **【建】** PDF 密码：V1 不做（与 printToPDF 兼容性差），V2 再加？
15. **【建】** 同步方案：是否集成云盘？还是仅提供 `.gitignore` 模板让用户自行用 Git/Syncthing？
16. **【建】** 多库支持：MVP 单库，P1 多库——是否接受？
17. **【建】** 快捷键自定义：MVP 默认键全，P1 再开放自定义——是否接受？
18. **【建】** i18n：MVP 全中文——是否接受？

### 可选确认（未来扩展）

19. **【选】** 协同编辑（Yjs）：V2+，TipTap 留 API 路径但不引入依赖——是否接受？
20. **【选】**库目录加密 Vault：与"外部工具可读"冲突，单独设计加密模式——是否纳入远期规划？

---

**附：合规性自查**

- ✅ D-1 热力图数据源 = 任务 + 笔记（R-1 + A 类风险已覆盖）
- ✅ D-2 存储 = Obsidian 风格 .md 文件（F 模块全部设计）
- ✅ D-3 PlantUML = 不支持（文档中未出现任何 PlantUML 字样）
- ✅ D-4 编辑器 = 纯 WYSIWYG（TipTap 主选，所有描述统一）
```

文档完成。覆盖14 条原话需求 + 16 条 A 类盲点建议；4 项用户决策全部硬约束在路线图与模块设计中；P0/P1/P2 风险清单分别针对热力图采集、外部编辑冲突、WYSIWYG 序列化三大棘手点给出具体对策。20 条待确认问题按"必/建/选"分级，待用户回复后即可进入实施。