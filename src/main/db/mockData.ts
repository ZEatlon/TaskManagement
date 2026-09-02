/**
 * Mock 数据生成器（开发 / 测试用）
 *
 * 目的：
 *   - 给一个空数据库快速塞入一组「看上去真实」的数据，方便手动测试各种功能
 *   - 涵盖：note folders + notes（含 markdown 各种语法）、sticky notes（含多级步骤）、
 *     pomodoros（过去 30 天的专注记录）、tags
 *   - 幂等：检测到「seed.v1」标记后跳过，避免每次启动都重复塞数据
 *
 * 调用方式：
 *   - 仅在显式启用时执行（设置 MOCK_SEED 环境变量，或首次启动）
 *   - 默认在生产构建里不跑，dev 模式自动跑一次
 *
 * 触发：
 *   - 主进程 index.ts 在 initDatabase 完成后调用 seedMockDataIfNeeded()
 *
 * 数据规模（默认）：
 *   - 4 个文件夹（工作 / 个人 / 学习 / 项目）
 *   - 12 篇笔记（覆盖 markdown / 任务列表 / 代码块 / 表格 / 引用 / mermaid / 多空行）
 *   - 14 条 sticky note（今日 5 条 + 过去 7 天 8 条 + 未来 1 天 1 条）
 *   - 过去 30 天每天 0-8 个番茄钟（模拟真实专注曲线）
 */

import { dbClient } from './client'
import { notesRepo } from './repositories/notes'
import { noteFoldersRepo } from './repositories/noteFolders'
import { stickyNotesRepo } from './repositories/stickyNotes'
import { settingsRepo } from './repositories/settings'
import log from '../log'
import { notesManager } from '../notes/notesManager'
import type { NoteFolder, StickyNoteCreate } from '@shared/types'
import { getCurrentLibrary } from '../lib/libraryManager'

const SEED_FLAG_KEY = 'mock.seed.v1'

/** YYYY-MM-DD 本地日（与渲染端 dayKeyOf 一致） */
function toLocalDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ============================================================
// folders
// ============================================================

async function seedFolders(): Promise<Record<string, NoteFolder>> {
  const existing = await noteFoldersRepo.findAll('order_num ASC')
  const map: Record<string, NoteFolder> = {}
  for (const f of existing) map[f.name] = f

  const want = [
    { name: '工作', color: 'blue' as const, order: 1 },
    { name: '个人', color: 'green' as const, order: 2 },
    { name: '学习', color: 'purple' as const, order: 3 },
    { name: '项目', color: 'orange' as const, order: 4 },
  ]
  for (const w of want) {
    if (map[w.name]) continue
    const f = await noteFoldersRepo.create({ name: w.name, color: w.color, order: w.order })
    if (f) map[w.name] = f
  }
  return map
}

// ============================================================
// notes
// ============================================================

interface SeedNote {
  filename: string
  folder?: keyof typeof FOLDER_KEY  // 引用上面的 folder 名
  tags: string[]
  starred?: boolean
  content: string
}

const FOLDER_KEY = { 工作: 1, 个人: 2, 学习: 3, 项目: 4 } as const

const SEED_NOTES: SeedNote[] = [
  {
    filename: '欢迎使用 TaskPilot.md',
    folder: '个人',
    tags: ['指南'],
    starred: true,
    content: `# 欢迎使用 TaskPilot 🎉

这是一个本地优先的个人任务 + 笔记 + AI 助手桌面应用。

## 核心功能

- **便签时间线** —— 在 \`便签\` 页面管理今日 / 过去 / 未来的任务
- **笔记编辑器** —— TipTap WYSIWYG，支持 Markdown / Mermaid / KaTeX / 表格 / 任务列表 / 图片
- **专注计时** —— 番茄钟自动写入每日专注记录，热力图直观展示
- **AI 助手** —— 选中笔记后可让 AI 总结、续写、翻译、答疑

## 编辑器支持以下语法

**代码块**：

\`\`\`javascript
function hello(name) {
  return \`Hello, \${name}!\`;
}
hello('TaskPilot');
\`\`\`

**任务列表**：

- [x] 已完成的事
- [x] 另一件完成的事
- [ ] 待办：去健身房
- [ ] 待办：阅读《代码之道》第 5 章

**数学公式**（KaTeX）：$E = mc^2$

**表格**：

| 功能        | 状态 | 说明            |
| ----------- | ---- | --------------- |
| 笔记编辑    | ✅   | TipTap WYSIWYG  |
| 便签        | ✅   | 多步骤任务      |
| 番茄钟      | ✅   | 25/5 标准节奏   |
| AI 助手     | ✅   | 多 provider     |

> 💡 提示：试试连续按几次回车创建多个空段落，然后切换到「仅预览」布局——空行应该被完整保留！

---

希望这个工具能帮你把每天的任务管得井井有条。
`,
  },
  {
    filename: '多空行测试.md',
    folder: '个人',
    tags: ['测试', '编辑器'],
    content: `# 多空行测试笔记

本笔记专门测试「多次按回车产生的空行是否会被自动删除」。

第一段内容。




（上面有 4 个连续空行）


最后一段内容结束。
`,
  },
  {
    filename: '本周工作重点.md',
    folder: '工作',
    tags: ['周报', '工作'],
    starred: true,
    content: `# 本周工作重点

## 核心交付

1. 完成 v2.1 版本的回归测试
2. 修复笔记编辑器光标跳动的 bug
3. 完成客户对接会的资料准备

## 进行中

- [x] 需求评审（周一）
- [x] 技术方案（周二）
- [ ] 接口联调（周四）
- [ ] 演示环境部署（周五）

## 风险与跟进

- **风险 A**：第三方 API 限流，已和供应商沟通
- **风险 B**：UI 走查反馈较多，安排在下周二集中修复

> 备注：本周末需要把演示文档最终版发给客户。
`,
  },
  {
    filename: '读书笔记：代码之道.md',
    folder: '学习',
    tags: ['读书', '编程'],
    content: `# 读书笔记：代码之道

## 摘录

> "Programs must be written for people to read, and only incidentally for machines to execute."
> —— Harold Abelson

## 我的理解

可读性的重要性远高于微优化。当代码读起来费力时，再聪明的算法也会变成维护噩梦。

### 三个落地建议

1. **命名即文档** —— 好的变量名能省掉 80% 的注释
2. **小函数 + 单一职责** —— 让每个函数可以被独立测试
3. **代码评审胜过单元测试** —— 人眼能发现机器看不到的边界问题

## 关联阅读

- 《Clean Code》
- 《The Pragmatic Programmer》
- 《Refactoring》
`,
  },
  {
    filename: '番茄钟使用心得.md',
    folder: '学习',
    tags: ['番茄钟', '时间管理'],
    content: `# 番茄钟使用心得

经过一个月每天 6-8 个番茄钟的实践，总结出以下几条：

## 节奏

- **上午（9-12）**：高难度工作优先
- **下午（14-17）**：中等难度 + 沟通
- **傍晚（17-18）**：整理 + 收尾

## 干扰处理

被中断时：
1. 立刻在便签上记一条「刚被打断的任务」
2. 判断是否能在 1 分钟内解决
3. 不能 → 标记当前番茄钟为「跳过」，之后补偿

## 复盘维度

每天结束时花 5 分钟回顾：
- 完成了几个番茄钟？
- 哪些被打断？根因是什么？
- 明天上午要做的第一件事是什么？
`,
  },
  {
    filename: 'Mermaid 示例.md',
    folder: '学习',
    tags: ['mermaid', '图表'],
    content: `# Mermaid 图表示例

下面是一个简单的流程图：

\`\`\`mermaid
graph TD
    A[开始] --> B{任务是否清晰?}
    B -->|是| C[开始番茄钟]
    B -->|否| D[拆解任务]
    D --> B
    C --> E[专注 25 分钟]
    E --> F[休息 5 分钟]
    F --> G{是否继续?}
    G -->|是| B
    G -->|否| H[今日复盘]
\`\`\`

时序图：

\`\`\`mermaid
sequenceDiagram
    participant U as 用户
    participant E as 编辑器
    participant S as 存储
    U->>E: 输入字符
    E->>E: TipTap onUpdate
    E->>S: 防抖 1.5s 后保存
    S-->>E: 写盘成功
    E-->>U: 显示"已保存"
\`\`\`
`,
  },
  {
    filename: '项目 A 需求.md',
    folder: '项目',
    tags: ['项目A', '需求'],
    content: `# 项目 A：客户管理系统

## 背景

为销售团队提供统一的客户档案管理，支持多渠道接入、AI 自动打标签、智能跟进提醒。

## 功能模块

| 模块        | 优先级 | 状态     |
| ----------- | ------ | -------- |
| 客户档案    | P0     | 开发中   |
| 跟进记录    | P0     | 待开发   |
| AI 标签     | P1     | 规划中   |
| 数据看板    | P1     | 规划中   |

## 里程碑

- **M1（9 月底）**：客户档案 CRUD + 列表筛选
- **M2（10 月底）**：跟进记录 + 提醒
- **M3（11 月底）**：AI 标签 v1 + 看板
- **M4（12 月底）**：联调上线

## 技术栈

- 前端：React 18 + TypeScript + Vite
- 后端：Node + Fastify + SQLite
- 桌面壳：Electron
`,
  },
  {
    filename: '今日计划.md',
    folder: '个人',
    tags: ['计划'],
    content: `# 今日计划（${new Date().toLocaleDateString('zh-CN')}）

## 上午

- [ ] 9:00 站会
- [ ] 9:30 项目 A 需求评审
- [ ] 10:30 写需求文档

## 下午

- [ ] 14:00 番茄钟 ×4（深度工作）
- [ ] 16:30 复盘 + 整理便签

## 晚间

- [ ] 跑步 30 分钟
- [ ] 阅读 30 分钟
`,
  },
  {
    filename: '链接收藏.md',
    folder: '个人',
    tags: ['收藏'],
    content: `# 链接收藏

## 技术

- [TipTap 文档](https://tiptap.dev) —— 强大的 WYSIWYG 编辑器框架
- [Electron 官方文档](https://www.electronjs.org) —— 桌面应用开发
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) —— 同步 SQLite 驱动

## 工具

- [Excalidraw](https://excalidraw.com) —— 手绘风格白板
- [Carbon](https://carbon.now.sh) —— 代码片段美图
- [regex101](https://regex101.com) —— 正则测试

## 阅读

- [Hacker News](https://news.ycombinator.com)
- [阮一峰的网络日志](https://www.ruanyifeng.com)
- [少数派](https://sspai.com)
`,
  },
  {
    filename: '空笔记测试.md',
    folder: '个人',
    tags: [],
    content: "# 极简测试\n\n这是一篇用于测试极简内容的笔记。\n",
  },
  {
    filename: '复盘模板.md',
    folder: '个人',
    tags: ['复盘', '模板'],
    content: `# 每日复盘模板

## 今天做了什么

-
-
-

## 哪里可以做得更好

-
-

## 明天的重点

1.
2.
3.

## 番茄钟统计

- 完成：__ 个
- 跳过：__ 个
- 总专注：__ 分钟
`,
  },
  {
    filename: '项目 B 会议纪要.md',
    folder: '项目',
    tags: ['项目B', '会议'],
    starred: true,
    content: `# 项目 B 周会纪要（${new Date().toLocaleDateString('zh-CN')}）

## 与会者

张三、李四、王五、赵六

## 议题

### 1. 上周进度回顾

- 张三：完成了 X 模块开发
- 李四：UI 走查未通过，已返工
- 王五：接口文档已发出，等对方确认

### 2. 本周计划

- 完成 Y 模块联调
- 发布 v0.2 版本
- 准备客户演示

### 3. 风险

> ⚠️ 第三方回调延迟，可能影响上线时间。

## 决议

1. 周三前完成联调
2. 周五发版本
3. 周一召开客户演示预演
`,
  },
]

async function seedNotes(folders: Record<string, NoteFolder>): Promise<void> {
  // 检查是否已有 seed 笔记（通过文件名判断）
  const existing = await notesRepo.findAll({ archived: false, limit: 1000, orderBy: 'mtime DESC' })
  const existingSet = new Set(existing.map((r) => r.filename))
  for (const seed of SEED_NOTES) {
    if (existingSet.has(seed.filename)) continue
    try {
      await notesManager.writeNote({
        filename: seed.filename,
        content: seed.content,
        frontmatter: {
          title: seed.filename.replace(/\.md$/i, ''),
          tags: seed.tags,
          starred: seed.starred ?? false,
          folderId: seed.folder ? (folders[seed.folder]?.id ?? null) : null,
        },
      })
    } catch (err) {
      log.warn(`[mock] seed note failed: ${seed.filename}`, err)
    }
  }
}

// ============================================================
// sticky notes
// ============================================================

function makeStickyCreates(): StickyNoteCreate[] {
  const today = new Date()
  const todayKey = toLocalDayKey(today)
  const result: StickyNoteCreate[] = []

  // 今日 5 条
  result.push({
    title: '完成项目 A 需求评审',
    date: todayKey,
    priority: 'p0',
    status: 'in_progress',
    tags: [],
    steps: [
      { content: '准备评审材料', done: true },
      { content: '邀请参会人', done: true },
      { content: '主持会议', done: false },
      { content: '整理会议纪要', done: false },
    ],
    estimatedMinutes: 90,
  })
  result.push({
    title: '番茄钟 ×4（深度工作）',
    date: todayKey,
    priority: 'p0',
    status: 'todo',
    tags: [],
    steps: [
      { content: '25 min - 模块开发', done: false },
      { content: '25 min - 模块开发', done: false },
      { content: '25 min - 写文档', done: false },
      { content: '25 min - Code Review', done: false },
    ],
    estimatedMinutes: 100,
  })
  result.push({
    title: '回复客户邮件',
    date: todayKey,
    priority: 'p1',
    status: 'todo',
    tags: [],
    description: '汇总本周客户反馈，给出统一回复',
    steps: [{ content: '整理邮件列表', done: false }],
    estimatedMinutes: 30,
  })
  result.push({
    title: '晚间跑步 30 分钟',
    date: todayKey,
    priority: 'p3',
    status: 'todo',
    tags: [],
    steps: [],
    starred: true,
  })
  result.push({
    title: '阅读《代码之道》第 5 章',
    date: todayKey,
    priority: 'p3',
    status: 'done',
    tags: [],
    steps: [{ content: '已读完', done: true }],
    estimatedMinutes: 45,
  })

  // 过去 7 天 8 条
  const pastTitles = [
    { title: '客户拜访 - 星河科技', status: 'done' as const, priority: 'p0' as const, completed: true },
    { title: '修复编辑器 BUG', status: 'done' as const, priority: 'p0' as const, completed: true },
    { title: '代码评审', status: 'done' as const, priority: 'p1' as const, completed: true },
    { title: '周会准备', status: 'done' as const, priority: 'p1' as const, completed: true },
    { title: '数据库迁移脚本', status: 'done' as const, priority: 'p0' as const, completed: true },
    { title: '更新 README', status: 'done' as const, priority: 'p3' as const, completed: true },
    { title: '番茄钟 ×6', status: 'done' as const, priority: 'p1' as const, completed: true },
    { title: '整理本周便签', status: 'done' as const, priority: 'p3' as const, completed: true },
  ]
  for (let i = 1; i <= 8; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dk = toLocalDayKey(d)
    const t = pastTitles[i - 1]
    result.push({
      title: t.title,
      date: dk,
      priority: t.priority,
      status: t.status,
      tags: [],
      steps: [{ content: '完成', done: true }],
    })
  }

  // 未来只保留明天 1 条 —— 后天及更远的 mock 数据易让用户在跨日后看到
  // 「过期便签」或时间错位（昨天看是「明天」→ 第二天看变成「昨天」，
  // 过去 bucket 多了内容）。mock 的目的是渲染场景，而不是堆量。
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  result.push({
    title: '明天 - 下周一对一沟通',
    date: toLocalDayKey(tomorrow),
    priority: 'p1',
    status: 'todo',
    tags: [],
    steps: [],
  })
  return result
}

async function seedStickyNotes(): Promise<void> {
  // 用 listFiltered 简单判断是否已有 sticky
  const existing = await stickyNotesRepo.listFiltered({ archived: false, limit: 1 })
  if (existing.length > 0) return

  const creates = makeStickyCreates()
  for (const c of creates) {
    try {
      await stickyNotesRepo.create(c)
    } catch (err) {
      log.warn(`[mock] seed sticky failed: ${c.title}`, err)
    }
  }
}

// ============================================================
// pomodoros（过去 30 天每天 0-8 个番茄钟，用于测试热力图）
// ============================================================

async function seedPomodoros(): Promise<void> {
  // 简单判断：已存在则跳过
  const countStmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: 'SELECT COUNT(*) as c FROM pomodoros',
    })
  ).stmtId
  let existing = 0
  try {
    const row = (await dbClient.call('get', {
      stmtId: countStmtId,
      params: [],
    })) as { c: number } | null
    existing = row?.c ?? 0
  } finally {
    try {
      await dbClient.call('finalize', { stmtId: countStmtId })
    } catch {
      /* ignore */
    }
  }
  if (existing > 0) return

  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `INSERT INTO pomodoros (id, sticky_note_id, started_at, ended_at, duration_min, completed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
    })
  ).stmtId

  try {
    for (let i = 0; i < 30; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      // 模拟真实曲线：平日 3-8 个，周末 0-3 个
      const dow = d.getDay()
      const isWeekend = dow === 0 || dow === 6
      const count = isWeekend ? Math.floor(Math.random() * 3) : 3 + Math.floor(Math.random() * 6)

      for (let j = 0; j < count; j++) {
        const startHour = 9 + j // 9 点开始第一个
        const startedAt = new Date(d)
        startedAt.setHours(startHour, 0, 0, 0)
        const endedAt = new Date(startedAt)
        endedAt.setMinutes(25)
        try {
          await dbClient.call('run', {
            stmtId,
            params: [
              crypto.randomUUID(),
              null,
              startedAt.toISOString(),
              endedAt.toISOString(),
              25,
              1,
              endedAt.toISOString(),
            ],
          })
        } catch {
          // 跳过个别的失败（不影响整体）
        }
      }
      // 即使 count = 0 也要循环结束（避免类型检查报错）
      if (count < 0) break
    }
  } finally {
    try {
      await dbClient.call('finalize', { stmtId })
    } catch {
      // ignore
    }
  }
}

// ============================================================
// entrypoint
// ============================================================

/**
 * 入口：检查 seed 标记，按需写入 mock 数据。
 *
 * - 已有标记 → 跳过（幂等）
 * - 库目录未配置 → 跳过（让用户在设置里选目录后再来）
 * - 显式禁用（process.env.MOCK_SEED === '0'）→ 跳过
 * - 默认 dev 模式自动跑；prod 默认不跑，除非 MOCK_SEED=1 强制开启
 */
export async function seedMockDataIfNeeded(opts?: { force?: boolean }): Promise<void> {
  // 设置为 0 显式禁用
  if (process.env['MOCK_SEED'] === '0' && !opts?.force) {
    log.info('[mock] seed disabled by env MOCK_SEED=0')
    return
  }
  // prod 默认不跑（除非 MOCK_SEED=1 强制）
  let isPackaged = false
  try {
    // dynamic require：避免在测试环境加载 electron
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron')
    isPackaged = !!electron?.app?.isPackaged
  } catch {
    isPackaged = true // 没 electron 时按 prod 处理
  }
  if (isPackaged && process.env['MOCK_SEED'] !== '1' && !opts?.force) {
    log.info('[mock] seed skipped in production build')
    return
  }

  try {
    const flag = await settingsRepo.get<string>(SEED_FLAG_KEY)
    if (flag && !opts?.force) {
      log.info('[mock] seed already applied, skip')
      return
    }
  } catch {
    // settings 表可能为空，正常
  }

  // 检查库目录
  try {
    const lib = await getCurrentLibrary()
    if (!lib) {
      log.info('[mock] no library configured, skip seed')
      return
    }
  } catch {
    return
  }

  log.info('[mock] seeding mock data...')

  try {
    const folders = await seedFolders()
    await seedNotes(folders)
    await seedStickyNotes()
    await seedPomodoros()

    // 写入幂等标记
    try {
      await settingsRepo.set(SEED_FLAG_KEY, new Date().toISOString())
    } catch (err) {
      log.warn('[mock] failed to write seed flag', err)
    }
    log.info('[mock] seed done')
  } catch (err) {
    log.error('[mock] seed failed', err)
  }
}
