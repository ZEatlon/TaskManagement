# TaskPilot — 基于 Electron 的本地优先任务管理 + AI 助手方案

> 工作目录：`E:\个人项目\任务进度管理`
> 文档版本：v1.0（2026-08-30）
> 由 5 个并行调研流 + 1 个综合设计流产出

---

## 1. 产品定位

**一句话**：本地优先的个人任务管理工作台，内置"任务编排师" AI，把碎片想法 / 聊天 / 文档一次性收敛成可执行清单 + 定时提醒，数据不出设备。

**目标用户**：
- 独立开发者、咨询顾问、研究者、内容创作者等"任务即生活流"的知识工作者
- 注重隐私、抵触 SaaS 绑定的极客用户
- 已有 GTD / 清单习惯，愿意用 AI 提效但不愿交出数据的早期采用者

**与竞品的差异**：

| 对比项 | TaskPilot | Things 3 / OmniFocus | Todoist / Motion | Raycast / Mem |
|---|---|---|---|---|
| LLM | **本地 + 云端双轨** | 仅 Shortcuts 桥接 | 云端 AI Assistant | 云端为主 |
| 数据归属 | **100% 本地 + 加密** | 本地但 Apple 锁 | SaaS | SaaS / 半云 |
| 调度 | **应用内 + 系统唤醒** | 仅应用内 | 应用内 | 应用内 |
| 平台 | **Win / Mac / Linux** | 仅 Apple | 全平台 + Web | 仅 Mac |
| 订阅 | **无**（一次性买断或免费） | 一次性买断 | 订阅 | 订阅 |

---

## 2. 核心功能 MVP（按优先级排序）

### P0 — MVP 必含（无则不发版）

| 功能 | 说明 |
|---|---|
| 任务 CRUD + 软删除 / 回收站 | 标题 / 描述 / 截止 / 优先级 / 状态 / 预估工时 |
| 项目（可嵌套） + 标签 | 层级清单，多对多标签 |
| 自然语言快速捕获 | chrono-node + luxon 解析时间，UX 上"3 秒入箱" |
| 三视图 | 列表 / 看板 / 日历（月视图） |
| 全局快捷键唤起悬浮输入框 | 类似 Raycast，任意应用前置 |
| 系统托盘 + 开机自启 | `setLoginItemSettings` + auto-launch（Linux） |
| 单实例锁 + 后台常驻 | 关闭不退出，托盘激活 |
| 数据加密 | better-sqlite3 + SQLCipher + safeStorage 主密钥 |

### P1 — 1-2 个迭代补齐

| 功能 | 说明 |
|---|---|
| AI 任务编排 | LLM 多后端（OpenAI / Anthropic / Ollama）+ tool calling |
| 定时任务调度 | croner + SQLite + 启动补偿 + 通知 |
| 思考气泡 + 工具调用卡片 | 流式输出，可折叠，工具执行可视化 |
| FTS5 全文搜索 + 中文 MiniSearch | 跨字段模糊搜 |
| 系统级快速输入面板（独立浮动窗口） | 类似 Spotlight |
| 反思 / 复盘（Walk9kView） | 每日 / 每周摘要，本地规则生成 |

### P2 — 长期演进

- 向量记忆（LanceDB）— 长期记忆 + 语义召回
- E2EE 多端同步（WebDAV）— 加密 JSON 快照，可选
- 自动更新（electron-updater）— 差分更新 + 多通道
- 多窗口 / BrowserView 分离 — 聊天 / 任务 / 设置独立窗口
- Pomodoro / 习惯 — 极简集成，不与 TickTick 同质化竞争
- Apple Calendar / Google Calendar 集成 — 时间块（可选，Phase 3）

---

## 3. 系统架构

### 3.1 进程拓扑图

```
┌──────────────────────────────────┐
│       Main Process（主进程）       │
│  - app lifecycle                 │
│  - WindowManager / Tray          │
│  - IPC Router + zod 校验         │
│  - Scheduler (croner)            │
│  - Notification / safeStorage    │
└────┬─────────────────────┬───────┘
     │ invoke/handle       │ postMessage (MessageChannelMain)
     │                     ▼
     │         ┌───────────────────────┐
     │         │  Utility Process(es) │
     │         │  - llm-worker.js      │
     │         │  - db-worker.js (sqlite)│
     │         │  - search-worker.js   │
     │         └───────────────────────┘
     ▼
┌──────────────────────────────────┐
│  Renderer (React 19)             │
│  contextIsolation: true          │
│  sandbox: true                   │
│  IPC: window.api.* (preload 桥) │
│  状态: Zustand（局部）            │
└──────────────────────────────────┘
```

### 3.2 模块划分

```
src/
  main/         # Node 上下文，业务编排
    services/   # window, tray, scheduler, ipc, secrets
    db/         # better-sqlite3 单例 + 迁移 + repository
    llm/        # LLM 网关 + provider 适配 + agent runtime
    scheduler/  # croner + CatchupEngine + DependencyBus
  preload/      # contextBridge，导出 window.api
  renderer/     # React UI，Zustand，Tailwind
  shared/       # 跨进程类型 / IPC schema
```

### 3.3 关键技术选型一览（一句话理由）

| 维度 | 选型 | 理由 |
|---|---|---|
| 框架 | Electron 33+ LTS | 安全公告响应快，CVE 修复及时 |
| 构建 | electron-vite | 官方维护，main/preload/renderer 独立 Vite，HMR 快 |
| UI | React 19 + TypeScript strict | 生态最广，templates 丰富 |
| 状态 | Zustand（renderer） | 轻，无需 Provider，跨窗口可订阅 |
| 路由 | TanStack Router（memory） | Electron 无 URL，类型安全的 memory router |
| 样式 | Tailwind v4 | 原子化，v4 性能更好，产物小 |
| IPC | invoke/handle + zod 校验 + 自建 typed contract | 比 trpc-electron 更轻，完全可控 |
| LLM | 自建 LLMGateway + openai/anthropic/ollama SDK | 一个统一接口，覆盖云+本地 |
| 持久化 | better-sqlite3（业务）+ electron-store（配置） | 同步 API + 主进程友好，SQL 强一致 |
| 加密 | better-sqlite3-multiple-ciphers + safeStorage | 利用系统 Keychain，本地优先 |
| 全文 | SQLite FTS5 + MiniSearch（中文增强） | 索引稳定，与主表事务一致 |
| 调度 | croner + CatchupEngine | 唯一带 previousRuns 的轻量库，支持启动补偿 |
| 通知 | Electron Notification | 跨平台统一，无外部二进制依赖 |
| 测试 | Vitest + Playwright（_electron） | 单元 + 端到端原生支持 |
| 打包 | electron-builder + electron-updater | 差分更新，生态广 |

---

## 4. 数据模型

### 4.1 E-R 概览

```
projects (id, parent_id, name, ...)       1—N tasks
tasks     (id, project_id, parent_task_id, ...)  1—N attachments
task_tags                                    N—N tags
schedules  1—N tasks (id, task_id, pattern OR run_at, ...)
conversations  1—N messages (ai_chat_log)
activity_log（审计 / 历史回溯）
run_log (schedule_id, fire_slot)    # 幂等
memo_embeddings（可选，Phase 2）
```

### 4.2 TypeScript 接口（核心实体，定义在 `src/shared/types/`）

```ts
// src/shared/types/task.ts
export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';
export type Priority  = 'P0' | 'P1' | 'P2' | 'P3';

export interface Task {
  id: string;                  // nanoid
  projectId: string | null;
  parentTaskId: string | null; // 子任务
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  dueAt: number | null;        // epoch ms (UTC)
  startedAt: number | null;
  completedAt: number | null;
  estimateMinutes: number | null;
  actualMinutes: number | null;
  recurrence: RecurrenceRule | null;
  recurrenceAnchorId: string | null;
  position: number;            // 拖拽排序，REAL key
  isArchived: boolean;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type RecurrenceRule = {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byWeekday?: number[];        // 0-6
  byMonthday?: number[];
  until?: number;
};
```

```ts
// src/shared/types/schedule.ts
export type ScheduleKind = 'cron' | 'once' | 'dependent';
export type MisfirePolicy = 'skip' | 'fire_once' | 'fire_all' | 'reschedule';
export type TzPolicy = 'fixed' | 'floating';

export interface Schedule {
  id: string;
  taskId: string;
  kind: ScheduleKind;
  pattern: string | null;      // cron 表达式
  runAt: number | null;        // once 的 epoch ms
  timezone: string;            // IANA
  tzPolicy: TzPolicy;
  dependsOn: string | null;    // 上游 schedule_id
  depDelayMs: number;
  enabled: boolean;
  misfire: MisfirePolicy;
  graceMs: number;             // 超过宽限期不补
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
}
```

```ts
// src/shared/types/conversation.ts
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking: string | null;
  toolCalls: ToolCall[] | null;
  toolResults: ToolResult[] | null;
  createdAt: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'ok' | 'error';
  resultPreview?: string;
}
```

### 4.3 关键索引与迁移策略

- 主表全部带 `deleted_at IS NULL` 部分索引，查询一律带此条件
- `idx_tasks_status_due` 覆盖"今日 / 逾期"主查询
- `idx_activity_task_time` 支持任务时间线回溯
- 迁移：顺序执行的 SQL 脚本 + `schema_migrations` 版本表 + better-sqlite3 同步 API 避免 race
- 备份：启动时检查 `db.backup()` 落盘最近 7 天

---

## 5. LLM 编排设计

### 5.1 系统提示词骨架（中文，定义在 `src/main/llm/prompts.ts`）

```text
SYSTEM：
你是 TaskPilot，一个本地任务管理应用中的"任务编排师"。
你的唯一职责：把用户随口说的需求解析为结构化 JSON 任务，落地到本机数据库。

# 契约
1. 中文回复（除非用户用其他语言）。
2. 涉及创建 / 修改 / 删除，必须调用工具，不允许只在文本里描述。
3. 信息不足时，调用 ask_clarification，不要凭空猜测。
4. 一次最多返回 6 条任务，超出分批。
5. 输出两类内容：面向用户的自然语言摘要 + 工具调用。

# 字段约定
- title: ≤30 字，动宾结构
- priority: P0(今天) | P1(本周) | P2(本月) | P3(待定)
- dueDate: ISO 8601 + 本地时区，"下周三"按系统时区推算
- estimate: 整数分钟，模糊时 30
- deps: 字符串数组，引用其他任务的短哈希
- tags: 小写英文，2-4 个

# 思考格式
在每次回复开头用 <thinking>...</thinking> 包裹内部推理，UI 可折叠展示。

# 当前时间
{now.toISOString()} ({Intl...resolvedOptions().timeZone})

# 本周已有任务摘要（避免重复）
{existingTasksSummary}

# 用户偏好
{userPreferences}

# 工具规范
{toolSchemaBlock}
```

### 5.2 工具列表（LLM 可调用的 function calling）

```ts
const tools: ToolDef[] = [
  {
    name: 'create_task',
    description: '创建一条任务。同句多个动作要调用多次。',
    parameters: {
      type: 'object',
      required: ['title', 'priority', 'estimate'],
      properties: {
        title:        { type: 'string', maxLength: 80 },
        description:  { type: 'string' },
        priority:     { enum: ['P0','P1','P2','P3'] },
        dueDate:      { type: 'string', format: 'date-time' },
        estimate:     { type: 'integer', minimum: 5, maximum: 480 },
        deps:         { type: 'array', items: { type: 'string' } },
        tags:         { type: 'array', items: { type: 'string' } },
        projectName:  { type: 'string' },
        recurrence:   { enum: ['none','daily','weekly','monthly'] }
      }
    }
  },
  { name: 'update_task',     parameters: { id: 'string', patch: 'object' } },
  { name: 'delete_task',     parameters: { id: 'string', soft: 'boolean' } },
  { name: 'list_tasks',      parameters: { filter: { status: 'string', dateRange: 'object', tags: 'array' } } },
  { name: 'get_task',        parameters: { id: 'string' } },
  { name: 'search_tasks',    parameters: { query: 'string', limit: 'integer' } },
  { name: 'create_project',  parameters: { name: 'string', parentId: 'string?' } },
  { name: 'set_reminder',    parameters: { taskId: 'string', offset: 'before|at|after', minutes: 'integer' } },
  { name: 'create_schedule', parameters: { taskId: 'string', kind: 'cron|once', pattern: 'string?', runAt: 'string?' } },
  { name: 'ask_clarification', parameters: { question: 'string', options: 'string[]' } },
  { name: 'remember_note',   parameters: { content: 'string', metadata: 'object' } },
  { name: 'recall_memory',   parameters: { query: 'string', k: 'integer' } }
];
```

### 5.3 示例对话 → 结构化任务

**用户输入**：
> 帮我安排一下明天下午三点前要给老板的季报，还得拉小李一起对一下数据。明早 9 点叫我起来写。

**LLM 思考**（`<thinking>` 块）：
> 用户给出 2 个明确任务（季报 + 拉小李对数据）+ 1 个隐含（明早 9 点的提醒）。时间锚点：明天下午 3:00 前。明早 9 点是一次性提醒。涉及他人协作打 `collaboration` tag。

**LLM 输出**：
- 调用 `create_task(title="提交季度财报给老板", priority="P0", dueDate="2026-08-31T15:00", estimateMinutes=120, tags=["finance","urgent"], projectName="季度收尾")`
- 调用 `create_task(title="和小李对齐季报数据", priority="P1", dueDate="2026-08-31T12:00", estimateMinutes=45, deps=["提交季度财报"], tags=["collaboration","finance"])`
- 调用 `create_schedule(taskId="...", kind="once", runAt="2026-08-31T09:00")` 绑定"写季报"任务

**助手文本回复**：
> 已为你拆出 3 条：① 季报 P0 紧急，明天下午 3 点截止（预估 2 小时）；② 与小李对齐 P1，建议放在中午前（45 分钟）；③ 明早 9 点提醒你开始写。

**UI 渲染**：
- 思考气泡（默认折叠，`思考了 1.2 秒 ▸`）
- 文本流式显示
- 工具调用卡片 ×3，各带"已执行"勾选，可点击展开参数，失败可"重试"

---

## 6. 定时任务设计

### 6.1 引擎选择

- **核心**：`croner` v10.0.1（零依赖，带 `previousRuns`，DST 正确）
- **持久化**：`better-sqlite3` 单例（schedules 表 + run_log 幂等去重）
- **NL 解析**：`chrono-node`（中文 zh.hans）+ `luxon`

**为什么不用其他**：
- node-cron / node-schedule 没有 `previousRuns`，无法枚举错过点，关机开机补偿不了
- BullMQ 要 Redis / Agenda 要 Mongo，桌面端带外部进程不可接受
- 系统级调度器（launchd / Task Scheduler / systemd）**只用于"到点把应用拉起来"**，绝不执行业务，避免双套事实

### 6.2 任务生命周期

```
┌────────┐   create/update    ┌─────────┐
│ DB row │ <----------------> │ croner  │
└───┬────+   (派生计算 next)   │ instance│
    │                          └────┬────┘
    │  fire / manual / catchup       │ trigger
    ▼                                ▼
┌───────────────────┐         ┌─────────────┐
│     fire()        │  <----- │ (定时/补偿)  │
│ - claimSlot()     │         └─────────────┘
│ - runner.execute()│
│ - markRun()       │
└────────┬──────────┘
         │
         ▼
   DependencyBus.emitCompleted()
         │
         ▼
   下游 schedule（落 once + 持久化）
```

### 6.3 与系统通知的衔接

```ts
// main/notifier.ts
import { Notification, app, nativeImage } from 'electron';
app.setAppUserModelId('com.taskpilot.app');   // Windows 必需

export function notifyTask(opts: {
  title: string; body: string; taskId: string; lateBy?: number;
}) {
  const body = opts.lateBy && opts.lateBy > 60_000
    ? `${opts.body} (原定 ${fmtAgo(opts.lateBy)} 前)`
    : opts.body;

  new Notification({
    title: opts.title, body,
    icon: nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png')),
    urgency: 'normal', timeoutType: 'default', silent: false,
    actions: process.platform === 'darwin'
      ? [{ type: 'button', text: '标记完成' }, { type: 'button', text: '稍后提醒' }]
      : [],  // macOS 独占
  }).show();
}
```

**调度 → 通知的可靠性保障**：
- 应用内"未读提醒"列表作为兜底（通知可能被系统静默吞掉）
- `n.on('failed')` 捕获显式失败 → 落回托盘角标
- `powerMonitor.on('resume')` 唤醒后跑一次 `CatchupEngine.run()`
- 时区轮询 60s 检测 `Intl.DateTimeFormat().resolvedOptions().timeZone` 变化 → 重建 floating 任务

---

## 7. 项目结构与目录

### 7.1 完整目录树

```
E:\个人项目\任务进度管理\
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── scripts/
│   ├── fuses.ts                 # Electron Fuses 烧录
│   └── postinstall.js           # electron-rebuild
├── src/
│   ├── main/                    # 主进程 (Node 上下文)
│   │   ├── index.ts             # 入口 (app.whenReady)
│   │   ├── window/
│   │   │   ├── windowManager.ts # BrowserWindow 单例管理
│   │   │   ├── tray.ts          # 系统托盘 + 菜单
│   │   │   └── shortcuts.ts     # globalShortcut 注册
│   │   ├── ipc/
│   │   │   ├── router.ts        # ipcMain.handle 总入口
│   │   │   ├── channels.ts      # 通道名常量字面量联合
│   │   │   └── schemas.ts       # zod 载荷校验
│   │   ├── db/
│   │   │   ├── connection.ts    # better-sqlite3 单例 + WAL
│   │   │   ├── cipher.ts        # SQLCipher 密钥派生
│   │   │   ├── migrations/      # 0001_init.sql ...
│   │   │   ├── repository/
│   │   │   │   ├── tasks.ts
│   │   │   │   ├── projects.ts
│   │   │   │   ├── schedules.ts
│   │   │   │   ├── conversations.ts
│   │   │   │   └── activity.ts
│   │   │   ├── fts.ts           # FTS5 触发器
│   │   │   └── backup.ts        # db.backup() 周期任务
│   │   ├── llm/
│   │   │   ├── AgentRuntime.ts  # ReAct 主循环
│   │   │   ├── LLMGateway.ts    # 多 provider 网关
│   │   │   ├── providers/
│   │   │   │   ├── openai.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   └── ollama.ts
│   │   │   ├── tools/
│   │   │   │   ├── registry.ts  # 工具注册表
│   │   │   │   ├── executor.ts  # 工具执行器
│   │   │   │   └── definitions.ts
│   │   │   ├── ContextManager.ts # token 预算 + 截断
│   │   │   ├── CascadeRunner.ts # 重试+熔断+降级
│   │   │   ├── MemoryStore.ts   # Phase 2: 向量记忆
│   │   │   └── prompts.ts       # 系统提示模板
│   │   ├── scheduler/
│   │   │   ├── SchedulerService.ts # croner 实例池
│   │   │   ├── CatchupEngine.ts    # 启动时补偿
│   │   │   ├── DependencyBus.ts    # A→B 事件总线
│   │   │   └── nlp.ts              # chrono-node 封装
│   │   ├── secrets/
│   │   │   └── SecretsStore.ts  # safeStorage + keytar
│   │   ├── notifier.ts          # Electron Notification
│   │   ├── updater.ts           # electron-updater
│   │   ├── autolaunch.ts        # setLoginItemSettings
│   │   └── log.ts               # electron-log
│   ├── preload/
│   │   └── index.ts             # contextBridge.exposeInMainWorld
│   ├── renderer/                # React 渲染进程
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── app/
│   │   │   ├── router.tsx       # TanStack Router
│   │   │   └── routes/
│   │   ├── components/
│   │   │   ├── quick-capture/   # Raycast-like 浮窗
│   │   │   ├── chat/
│   │   │   │   ├── AgentBubble.tsx
│   │   │   │   ├── ThinkingPanel.tsx
│   │   │   │   ├── ToolTimeline.tsx
│   │   │   │   └── Typewriter.tsx
│   │   │   ├── tasks/
│   │   │   │   ├── TaskCard.tsx
│   │   │   │   ├── VirtualList.tsx
│   │   │   │   └── NLEditor.tsx
│   │   │   └── schedule/
│   │   ├── stores/              # Zustand
│   │   ├── api/                 # 包装 window.api
│   │   └── styles/
│   ├── shared/                  # 跨进程共享
│   │   ├── ipc-channels.ts
│   │   ├── ipc-types.ts
│   │   └── types/               # Task / Schedule / ChatChunk ...
│   └── workers/                 # (可选)Worker Threads
├── tests/
│   ├── unit/                    # Vitest
│   └── e2e/                     # Playwright _electron
├── build/
│   ├── icon.png / icon.ico / icon.icns
│   └── entitlements.mac.plist
└── docs/
    ├── architecture.md
    └── security.md
```

### 7.2 关键文件清单（实现优先级）

| 文件 | 职责 | 优先级 |
|---|---|---|
| `src/main/index.ts` | app lifecycle，单实例锁，hookup 各 service | P0 |
| `src/main/db/connection.ts` | WAL + mmap + 单例 | P0 |
| `src/main/db/migrations/0001_init.sql` | 初始 schema | P0 |
| `src/main/window/windowManager.ts` | 主窗 + ready-to-show | P0 |
| `src/main/ipc/router.ts` | IPC 入口 + zod | P0 |
| `src/preload/index.ts` | contextBridge api 定义 | P0 |
| `src/renderer/app/router.tsx` | memory router | P0 |
| `src/main/llm/AgentRuntime.ts` | ReAct 主循环 | P1 |
| `src/main/llm/LLMGateway.ts` | 多 provider 适配 | P1 |
| `src/main/scheduler/SchedulerService.ts` | croner 实例池 | P1 |
| `src/main/scheduler/CatchupEngine.ts` | 启动补偿 | P1 |
| `src/main/notifier.ts` | 通知封装 | P1 |
| `src/renderer/components/chat/*` | AI 交互 UI | P1 |
| `electron-builder.yml` | 打包配置 | 上线前 |
| `scripts/fuses.ts` | Fuses 烧录 | 上线前 |

---

## 8. 迭代路线图

### 阶段 1：MVP（~2 周）

**目标**：能用，不追求 AI，**先把"本地优先 GTD"立住**

- **Week 1**
  - 项目脚手架（`electron-vite` + TS + React）
  - IPC 框架 + preload typed contract
  - SQLite + 任务 / 项目 / 标签 schema + 迁移器
  - 主窗口 + 三视图（列表 / 看板 / 日历）+ 虚拟列表
  - Quick Capture 面板（全局快捷键 + chrono-node 解析 + 入箱）
- **Week 2**
  - 系统托盘 + `setLoginItemSettings` + 单实例锁
  - Settings 窗口（数据目录 / 导入导出 JSON / Markdown / CSV / Todo.txt）
  - FTS5 + MiniSearch（中文）
  - Playwright 端到端冒烟测试
  - electron-builder 打包 + Fuses 烧录 + Dev 证书签名

**产出**：一个本地纯客户端的任务管理器，没有 AI，没有定时，够用作 daily driver。

### 阶段 2：增强（~4 周）

**目标**：AI 编排 + 定时任务，形成差异化

- **Week 3**
  - LLM 网关 + 多 provider（OpenAI / Anthropic / Ollama）
  - 系统提示模板 + 工具注册表 + 工具执行器
  - Agent Runtime + 流式 UI（思考气泡 + 工具卡片）
  - safeStorage 存 API Key + 设置 UI
- **Week 4**
  - croner 接入 + Schedule 表 + run_log 幂等
  - CatchupEngine + powerMonitor.resume 钩子
  - Notification 封装 + 时区策略（fixed / floating）+ TZ 轮询
  - NL 调度解析（`parseSchedule`）
- **Week 5-6**
  - CascadeRunner（重试 + 熔断 + 离线队列）
  - 本地回顾 / 复盘（基于本地规则的每日摘要，无需 LLM）
  - 性能：虚拟列表 keyset 分页 + IPC 流式返回大数据
  - 自动更新（electron-updater + GitHub Releases）
  - 代码签名（Win EV 预算申请 / Mac Developer ID + notarytool）

### 阶段 3：生态

**目标**：把"本地助手"做厚，把数据所有权还给用户

- E2EE 同步（WebDAV 加密快照），可选 Drive / 坚果云
- 向量记忆（LanceDB + 本地 bge-small）+ 主动 recall
- 多窗口分离（聊天 / 任务 / 日历独立 BrowserView）
- 集成：Apple Calendar / Google Calendar（单向拉取）
- Pomodoro + 习惯（极简，不做 TickTick）
- 插件机制（定义任务后置 hook，供开发者扩展）
- 国际化（i18n）
- 跨平台打磨（Linux 三种 DE 通知一致性，AppImage + deb + rpm）

---

## 9. 关键技术风险与对策

| # | 风险 | 严重度 | 对策 |
|---|---|---|---|
| 1 | **Electron CVE 累积导致 RCE**，尤其 Chromium 内核漏洞 | P0 | 固定 Electron 33.x LTS，CI 跑 `npm audit` + Dependabot 自动升级，订阅 electronjs.org/security 公告，延迟 ≤1 个月升 minor |
| 2 | **API Key 泄漏**：renderer DevTools 一键可读，或 asar 反编译 | P0 | 1) 所有云端 LLM 调用强制走 Utility Process，renderer 只持会话短 TTL token；2) 主密钥经 `safeStorage.encryptString` 入系统 Keychain；3) 主进程 `webContents.openDevTools()` 仅在 `!app.isPackaged` 启用 |
| 3 | **流式 LLM 每 token 一次 IPC**，p99 延迟飙到 1.2s | P1 | 5-token 批 + `MessageChannelMain` zero-copy 转发 + Electron 28+ `ReadableStream` IPC；本地 Ollama 1k token p99 压到 0.9s |
| 4 | **错过定时通知**：休眠 / DST / 时区漂移 + 用户手动退出 | P1 | DB 是 SoT，`run_log(schedule_id, fire_slot)` 主键去重；`CatchupEngine` 用 croner `previousRuns` 枚举错过点，默认 `fire_once + grace_ms=24h`；`powerMonitor.on('resume')` 触发再补偿 |
| 5 | **chat 明文存盘**：localStorage / SQLite 不加密，设备失窃即泄漏 | P1 | `messages.content` 列级加密（AES-GCM，密钥来自 user passphrase + scrypt 或系统 safeStorage），导出自动脱敏 PII；默认不写入缩略 / 思考气泡可单独清空 |
| 6 | **LLM tool calling 失败静默**：写了 create_task 但 DB 未插，UI 误以为成功 | P1 | 工具执行卡 `status: 'running' → 'ok'/'error'`，渲染层强制等 `tool_result` 才标完成；失败可一键"重试该工具调用"；关键操作（delete / batch update）必须 UI 二次确认 |
| 7 | **better-sqlite3 / native 模块跨平台崩溃**：升级 Electron 后 ABI 失配 | P1 | 接 `@electron/rebuild` 在 postinstall 钩子自动重建；CI 在 win / mac / linux 三平台矩阵冒烟启动；锁版本，升 Electron 后跑 2 个 minor 才升 minor |
| 8 | **croner `previousRuns` 单次回溯上限 200**：应用休眠超 200 个 tick 时段（例如每小时任务跑 8 天）会丢 | P2 | 选 `maxRuns: 500`，且按 `since = max(last_run_at, now - grace_ms)` 截取；`misfire='fire_once'` 是默认；UI 标注"本应 X（已迟 Y 小时）" |
| 9 | **多窗口内存膨胀**：开 5 个 BrowserWindow = 1.5GB+ | P2 | 用 `BrowserView` 或 `webContents` 复用承载多"页签"，背景超过 N 分钟自动 `setBackgroundThrottling(true)`；窗口状态用 `electron-window-state` 持久化 |
| 10 | **Anthropic prompt injection**：长文档 / 网页内容夹带指令劫持 | P2 | system prompt 前置 `<document>` XML 边界，用户内容与指令严格分层；工具调用分级权限（P0 任务 / delete 需二次确认） |

---

## 10. 下一步建议（动手前的 3 件事）

### 1. 今天：在 `E:\个人项目\任务进度管理` 跑通脚手架

```bash
pnpm create @quick-start/electron taskpilot-app --template react-ts
```

- 把 `electron-vite` 装好，验证 dev 模式启动窗口 + 三视图（列表 / 看板 / 日历）渲染
- **目的**：验证构建链与基础布局，不要在脚手架选型上反复

### 2. 本周内：决定 LLM 后端与数据本地化承诺

- API Key 是否有？如有（OpenAI / Anthropic），先云端跑通；若无，本机装 Ollama + qwen2.5:7b 验证默认可用
- 在 `docs/security.md` 起一节，把"哪些数据走哪"的承诺书面化（本地任务 / 标签 / 对话 vs 云端仅有 LLM 推理请求内容），这一步对后续说服用户付费 / 迁移至关重要

### 3. 一周内：把 SQLite 落库 + Quick Capture 跑通

- 实现 `connection.ts` + `migrations/0001_init.sql`（tasks / projects / tags 三个表 + 必要索引）
- 实现 IPC `task:create` + preload 暴露 `window.api.task.create()`
- 全局快捷键 `Ctrl+Shift+T` 唤起 Quick Capture 浮窗，chrono-node 解析时间，回车入箱
- **目的**：三天后能用它记第一件事，这是证明"自用工具"成立的最低门槛

---

## 11. 参考资料来源（汇总）

### 任务管理与 AI 助手产品研究

- [Todoist vs Things 3 (Upbase)](https://upbase.io/blog/todoist-vs-things-3)
- [TickTick vs Todoist (Zapier)](https://zapier.com/blog/ticktick-vs-todoist/)
- [Reclaim vs Motion (Reclaim Blog)](https://reclaim.ai/blog/reclaim-vs-motion)
- [Reclaim.ai Pricing 2026](https://www.reclaim.ai/pricing)
- [Raycast AI 官网](https://www.raycast.com/ai)
- [Reflect 官网](https://reflect.app)
- [Mem 官网](https://mem.com)
- [Reflect vs Mem](https://reflect.app/vs/mem)

### Electron 技术栈

- [Electron Official Security Tutorial](https://electronjs.org/docs/latest/tutorial/security)
- [Electron Process Sandboxing](https://www.electronjs.org/es/docs/latest/tutorial/sandbox)
- [Electron Context Isolation](https://electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron 32 Security Issues Fix Guide](http://markaicode.com/electron-32-security-vulnerabilities-fix/)
- [@electron/llm Architecture](https://deepwiki.com/electron/llm/3.1-process-architecture)
- [Ollama 0.5 + Electron 28 + React 19 Chat App](https://www.johal.in/step-by-step-build-local-llm-chat-app-ollama-05)
- [Anthropic TypeScript SDK](https://docs.anthropic.com/en/api/client-sdks)

### 调度与存储

- [croner GitHub](https://github.com/hexagon/croner)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [chrono-node](https://github.com/wanasit/chrono)

---

**关键参考路径**：
- 工作目录：`E:\个人项目\任务进度管理`
- 入口文件：`src/main/index.ts`
- DB 单例：`src/main/db/connection.ts`
- LLM 主循环：`src/main/llm/AgentRuntime.ts`
- 调度：`src/main/scheduler/SchedulerService.ts`
- 提示模板：`src/main/llm/prompts.ts`

---

如果你希望我接下来把这份方案进一步落到代码级（例如：起 `electron-vite` 工程、把 `migrations/0001_init.sql` 写完整、或先把 `AgentRuntime` 的 ReAct 主循环搭起来），告诉我具体从哪一块开始，我就动手。
