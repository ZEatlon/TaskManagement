/**
 * 测试用 ESM loader：拦截 notifier.ts 与 pomodoroService.ts 的外部依赖，
 * 返回从 globalThis 读取的内联 stub 模块。让单测不依赖真正的 electron /
 * SQLite worker / audio / sticky repo / settings repo / timerEngine 单例。
 *
 * 用法：node --import ./scripts/test-loader-register.mjs --test <test-file>
 *
 * 拦截规则（基于导入上下文 + 解析后的 URL）：
 *   - bare specifier 'electron' → 内联 stub
 *   - ../db/client（从 sticky-notes / pomodoro 上下文解析）→ 内联 stub
 *   - ../log（同上）→ 内联 stub
 *   - ../ipc/emit（同上）→ 内联 stub
 *   - ../db/withPrepared（从 pomodoro 上下文）→ 内联 stub
 *   - ../db/repositories/stickyNotes（从 pomodoro 上下文）→ 内联 stub
 *   - ../db/repositories/settings（从 pomodoro 上下文）→ 内联 stub
 *   - ./timerEngine（从 pomodoro 上下文）→ 内联 stub
 *   - ./notifications（从 pomodoro 上下文）→ 内联 stub
 *   - ./audio（从 pomodoro 上下文）→ 内联 stub
 *
 * 实现：自定义 URL scheme `testmock://`，resolve 把目标 URL 替换为这个 scheme，
 * load 时按 URL 末尾路径返回不同的 stub 源码。stub 通过 `globalThis.__xxx`
 * 拿测试动态注入的 mock 对象 —— 这样测试可以随时替换 mock 行为。
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')

/**
 * 把目标模块的 file:// URL 重写为 testmock:// URL。
 * - specifier 是 import 字面量（'electron' / '../db/client' / '@shared/...'）
 * - parentURL 是发起 import 的文件的 URL
 *
 * 拦截规则（按调用方上下文分类，避免一个测试上下文污染另一个）：
 *   - bare 'electron' → 全局可用的内联 stub（BrowserWindow / webContents /
 *     ipcMain / Notification 都在这一个 stub 里）
 *   - @shared/* → 走默认 loader（仅做 .ts 类型剥离）
 *   - 来自 src/main/sticky-notes/notifier 或 src/main/pomodoro/ 的 import：
 *     替换 ../db/client / ../log / ../ipc/emit 等
 *   - 来自 src/main/ipc/ai-handlers 的 import：替换 ./channels（handle 收集
 *     器）+ ../ai/{router,stream,tools,prompts,tokenCounter}（避免拖入真
 *     settingsRepo / dbClient / networkSafety 等重依赖）
 *   - 来自 src/main/ai/navigateBridge 的 import：替换 ../ai/tools
 *     （getCurrentCallerWebContentsId 走 globalThis 注入）
 *   - 来自 src/main/ai/tagBridge 的 import：替换 ../db/repositories/{tags,
 *     notes,stickyNotes}（in-memory mock）
 *
 * 实现：自定义 URL scheme `testmock://`，resolve 把目标 URL 替换为这个 scheme，
 * load 时按 URL 末尾路径返回不同的 stub 源码。stub 通过 `globalThis.__xxx`
 * 拿测试动态注入的 mock 对象 —— 这样测试可以随时替换 mock 行为。
 */
function maybeRewrite(specifier, parentURL) {
  // bare 'electron' —— 任何文件里写 import { ... } from 'electron' 都拦
  if (specifier === 'electron') {
    return { url: 'testmock://electron', shortCircuit: true, format: 'module' }
  }

  // TS path alias @shared/* → src/shared/*（与 tsconfig.base.json 一致）。
  // 不加 shortCircuit：默认 loader 在 nextResolve 里负责把 .ts 类型剥离；
  // shortCircuit 会跳过它，导致 `import type { LocaleValue }` 这类语法
  // 直接被当 JS 解析而炸掉。
  if (specifier.startsWith('@shared/')) {
    const abs = path.resolve(PROJECT_ROOT, 'src/shared', specifier.slice('@shared/'.length))
    const withTs = `${abs}.ts`
    return { url: pathToFileURL(withTs).href, format: 'module' }
  }

  const parentPath = typeof parentURL === 'string' ? fileURLToPath(parentURL) : ''
  const parentNorm = parentPath.replace(/\\/g, '/')

  const isFromNotifier = parentNorm.includes('/src/main/sticky-notes/notifier')
  const isFromPomodoro = parentNorm.includes('/src/main/pomodoro/')
  const isFromAiHandlers = parentNorm.includes('/src/main/ipc/ai-handlers')
  const isFromNavigateBridge = parentNorm.includes('/src/main/ai/navigateBridge')
  const isFromTagBridge = parentNorm.includes('/src/main/ai/tagBridge')
  const isFromStatsBridge = parentNorm.includes('/src/main/ai/statsBridge')
  // cachedStmt.ts 自己也 import './client'（= ../db/client），所以当 statsBridge
  // 链路导入 cachedStmt 时，cachedStmt 再 import client 的 parentURL 是
  // cachedStmt.ts —— 它不属于上面任何一个 context。额外打标，让 client stub
  // 在 statsBridge → cachedStmt → client 链上始终生效。
  const isFromCachedStmt = parentNorm.endsWith('/src/main/db/cachedStmt.ts')
  // R-test-suite-notifier-lifecycle (test-coverage)：notifier.ts 从
  // ../db/repositories/settings 导入 settingsRepo，而 settings.ts 自己
  // 会 import '../../log' / '../client' / '../cachedStmt'。当 settings.ts
  // 作为 parent 时（=transitive 导入已发生），它本身不在任何已知 context
  // 里，原早返回会把 client/cachedStmt stub 拦截掉 → 真 client.runInTransaction
  // 等会在测试里启动 → 抛 worker spawn 错误 / 静默走真 SQLite。
  // 新增一个 repository context，让 settings.ts → client/cachedStmt/log
  // 都走 stub（log 本身已无条件兜底；client + cachedStmt 是有条件绑定）。
  const isFromSettingsRepo = parentPath.endsWith(
    `${path.sep}src${path.sep}main${path.sep}db${path.sep}repositories${path.sep}settings.ts`,
  )
  // R-test-suite-bridge-sanitize (test-coverage)：bridge/sanitize.ts 从
  // ../tools/validators import escapeToolText。sanitize.ts 自身 parentURL
  // 不属于已有 context，需要打标让 ../tools/validators 走默认 loader
  // （没有 stub；test-loader 已经有兜底的 `.ts` 扩展名补全）。
  const isFromBridge = parentNorm.includes('/src/main/ai/bridge/')
  // validators.ts / createNote.ts / context.ts 都位于 src/main/ai/tools/ 下。
  // 共享同一个 log 替换规则（避免每个子模块单独列），libraryManager 仅
  // createNote 路径需要，pathSafety 仅 createNote 路径需要。
  const isFromAiTools = parentNorm.includes('/src/main/ai/tools/')
  // R-test-suite-pomodoro-bridge (test-coverage)：pomodoroBridge.ts
  // （src/main/ai/pomodoroBridge.ts）从 ../pomodoro/pomodoroService 导入
  // getState / loadConfig / saveConfig / start / stop / pause / resume，从
  // ../db/repositories/stickyNotes 导入 stickyNotesRepo。新增 context 让
  // 这些依赖在 test:pomodoro-bridge 单测里走 stub（不连真 SQLite / 真
  // sticky_notes repo）。
  const isFromPomodoroBridge = parentNorm.includes('/src/main/ai/pomodoroBridge')
  // R-test-suite-tools-registry (test-coverage)：registry.ts + tools/*.ts
  // 经 createSticky / updateSticky / searchStickies / planDay /
  // batchUpdateStickies / createNote / searchNotes / summarizeNote / 等
  // 工具的 execute() 静态 import 多个 repo。新增 context 让 tools/* 链路
  // 的 ../db/repositories/{tags,notes,stickyNotes} 走 stub。
  // 现有 isFromAiTools 已经覆盖了 src/main/ai/tools/，但只替了
  // libraryManager / pathSafety；repo 这块在 PomodoroBridge / ToolsRegistry
  // 两个新 context 里一并补齐。
  const isFromAiRegistry = parentNorm.endsWith('/src/main/ai/tools/registry.ts')
  // R-test-suite-sticky-handlers (test-coverage)：src/main/ipc/sticky-note-handlers.ts
  // 从 ./channels import handle()，从 ../db/repositories/stickyNotes import
  // stickyNotesRepo（create/update/complete/setStatus/archive 等），从
  // ../pomodoro/pomodoroService import invalidateStickyTitle，从
  // ../notifications/notify import ackPendingDue。新增 context 让这 4 个
  // 依赖在 test-sticky-handlers 单测里走 stub（不连真 SQLite / 真
  // sticky_notes repo / 真 pomodoroService / 真 notify module —— notify
  // 在主进程启动链上会注册 app.on('browser-window-focus') 等副作用）。
  const isFromStickyNoteHandlers = parentNorm.endsWith('/src/main/ipc/sticky-note-handlers.ts')
  // R-test-suite-backfill (test-coverage)：src/main/db/backfill.ts 直接
  // import './client' 和 '../log'。新增 context 把 dbClient 替换为 stub，
  // 让 FIFO responseQueue 控制 settings/sticky_notes/completions/note_events
  // 表的 mock 响应；log 已由无条件兜底覆盖。
  const isFromBackfill = parentNorm.endsWith('/src/main/db/backfill.ts')
  // R-test-suite-with-prepared (test-coverage)：src/main/db/withPrepared.ts
  // 直接 import './client'。新增 context 让 dbClient 走 stub —— 测试
  // 通过 FIFO responseQueue 控制 prepare / finalize 三段响应，并断言
  // executor 与 finally 互相覆盖的 3 条关键路径。
  const isFromWithPrepared = parentNorm.endsWith('/src/main/db/withPrepared.ts')
  // R-test-suite-migrate (test-coverage)：src/main/db/migrate.ts 直接
  // import './client' 和 '../log'。新增 context 让 dbClient 走 stub，
  // 测试用真实 better-sqlite3 文件 DB 验证 ROLLBACK / PRAGMA foreign_keys
  // 恢复 / schema_migrations 写入幂等。
  const isFromMigrate = parentNorm.endsWith('/src/main/db/migrate.ts')
  // R-test-suite-completion-handlers (test-coverage)：src/main/ipc/completion-handlers.ts
  // 从 ./channels import handle()，从 ../db/repositories/completions import
  // completionsRepo + noteEventsRepo，从 ../db/repositories/stickyNotes import
  // stickyNotesRepo.recordCompletion，从 ../db/backfill import runAllBackfills。
  // 新增 context 把这 4 个依赖走 stub（不连真 SQLite / 真 sticky_notes repo /
  // 真 backfill —— 真 backfill 会拉 dbClient.start 触发 worker spawn）。
  const isFromCompletionHandlers = parentNorm.endsWith('/src/main/ipc/completion-handlers.ts')
  // R-test-suite-db-handlers (test-coverage)：src/main/ipc/db-handlers.ts
  // 从 ./channels import handle()，从 ../db/connection import getStatus()，
  // 从 ../db/client import dbClient。新增 context 让这 3 个依赖走 stub。
  const isFromDbHandlers = parentNorm.endsWith('/src/main/ipc/db-handlers.ts')
  // R-test-suite-sticky-store-rollback (test-coverage)：src/renderer/src/stores/*
  // 直接 import '../lib/ipc'（window.api.invoke，在 Node 测试环境不存在）
  // 和 '../components/common/AriaAnnouncer'（JSX + React 在 --experimental-
  // transform-types 下解析不了）。新增 context 把这两个依赖换成内存 stub，
  // 让 stickyNotes store 的 updateStep cascade / CAS rollback / inflight 排序
  // 等逻辑可独立单测。
  const isFromRendererStore = parentNorm.includes('/src/renderer/src/stores/')

  // 注：原版在这里 `return undefined` 拦截未知 parent。Repository 类文件
  // （settings.ts / stickyNotes.ts 等）从 notifier.ts 链路上被 transitive
  // 导入时，它们的 parent URL 是自身（不在已知 context 里），下方的 log /
  // client / cachedStmt stub 都不会触发。但 log stub 本身是无条件兜底
  // （no-op），client / cachedStmt 是有条件绑定。下方单独给
  // isFromSettingsRepo 补 client + cachedStmt stub，让 settings.ts 的
  // transitive import 链也能跑通。
  if (
    !isFromNotifier &&
    !isFromPomodoro &&
    !isFromAiHandlers &&
    !isFromNavigateBridge &&
    !isFromTagBridge &&
    !isFromStatsBridge &&
    !isFromCachedStmt &&
    !isFromAiTools &&
    !isFromPomodoroBridge &&
    !isFromAiRegistry &&
    !isFromBridge &&
    !isFromStickyNoteHandlers &&
    !isFromSettingsRepo &&
    !isFromBackfill &&
    !isFromWithPrepared &&
    !isFromMigrate &&
    !isFromCompletionHandlers &&
    !isFromDbHandlers &&
    !isFromRendererStore
  ) {
    return undefined
  }

  // 把 parentURL 解析成目录，再把 specifier 拼成完整 file URL，最后查 stub 表
  let resolvedAbs
  try {
    const parentDir = path.dirname(parentPath)
    resolvedAbs = path.resolve(parentDir, specifier)
  } catch {
    return undefined
  }

  const rel = path.relative(PROJECT_ROOT, resolvedAbs).replace(/\\/g, '/')

  // ===== log：被很多上下文用到，always-on（只对上面已匹配的 caller 才返回） =====
  if (rel === 'src/main/log') {
    return { url: 'testmock://log', shortCircuit: true, format: 'module' }
  }

  // ===== 共享（notifier + pomodoro + statsBridge + cachedStmt + backfill + withPrepared + migrate 都用） =====
  if (
    isFromNotifier ||
    isFromPomodoro ||
    isFromStatsBridge ||
    isFromCachedStmt ||
    isFromBackfill ||
    isFromWithPrepared ||
    isFromMigrate
  ) {
    if (rel === 'src/main/db/client')
      return { url: 'testmock://db-client', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ipc/emit')
      return { url: 'testmock://emit', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 settingsRepo（notifier.ts 通过 settingsRepo 间接加载） =====
  // settings.ts 自身会 import ../../log（无条件兜底已覆盖）/ ../client /
  // ../cachedStmt。这两个 stub 把 settingsRepo 的「真 client.runInTransaction
  // + 真 cachedStmt.registerStmtCacheInvalidator」拦截掉，统一走 test 的
  // globalThis.__test_dbClient。
  if (isFromSettingsRepo) {
    if (rel === 'src/main/db/client')
      return { url: 'testmock://db-client', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/cachedStmt')
      return { url: 'testmock://cached-stmt', shortCircuit: true, format: 'module' }
  }

  // ===== notifier 链路：拦截 settingsRepo 整模块 =====
  // notifier.ts → '../db/repositories/settings' → 真 settings.ts 会通过
  // cachedStmt 的 prepareCached 消费 dbClientMock.responseQueue，导致现有
  // 单测的 queue 对齐（假设 N 次 dbClient.call）全部错位（多 2~3 次：
  // cachedStmt.prepareCached 一次 prepare + 一次 get）。
  // 修复：直接从 notifier 上下文把 settingsRepo 整模块替成 stub（同 pomodoro
  // 上下文用的 testmock://settings-repo），get 返回 null 走 DEFAULT_SETTINGS。
  if (isFromNotifier) {
    if (rel === 'src/main/db/repositories/settings')
      return { url: 'testmock://settings-repo', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 statsBridge =====
  if (isFromStatsBridge) {
    // 日志共享 stub（已在 isFrom* 通配里覆盖），但显式重声一下：statsBridge
    // 损坏行 warn 走的是它。
    if (rel === 'src/main/db/cachedStmt')
      return { url: 'testmock://cached-stmt', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 pomodoro =====
  if (isFromPomodoro) {
    if (rel === 'src/main/db/withPrepared')
      return { url: 'testmock://db-with-prepared', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/stickyNotes')
      return { url: 'testmock://sticky-notes-repo', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/settings')
      return { url: 'testmock://settings-repo', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/pomodoro/timerEngine')
      return { url: 'testmock://timer-engine', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/pomodoro/notifications')
      return { url: 'testmock://notifications', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/pomodoro/audio')
      return { url: 'testmock://audio', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 pomodoroBridge =====
  // pomodoroBridge 直接从 ../pomodoro/pomodoroService 导入，pomodoroService
  // 自身会拉一堆真依赖（dbClient / settingsRepo / stickyNotesRepo /
  // timerEngine / notifications / audio / withPrepared）。在测试里让
  // pomodoroService 整模块被替成统一 stub：暴露 getState / loadConfig /
  // saveConfig / start / stop / pause / resume 六个函数，全部读 globalThis
  // 上的 in-memory mock 数据。
  if (isFromPomodoroBridge) {
    if (rel === 'src/main/pomodoro/pomodoroService')
      return { url: 'testmock://pomodoro-service', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/stickyNotes')
      return { url: 'testmock://sticky-notes-repo', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 ai/tools/registry.ts =====
  // registry.ts 仅做 ALL_TOOLS 聚合 + executeTool 分发；它自身不 import repo，
  // 但拼出的 sticky.ts / note.ts / tag.ts / pomodoro.ts 工具数组里的 execute
  // 路径会 import。loader 已经在 isFromAiTools 替了 libraryManager / pathSafety，
  // 这里补上三个 repo stub：
  //   - tagsRepo (createSticky 的 tag 自动新建循环 / tag 工具的 findByNameInScope)
  //   - notesRepo (searchNotes / summarizeNote 在 ai/tools 路径上其实走
  //     notesLoader，但 createNote / searchNotes 的 registerPendingCreateNote
  //     不会用 notesRepo；为一致性，工具域共享 tagBridge 已有的 stub)
  //   - stickyNotesRepo (sticky 工具 createSticky / completeSticky /
  //     searchStickies / planDay / batchUpdateStickies 全部依赖)
  // 工具内层 ../pomodoroBridge（pomodoro 工具间接依赖）走 pomodoroService
  // stub 同样需要——把 isFromPomodoroBridge 的判定也扩展到 ai/tools/*。
  if (isFromAiTools) {
    if (rel === 'src/main/db/repositories/tags')
      return { url: 'testmock://tags-repo', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/notes')
      return { url: 'testmock://notes-repo-tb', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/stickyNotes')
      return { url: 'testmock://sticky-notes-repo-tb', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/pomodoro/pomodoroService')
      return { url: 'testmock://pomodoro-service', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ai/notesLoader')
      return { url: 'testmock://notes-loader', shortCircuit: true, format: 'module' }
  }
  if (isFromAiRegistry) {
    if (rel === 'src/main/pomodoro/pomodoroService')
      return { url: 'testmock://pomodoro-service', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/tags')
      return { url: 'testmock://tags-repo', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/notes')
      return { url: 'testmock://notes-repo-tb', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/stickyNotes')
      return { url: 'testmock://sticky-notes-repo-tb', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ai/notesLoader')
      return { url: 'testmock://notes-loader', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 ai-handlers =====
  if (isFromAiHandlers) {
    if (rel === 'src/main/ipc/channels')
      return { url: 'testmock://ipc-channels', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ai/router')
      return { url: 'testmock://ai-router', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ai/stream')
      return { url: 'testmock://ai-stream', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ai/tools')
      return { url: 'testmock://ai-tools', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ai/prompts')
      return { url: 'testmock://ai-prompts', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/ai/tokenCounter')
      return { url: 'testmock://ai-token-counter', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 sticky-note-handlers =====
  // sticky-note-handlers.ts 直接依赖 4 个：
  //   - ./channels            → 复用 ipc-channels stub（handle 把 fn 写到
  //                              globalThis.__test_ipcHandlers）
  //   - ../db/repositories/stickyNotes → 专用 sh stub，覆盖 create/update/
  //                              complete/setStatus/archive/addStep/updateStep/
  //                              removeStep/findById/findByDateRange/listFiltered
  //                              /search/recordCompletion/toggleStarred/remove，
  //                              支持 ackPendingDue 4 路径测所需的可控返回值
  //                              （result 为 null / 缺 completedAt / cross-day /
  //                              idempotent 同天 等）
  //   - ../pomodoro/pomodoroService → 专用 sh stub，只暴露 invalidateStickyTitle
  //                              一个符号（其他导出符号保留为 no-op 占位，
  //                              避免真模块拉 dbClient / settingsRepo）
  //   - ../notifications/notify → 专用 sh stub，只暴露 ackPendingDue（全局
  //                              计数），避免真 notify.ts 在测试启动时注册
  //                              app.on('browser-window-focus') 等副作用
  if (isFromStickyNoteHandlers) {
    if (rel === 'src/main/ipc/channels')
      return { url: 'testmock://ipc-channels', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/stickyNotes')
      return { url: 'testmock://sticky-notes-repo-sh', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/pomodoro/pomodoroService')
      return { url: 'testmock://pomodoro-service-sh', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/notifications/notify')
      return { url: 'testmock://notify-sh', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 completion-handlers =====
  // completion-handlers.ts 直接依赖 4 个：
  //   - ./channels                           → 复用 ipc-channels stub
  //   - ../db/repositories/completions       → 专用 completions-stub：
  //       completionsRepo.record(stickyNoteId, date, count) → 返回
  //       globalThis.__test_completionsRecordReturn（默认 {id, stickyNoteId,
  //       date, count}），并把入参 push 到 __test_completionsRecordCalls
  //       验证 count 已 clamp / stickyNoteId 走 sticky 分支 vs 直接走
  //       completionsRepo.record 的差异；
  //       completionsRepo.dailyCounts / totalInRange 占位返回。
  //       noteEventsRepo.record(noteId, date, type) → 把入参 push 到
  //       __test_noteEventsRecordCalls 数组（type 已落 white-list 后的值）。
  //   - ../db/repositories/stickyNotes       → 专用 ch-sh stub：
  //       stickyNotesRepo.recordCompletion(id, date) 推入
  //       __test_stickyRecordCompletionCalls；其他方法占位避免 ESM 解析
  //       报 undefined export。
  //   - ../db/backfill                       → 专用 backfill-stub：
  //       runAllBackfills(force) 推入 __test_runAllBackfillsCalls，返回
  //       globalThis.__test_runAllBackfillsReturn（默认 {completions:{...},
  //       noteEvents:{...}}）。
  if (isFromCompletionHandlers) {
    if (rel === 'src/main/ipc/channels')
      return { url: 'testmock://ipc-channels', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/completions')
      return { url: 'testmock://completions-repo-ch', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/stickyNotes')
      return { url: 'testmock://sticky-notes-repo-ch', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/backfill')
      return { url: 'testmock://backfill-ch', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 db-handlers =====
  // db-handlers.ts 直接依赖 3 个：
  //   - ./channels         → 复用 ipc-channels stub
  //   - ../db/connection   → 专用 connection-stub：getStatus 返回
  //                          globalThis.__test_dbStatus（默认 mock 对象）。
  //   - ../db/client       → 复用 db-client stub：dbClient 是
  //                          globalThis.__test_dbClient（与 test-backfill
  //                          共用同一 mock 形态，responseQueue 控制 call
  //                          返回值；callLog 断言调用次数 / 入参）。
  if (isFromDbHandlers) {
    if (rel === 'src/main/ipc/channels')
      return { url: 'testmock://ipc-channels', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/connection')
      return { url: 'testmock://db-connection', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/client')
      return { url: 'testmock://db-client', shortCircuit: true, format: 'module' }
  }

  // ===== ai/tools/* 子模块（validators / createNote / context 共用） =====
  if (isFromAiTools) {
    // libraryManager 仅 createNote 路径直接 import；这里统一给所有 ai/tools/*
    // 子模块做替换，避免后续工具再加 import 时漏改。
    if (rel === 'src/main/lib/libraryManager')
      return { url: 'testmock://library-manager', shortCircuit: true, format: 'module' }
    // notes/pathSafety 仅 createNote 路径直接 import；同上冗余替换以避免
    // 真 fs.realpath 在测试环境抛错（macOS 上 /var → /private/var 之类）。
    if (rel === 'src/main/notes/pathSafety')
      return { url: 'testmock://path-safety', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 navigateBridge =====
  if (isFromNavigateBridge) {
    if (rel === 'src/main/ai/tools')
      return { url: 'testmock://ai-tools', shortCircuit: true, format: 'module' }
  }

  // ===== 仅 renderer store =====
  // stickyNotes store / 未来其它 renderer store 都需要这两个 stub：
  //   - ../lib/ipc → stickyNotesApi 走 globalThis.__test_stickyNotesApi
  //     （测试可注入完整的 mocked api，按方法名直接拿响应或 throw）。
  //   - ../components/common/AriaAnnouncer → announce 是 no-op（避免 React
  //     + createPortal 在 Node 环境跑不起来）；调用记录写到 globalThis 让
  //     测试断言副作用。
  if (isFromRendererStore) {
    if (rel === 'src/renderer/src/lib/ipc')
      return { url: 'testmock://renderer-ipc', shortCircuit: true, format: 'module' }
    if (rel === 'src/renderer/src/components/common/AriaAnnouncer')
      return {
        url: 'testmock://aria-announcer',
        shortCircuit: true,
        format: 'module',
      }
  }

  // ===== 仅 tagBridge =====
  if (isFromTagBridge) {
    if (rel === 'src/main/db/repositories/tags')
      return { url: 'testmock://tags-repo', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/notes')
      return { url: 'testmock://notes-repo-tb', shortCircuit: true, format: 'module' }
    if (rel === 'src/main/db/repositories/stickyNotes')
      return { url: 'testmock://sticky-notes-repo-tb', shortCircuit: true, format: 'module' }
  }

  // 兜底：扩展名补全。被测源文件经常写 `import './foo'` / `from './foo'`
  // （无扩展名）。Node 默认 loader 在 --experimental-transform-types 下也不
  // 补 .ts —— 必须在 resolve 阶段显式加上，否则 ESM 解析直接 ERR_MODULE_NOT_FOUND。
  // 只对相对路径生效（`./` / `../`），不动 bare specifier 也不动 @shared。
  // 这里放在 stub 表后面：stub 表命中的优先 shortCircuit；未命中再走默认
  // loader，让它去读真 .ts 文件。
  //
  // 守卫：必须**完全没有扩展名**才补 .ts。原版只挡 .ts/.tsx，结果
  // `./scripts/test-loader-register.mjs`（顶级入口的 .mjs）也被补成
  // `.mjs.ts` 解析失败。改成正则：`specifier` 末尾不能跟 .[a-z]+。
  const hasExt = /\.[a-z]+$/i.test(specifier)
  if (
    !hasExt &&
    (specifier.startsWith('./') || specifier.startsWith('../'))
  ) {
    return {
      url: pathToFileURL(`${resolvedAbs}.ts`).href,
      format: 'module',
    }
  }

  return undefined
}

export async function resolve(specifier, context, nextResolve) {
  const rewritten = maybeRewrite(specifier, context.parentURL)
  if (rewritten) {
    // 对 @shared alias 转换：需要把改写后的 URL 再交给 nextResolve，让默认
    // loader（type-strip）也参与；如果直接 shortCircuit，TS 语法会原样进 JS 解析。
    if (!('shortCircuit' in rewritten && rewritten.shortCircuit)) {
      return nextResolve(rewritten.url, context)
    }
    return rewritten
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  switch (url) {
    case 'testmock://electron':
      return {
        format: 'module',
        source: `
// BrowserWindow.fromWebContents(wc) 返回 globalThis.__test_browserWindowFromWebContents
// （测试可预设成任意对象 / null）；未预设时返回 null（ai:stream 路径仍能
// 跑通 —— handler 不依赖 win）。
const BrowserWindow = {
  getAllWindows: () => [],
  fromWebContents(_wc) {
    return globalThis.__test_browserWindowFromWebContents === undefined
      ? null
      : globalThis.__test_browserWindowFromWebContents;
  },
};
class Notification {
  static isSupported() { return true }
  on() {}
  show() {}
}
// webContents.fromId(id) 返回 globalThis.__test_webContents[id] 上的对象；
// 测试可在调 navigateTo 之前预置 { isDestroyed, send }。
const webContents = {
  fromId(id) {
    const map = (globalThis.__test_webContents ||= {});
    return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
  },
};
// ipcMain.handle(channel, fn) 把 fn 写到 globalThis.__test_ipcHandlers[channel]，
// 让测试可以拿 ai-handlers / navigateBridge 注册的 handler 直接调（合成
// IpcMainInvokeEvent + 参数），验证白名单校验、参数校验、副作用。
//
// 注意：每次写操作都重新读 globalThis.__test_ipcHandlers，不要在模块顶层
// const 缓存——测试 resetAll() 替换了 globalThis 后老引用写丢失。
const ipcMain = {
  handle(channel, fn) {
    const handlers = (globalThis.__test_ipcHandlers ||= {});
    handlers[channel] = fn;
  },
  removeHandler(channel) {
    const handlers = (globalThis.__test_ipcHandlers ||= {});
    delete handlers[channel];
  },
  removeAllListeners() {
    const handlers = (globalThis.__test_ipcHandlers ||= {});
    for (const k of Object.keys(handlers)) delete handlers[k];
  },
};
export { BrowserWindow, Notification, webContents, ipcMain };
export default { BrowserWindow, Notification, webContents, ipcMain };
`,
        shortCircuit: true,
      }
    case 'testmock://db-client':
      return {
        format: 'module',
        source: `
// R-test-suite-migrate / R-test-suite-with-prepared (test-coverage)：
// 多个测试文件需要在运行时动态切换 __test_dbClient（每个测试 new 一份
// mock），原版 export const dbClient = globalThis.__test_dbClient 在模块
// 顶层求值，绑定的是首次 import 时的引用，后续设置无效 → migrate.ts 的
// dbClient.call(...) 报 "Cannot read properties of undefined"。
// 改用 Proxy 转发：每次访问 .call/.runInTransaction 都重新读 globalThis，
// 让测试在 await import 之前先放好 mock，导入后再切换也行。
const _handler = {
  get(_t, prop) {
    const client = globalThis.__test_dbClient;
    if (client == null) return undefined;
    const v = client[prop];
    return typeof v === 'function' ? v.bind(client) : v;
  },
  has(_t, prop) {
    const client = globalThis.__test_dbClient;
    return client != null && prop in client;
  },
};
export const dbClient = new Proxy({}, _handler);
export default { dbClient };
`,
        shortCircuit: true,
      }
    case 'testmock://log':
      return {
        format: 'module',
        source: `
const stub = { info() {}, warn() {}, debug() {}, error() {} };
export default stub;
export const log = stub;
`,
        shortCircuit: true,
      }
    case 'testmock://emit':
      return {
        format: 'module',
        source: `
export function emitToRenderers(channel, payload) {
  const list = (globalThis.__test_emitCalls ||= []);
  list.push({ channel, payload });
}
`,
        shortCircuit: true,
      }
    case 'testmock://pomodoro-service':
      return {
        format: 'module',
        source: `
// R-test-suite-pomodoro-bridge / R-test-suite-tools-registry (test-coverage)：
// pomodoroService 的 in-memory stub。pomodoroBridge.ts 调 getState /
// loadConfig / saveConfig / start / stop / pause / resume 时全部走
// globalThis 上的 __test_pomodoroServiceMock 对象。测试可在 beforeEach
// 里替换，调用方拿到的是同一闭包内的引用（每次调用都重新读 globalThis，
// 不缓存到模块层 const，与其它 stub 保持一致）。
//
// 暴露 ensureConfigLoaded / recordPomodoro / listToday / listRecent /
// validatePomodoroConfigPatch 等符号以满足 pomodoroBridge 直接 import 的
// 公共 API（pomodoroBridge.ts 只 import 上述 7 个函数，其它符号保留为
// 占位 stub 供 ai/tools/pomodoro.ts 等 import 时不报 undefined export）。
const stub = {
  state: globalThis.__test_pomodoroState ?? {
    mode: 'focus',
    remainingSec: 1500,
    totalSec: 1500,
    cycleIndex: 0,
    running: false,
    startedAt: null,
    stickyNoteId: null,
    elapsedSec: 0,
  },
  getState() {
    const s = (globalThis.__test_pomodoroState ?? this.state);
    return typeof s === 'function' ? s() : s;
  },
  loadConfig() {
    const fn = globalThis.__test_pomodoroLoadConfig;
    return typeof fn === 'function' ? fn() : Promise.resolve({ focusMin: 25 });
  },
  saveConfig(patch) {
    const list = (globalThis.__test_pomodoroSaveConfigCalls ||= []);
    list.push(patch);
    const fn = globalThis.__test_pomodoroSaveConfig;
    return typeof fn === 'function' ? fn(patch) : Promise.resolve({ ...(patch ?? {}), focusMin: 25 });
  },
  start(stickyNoteId) {
    const list = (globalThis.__test_pomodoroStartCalls ||= []);
    list.push(stickyNoteId ?? null);
    const fn = globalThis.__test_pomodoroStart;
    return typeof fn === 'function' ? fn(stickyNoteId) : this.getState();
  },
  stop() {
    const list = (globalThis.__test_pomodoroStopCalls ||= []);
    list.push(true);
    const fn = globalThis.__test_pomodoroStop;
    return typeof fn === 'function' ? fn() : this.getState();
  },
  pause() {
    const list = (globalThis.__test_pomodoroPauseCalls ||= []);
    list.push(true);
    const fn = globalThis.__test_pomodoroPause;
    return typeof fn === 'function' ? fn() : this.getState();
  },
  resume() {
    const list = (globalThis.__test_pomodoroResumeCalls ||= []);
    list.push(true);
    const fn = globalThis.__test_pomodoroResume;
    return typeof fn === 'function' ? fn() : this.getState();
  },
  // 占位符号（pomodoroBridge 不会 import，下面给 ai/tools/pomodoro.ts 兜底）
  skip() { return this.getState(); },
  reset() { return this.getState(); },
  getConfig() { return Promise.resolve({ focusMin: 25 }); },
  updateConfig() { return Promise.resolve({ focusMin: 25 }); },
  recordPomodoro() { return Promise.resolve({ id: 'mock-pomodoro-id' }); },
  listToday() { return Promise.resolve([]); },
  listRecent() { return Promise.resolve([]); },
  validatePomodoroConfigPatch(p) { return p ?? {}; },
  invalidateStickyTitle() {},
  startPomodoroService() {},
  stopPomodoroService() {},
};
export const getState = stub.getState.bind(stub);
export const loadConfig = stub.loadConfig.bind(stub);
export const saveConfig = stub.saveConfig.bind(stub);
export const start = stub.start.bind(stub);
export const stop = stub.stop.bind(stub);
export const pause = stub.pause.bind(stub);
export const resume = stub.resume.bind(stub);
export const skip = stub.skip.bind(stub);
export const reset = stub.reset.bind(stub);
export const getConfig = stub.getConfig.bind(stub);
export const updateConfig = stub.updateConfig.bind(stub);
export const recordPomodoro = stub.recordPomodoro.bind(stub);
export const listToday = stub.listToday.bind(stub);
export const listRecent = stub.listRecent.bind(stub);
export const validatePomodoroConfigPatch = stub.validatePomodoroConfigPatch.bind(stub);
export const invalidateStickyTitle = stub.invalidateStickyTitle.bind(stub);
export const startPomodoroService = stub.startPomodoroService.bind(stub);
export const stopPomodoroService = stub.stopPomodoroService.bind(stub);
export default stub;
`,
        shortCircuit: true,
      }
    case 'testmock://db-with-prepared':
      return {
        format: 'module',
        source: `
export async function withPrepared(sql, callback) {
  const stmtId = Math.floor(Math.random() * 1e6);
  try {
    return await callback(stmtId);
  } finally {
    // 不调 finalize（mock；真实场景下 dbClient.call('finalize', ...)）
  }
}
`,
        shortCircuit: true,
      }
    case 'testmock://sticky-notes-repo':
      return {
        format: 'module',
        source: `
export const stickyNotesRepo = {
  async complete(id, opts) {
    const calls = (globalThis.__test_stickyCompleteCalls ||= []);
    calls.push({ id, opts });
  },
  async findById(id) {
    const m = globalThis.__test_stickyFindById;
    if (typeof m === 'function') return m(id);
    return null;
  },
};
export default { stickyNotesRepo };
`,
        shortCircuit: true,
      }
    case 'testmock://settings-repo':
      return {
        format: 'module',
        source: `
export const settingsRepo = {
  async get(key) {
    const m = globalThis.__test_settingsGet;
    if (typeof m === 'function') return m(key);
    return null;
  },
  async set(key, value) {
    const calls = (globalThis.__test_settingsSetCalls ||= []);
    calls.push({ key, value });
  },
};
export default { settingsRepo };
`,
        shortCircuit: true,
      }
    case 'testmock://timer-engine':
      return {
        format: 'module',
        source: `
export const timerEngine = globalThis.__test_timerEngine;
export default { timerEngine };
`,
        shortCircuit: true,
      }
    case 'testmock://notifications':
      return {
        format: 'module',
        source: `
const make = (key) => (...args) => {
  const list = (globalThis.__test_notificationCalls ||= {});
  (list[key] ||= []).push(args);
  return Promise.resolve();
};
export const notifyFocusComplete = make('notifyFocusComplete');
export const notifyBreakComplete = make('notifyBreakComplete');
export const notifyAutoStart = make('notifyAutoStart');
export const emitTick = (...args) => {
  const list = (globalThis.__test_notificationCalls ||= {});
  (list.emitTick ||= []).push(args);
};
export const emitStateChanged = (...args) => {
  const list = (globalThis.__test_notificationCalls ||= {});
  (list.emitStateChanged ||= []).push(args);
};
export const emitStopped = (...args) => {
  const list = (globalThis.__test_notificationCalls ||= {});
  (list.emitStopped ||= []).push(args);
};
export const emitFocusMode = (focusMode, reason) => {
  const list = (globalThis.__test_notificationCalls ||= {});
  (list.emitFocusMode ||= []).push({ focusMode, reason });
};
// R-fix-pomodoro-persist-silent-fail: emitPomodoroPersistFailed 走 IPC 通知
// 渲染端弹 toast；测试桩把它推到 globalThis.__test_notificationCalls.emitPomodoroPersistFailed
// 让测试断言「DB 写失败 → 通知渲染端」是否触发（与 handlePhaseComplete 的
// catch 分支联动）。
export const emitPomodoroPersistFailed = (mode, durationMin, reason) => {
  const list = (globalThis.__test_notificationCalls ||= {});
  (list.emitPomodoroPersistFailed ||= []).push({ mode, durationMin, reason });
};
`,
        shortCircuit: true,
      }
    case 'testmock://audio':
      return {
        format: 'module',
        source: `
// 每次写都重新读 globalThis.__test_audioCalls —— 不要在模块顶层把
// calls 缓存到 const，否则测试 resetAll() 替换了 globalThis 后老 const
// 仍指向旧数组，新 push 全丢；这正是早期 R7P-5 break→focus 测试暴露的
// 隐藏 bug。
export function setWhiteNoise(kind) {
  const list = (globalThis.__test_audioCalls ||= []);
  list.push({ fn: 'setWhiteNoise', kind });
}
export function playCompletionSound(mode) {
  const list = (globalThis.__test_audioCalls ||= []);
  list.push({ fn: 'playCompletionSound', mode });
}
export function disposeAudio() {
  const list = (globalThis.__test_audioCalls ||= []);
  list.push({ fn: 'disposeAudio' });
}
export function currentWhiteNoiseKind() { return 'none'; }
export default { setWhiteNoise, playCompletionSound, disposeAudio, currentWhiteNoiseKind };
`,
        shortCircuit: true,
      }
    case 'testmock://ipc-channels':
      return {
        format: 'module',
        source: `
// ./channels 的 handle/removeHandler/removeAllHandlers —— 走我们自己的
// globalThis 表，不调真 ipcMain（ai-handlers 调用 registerAiHandlers 时
// 真 ipcMain.handle 在测试环境会抛 EEXIST）。
//
// 注意：每次操作都重新读 globalThis.__test_ipcHandlers —— 不要在模块顶层
// 把 handlers 缓存到 const，否则测试 resetAll() 替换了 globalThis 后
// 老的 const 引用还指向旧 Map，新 handler 全写丢了。
export function handle(channel, fn) {
  const handlers = (globalThis.__test_ipcHandlers ||= {});
  handlers[channel] = fn;
}
export function removeHandler(channel) {
  const handlers = (globalThis.__test_ipcHandlers ||= {});
  delete handlers[channel];
}
export function removeAllHandlers() {
  const handlers = (globalThis.__test_ipcHandlers ||= {});
  for (const k of Object.keys(handlers)) delete handlers[k];
}
`,
        shortCircuit: true,
      }
    case 'testmock://ai-router':
      return {
        format: 'module',
        source: `
// ../ai/router 的轻量 stub —— ai-handlers 只是把它 import 进模块作用域，
// 没有调用任何 provider / pickProvider；测试不触发这些 handler，所以不需要
// 真实实现。导出占位 type ProviderId 由 ts 类型层兜底（运行时 import
// 进来的就是普通函数）。
export function listProviders() { return []; }
export function pickProvider() { return { listModels: () => [] }; }
export function testConnection() { return { ok: true }; }
export function isValidProviderId(id) { return typeof id === 'string'; }
export function chat() {}
`,
        shortCircuit: true,
      }
    case 'testmock://ai-stream':
      return {
        format: 'module',
        source: `
// ../ai/stream 的轻量 stub —— 同 ai-router，不在测试路径里执行流式逻辑。
// runStream 是 fire-and-forget；测试通过 globalThis.__test_runStreamCalls
// 拿到 (win, req) 入参快照以验证 stripToolCallFields 后的 messages。
export async function runStream(win, req) {
  const calls = (globalThis.__test_runStreamCalls ||= []);
  calls.push({ win, req });
  return { ok: false, error: 'mocked' };
}
export function abortStream(callId, senderId) {
  const calls = (globalThis.__test_abortStreamCalls ||= []);
  calls.push({ callId, senderId });
  const fn = globalThis.__test_abortStreamReturn;
  return typeof fn === 'function' ? fn(callId, senderId) : true;
}
export function markToolConsumed(toolCallId) {
  const calls = (globalThis.__test_markToolConsumedCalls ||= []);
  calls.push({ toolCallId });
}
export async function confirmToolCall(callId, toolCallId, approved) {
  const calls = (globalThis.__test_confirmToolCallCalls ||= []);
  calls.push({ callId, toolCallId, approved });
  const fn = globalThis.__test_confirmToolCallReturn;
  return typeof fn === 'function' ? fn(callId, toolCallId, approved) : { ok: false, error: 'mocked' };
}
`,
        shortCircuit: true,
      }
    case 'testmock://ai-tools':
      return {
        format: 'module',
        source: `
// ../ai/tools 的 in-memory 桩：把 aiContextByWebContents Map 暴露到
// globalThis 上，让测试在 invoke handler 后直接读 Map 验证副作用。
//
// 同时承载 navigateBridge 需要的 getCurrentCallerWebContentsId ——
// navigateBridge 直接从 ./tools（barrel）import 这一个符号，不会被
// 未匹配的相对路径解析挡住。所以 ai-handlers + navigateBridge 共享
// 这一个 stub URL。
//
// 注意：ctx/calls 都是闭包变量 —— ESM 模块只初始化一次，模块层 const 会
// 持有对老 Map 的引用。测试 resetAll() 替换 globalThis 后老 const 还指向
// 旧 Map，新 write 全丢。所以每次写都重新读 globalThis.__test_aiContextByWebContents。
export function setCurrentStickyId(stickyId, wcId) {
  const calls = (globalThis.__test_aiToolsCalls ||= []);
  const ctx = (globalThis.__test_aiContextByWebContents ||= new Map());
  calls.push({ fn: 'setCurrentStickyId', stickyId, wcId });
  const prev = ctx.get(wcId) ?? {};
  ctx.set(wcId, { ...prev, stickyId: stickyId ?? null });
}
export function clearStickyIdIfMatches(expectedStickyId, wcId) {
  const calls = (globalThis.__test_aiToolsCalls ||= []);
  const ctx = (globalThis.__test_aiContextByWebContents ||= new Map());
  calls.push({ fn: 'clearStickyIdIfMatches', expectedStickyId, wcId });
  const cur = ctx.get(wcId);
  if (!cur) return false;
  if (cur.stickyId !== expectedStickyId) return false;
  ctx.set(wcId, { ...cur, stickyId: null });
  return true;
}
export function setCurrentPomodoroContext(c, wcId) {
  const calls = (globalThis.__test_aiToolsCalls ||= []);
  const ctx = (globalThis.__test_aiContextByWebContents ||= new Map());
  calls.push({ fn: 'setCurrentPomodoroContext', ctx: c, wcId });
  const prev = ctx.get(wcId) ?? {};
  if (c === null) {
    ctx.set(wcId, {
      ...prev,
      pomodoroRunning: null,
      pomodoroMode: null,
      pomodoroStickyNoteId: null,
    });
    return;
  }
  ctx.set(wcId, {
    ...prev,
    pomodoroRunning: c.running,
    pomodoroMode: c.mode,
    pomodoroStickyNoteId: c.stickyNoteId ?? null,
  });
}
export function getAiContextByWebContents(wcId) {
  const ctx = (globalThis.__test_aiContextByWebContents ||= new Map());
  if (wcId === null || wcId === undefined) return {};
  return ctx.get(wcId) ?? {};
}
export function getCurrentOpenNoteByWebContents() { return null; }
export function getCurrentCallerWebContentsId() {
  const id = (globalThis.__test_callerWebContentsId);
  return id === undefined ? null : id;
}
export function setCurrentCallerWebContentsId(id) {
  globalThis.__test_callerWebContentsId = id;
}
export function runWithCallerContext(_store, fn) { return fn(); }

// 其余被 ai-handlers.ts 也 import 但不在我们测试路径里调用的符号 —— 占位
// stub，避免 ESM 解析报 undefined export。
export function createNoteConfirmed() { return { ok: false, error: 'mocked' }; }
export function setCurrentNoteId() {}
export function noteOpenedByWebContents() {}
export function noteClosedByWebContents() {}
export function consumePendingCreateNote() { return { ok: false, error: 'mocked' }; }
export function buildAiContextPrompt() { return ''; }
export function clearWebContentsNoteState() {}
export const VALID_STICKY_STATUSES = ['todo', 'doing', 'done'];
export const VALID_PRIORITIES = ['p1', 'p2', 'p3'];
export function normalizeStatus(s) { return s; }
export function normalizePriority(p) { return p; }
export function parseSafeDate() { return null; }
export function parseSafeDayKey() { return null; }
export function escapeToolText(s) { return String(s ?? ''); }
export const ALL_TOOLS = [];
export function getToolDefinitions() { return []; }
export async function executeTool() { return { ok: false, error: 'mocked' }; }
export function registerPendingCreateNote() {}
export function validatePomodoroConfigPatch(p) { return p; }
export async function saveConfig(c) { return c; }
export function startPomodoroService() {}
export function stopPomodoroService() {}
export function addTag() { return { ok: false }; }
export function applyTagToNote() { return { ok: false }; }
export function applyTagToSticky() { return { ok: false }; }
export function removeTagFromSticky() { return { ok: false }; }
`,
        shortCircuit: true,
      }
    case 'testmock://ai-prompts':
      return {
        format: 'module',
        source: `
export const SYSTEM_PROMPT = 'mocked-system-prompt';
`,
        shortCircuit: true,
      }
    case 'testmock://ai-token-counter':
      return {
        format: 'module',
        source: `
export function estimateMessagesTokens() { return 0; }
export function estimateTokens() { return 0; }
`,
        shortCircuit: true,
      }
    case 'testmock://tags-repo':
      return {
        format: 'module',
        source: `
// ../db/repositories/tags —— tagBridge + createSticky 共用 stub。
// findByNameInScope 返回 globalThis.__test_tagsByName.get(name) ?? null，
// 便于测试预设已注册标签；create 走 globalThis.__test_tagCreateCalls +
// 递增 id 让 createSticky 的「同 scope 复用 vs 自动新建」分支可断言。
// 注意：createSticky 内部 findByNameInScope(name, null) 查 root 作用域后，
// 不存在时调 tagsRepo.create({name, parentId:null, color, order})。create
// 必须返回带 id 的对象，否则 sticky.tags.push(created.id) 抛错。
const repo = {
  async findByNameInScope(name, _parentId) {
    const map = (globalThis.__test_tagsByName ||= new Map());
    return map.get(name) ?? null;
  },
  async update(id, patch) {
    const calls = (globalThis.__test_tagUpdateCalls ||= []);
    calls.push({ id, patch });
    const map = (globalThis.__test_tagsById ||= new Map());
    const existing = map.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    map.set(id, merged);
    return merged;
  },
  // R-fix-missing-sticky-tools + R-listTags-discovery (test-coverage)：
  // getSticky / listStickyTags / listTags 都调 findAllTree()。stub 改为
  // 读 __test_tagsById Map（seedTag 已双向 seed byName + byId），与生产
  // 行为更接近；旧版返 [] 会让 addTag 路径以外的工具永远命中 0 tag，
  // 覆盖不到「tag 命中 / 孤儿 id 过滤」分支。__test_tagsById 缺省时返 []，
  // 保持向后兼容。
  async findAllTree() {
    const map = (globalThis.__test_tagsById ||= new Map());
    return Array.from(map.values());
  },
  async create({ name, parentId, color, order }) {
    const calls = (globalThis.__test_tagCreateCalls ||= []);
    calls.push({ name, parentId: parentId ?? null, color: color ?? null, order: order ?? 0 });
    const id = 'tag-created-' + (calls.length);
    const tag = { id, name, parentId: parentId ?? null, color: color ?? null, order: order ?? 0 };
    const byId = (globalThis.__test_tagsById ||= new Map());
    const byName = (globalThis.__test_tagsByName ||= new Map());
    byId.set(id, tag);
    byName.set(name, tag);
    return tag;
  },
  // R-test-suite-createSticky-rollback (test-coverage)：createSticky 的
  // tag 自动新建循环失败时走 best-effort rollback，需要 tagsRepo.delete(id)
  // 可控：默认走 globalThis.__test_tagDeleteCalls 记录 + 从两个 Map 中
  // 真删；测试可预设 globalThis.__test_tagDeleteError 让 delete 抛错。
  async delete(id) {
    const calls = (globalThis.__test_tagDeleteCalls ||= []);
    calls.push(id);
    const err = globalThis.__test_tagDeleteError;
    if (err) throw err instanceof Error ? err : new Error(String(err));
    const byId = (globalThis.__test_tagsById ||= new Map());
    const byName = (globalThis.__test_tagsByName ||= new Map());
    const t = byId.get(id);
    if (t) {
      byId.delete(id);
      // byName 里同名的另一个 tag 不删（同名重复时按 id 区分）
      // — 同名重复场景 createSticky 不让产生（findByNameInScope 命中即
      // 复用），所以不必区分。
      if (byName.get(t.name)?.id === id) byName.delete(t.name);
    }
    return true;
  },
};
export const tagsRepo = repo;
export default { tagsRepo: repo };
`,
        shortCircuit: true,
      }
    case 'testmock://notes-repo-tb':
      return {
        format: 'module',
        source: `
// ../db/repositories/notes —— tagBridge.applyTagToNote 测试用。
// findAll 返回 globalThis.__test_notes 数组；updateMeta 把 patch.tags
// 合到对应 note 上并返回更新后的对象。
const repo = {
  async findAll(_opts) {
    return (globalThis.__test_notes ||= []);
  },
  async findById(id) {
    const notes = (globalThis.__test_notes ||= []);
    return notes.find((n) => n.id === id) ?? null;
  },
  async updateMeta(id, patch) {
    const notes = (globalThis.__test_notes ||= []);
    const note = notes.find((n) => n.id === id);
    if (!note) return null;
    const merged = { ...note, ...patch };
    const idx = notes.indexOf(note);
    notes[idx] = merged;
    const calls = (globalThis.__test_noteUpdateMetaCalls ||= []);
    calls.push({ id, patch });
    return merged;
  },
};
export const notesRepo = repo;
export default { notesRepo: repo };
`,
        shortCircuit: true,
      }
    case 'testmock://cached-stmt':
      return {
        format: 'module',
        source: `
// ../db/cachedStmt 的 stub —— statsBridge 测试用。
//
// 真实实现：模块级 Map<sql, stmtId> + dbClient.registerStmtCacheInvalidator。
// 测试 stub 简化：每次 prepareCached 都走 dbClient.call('prepare', { sql })，
// 缓存按 SQL 文本命中以模拟 stmt 复用语义。测试通过 globalThis.__test_dbClient
// 的 responseQueue 控制 stmtId 返回值，并通过 callLog 断言调用顺序。
//
// 并发同 SQL prepare 走 _pending Map dedup —— statsBridge 内部
// Promise.all 同时触发两次 prepareCached(COUNT SQL)，
// 真实模块也会命中同 stmtId（prepared statement 共享），测试 stub
// 必须让两次都拿到同一 stmtId，responseQueue 才不会被吃掉一条。
//
// 注意：dbClient 是缓存到模块顶层的引用，不能换成顶层 const —— ESM 模块
// 只初始化一次，测试在 resetAll() 里替换 globalThis.__test_dbClient 后
// 老引用仍指向旧对象。每次调用都重新读 globalThis.__test_dbClient。
const _cache = new Map();
const _pending = new Map();
let _invalidatorRegistered = false;
/** 与真实 cachedStmt.ts 的 ensureInvalidatorRegistered 对齐：模块顶层
 *  lazy 注册一次到 dbClient —— worker respawn 后 dbClient 广播 invalidate
 *  会清空 stub 的 _cache。 */
function _ensureInvalidatorRegistered() {
  if (_invalidatorRegistered) return;
  const client = globalThis.__test_dbClient;
  if (!client || typeof client.registerStmtCacheInvalidator !== 'function') return;
  client.registerStmtCacheInvalidator(() => { _cache.clear(); _pending.clear(); });
  _invalidatorRegistered = true;
}
export async function prepareCached(sql) {
  _ensureInvalidatorRegistered();
  const hit = _cache.get(sql);
  if (hit !== undefined) return hit;
  const pendingHit = _pending.get(sql);
  if (pendingHit) return pendingHit;
  const promise = (async () => {
    const client = globalThis.__test_dbClient;
    if (!client) throw new Error('test stub: __test_dbClient not set');
    const res = await client.call('prepare', { sql });
    if (!res || typeof res.stmtId !== 'number') {
      throw new Error('Failed to prepare statement (test stub)');
    }
    _cache.set(sql, res.stmtId);
    _pending.delete(sql);
    return res.stmtId;
  })();
  _pending.set(sql, promise);
  return promise;
}
export async function withCached(sql, run) {
  const stmtId = await prepareCached(sql);
  return run(stmtId);
}
// 测试辅助：清空缓存（模拟 worker respawn）。
export function __resetCache() { _cache.clear(); _pending.clear(); }
// 注册到 dbClient 的 invalidator —— 测试用，模拟「worker 已重生」场景。
// 真实场景由 prepareCached 首次调用时 lazy 注册（见 _ensureInvalidatorRegistered）。
export function __bindInvalidator() {
  _invalidatorRegistered = false;
  _ensureInvalidatorRegistered();
}
// 暴露到 globalThis：测试 import '../src/main/db/cachedStmt.ts' 时 loader
// 不会把它当 stub 返回（parent 不是已知 caller），拿到的是真模块 ——
// 真模块里没有 __resetCache。所以 stub 通过 globalThis 暴露 reset 句柄，
// 测试的 resetAll() 直接调 globalThis.__test_cachedStmtReset()，与 statsBridge
// 加载到的 stub 实例共享同一闭包（同一 URL 同一 ESM 模块缓存）。
globalThis.__test_cachedStmtReset = () => { _cache.clear(); _pending.clear(); _invalidatorRegistered = false; };
`,
        shortCircuit: true,
      }
    case 'testmock://sticky-notes-repo-tb':
      return {
        format: 'module',
        source: `
// ../db/repositories/stickyNotes —— tagBridge.applyTagToSticky /
// removeTagFromSticky 测试用。findById 读 globalThis.__test_stickies，
// update 写回。complete 是为兼容 / 留作接口占位。
//
// 同时承载 tools/registry 链路需要的 STICKY_UPDATE_MANY_MAX_IDS
// 常量 import（sticky.ts 第 30 行）。工具层走 stub 不会真的碰 DB，
// 测试仅做错误路径 + 合法路径分支覆盖，不验证 updateMany 真实语义。
const STICKY_UPDATE_MANY_MAX_IDS = 100;
const repo = {
  async findById(id) {
    // R-test-suite-completeSticky-toctou (test-coverage)：completeSticky 工具的
    // TOCTOU recheck 分支需要 findById 在同一工具调用中返回不同结果（首查
    // todo → 工具内 repo.complete() 返 null → 再查 recheck 时已变成
    // cancelled / done / 已删）。测试可在调用前预设 globalThis.__test_stickyFindByIdFn
    // 走 scripted 返回值；未设时退回读 __test_stickies 默认行为。
    const fn = globalThis.__test_stickyFindByIdFn;
    if (typeof fn === 'function') return fn(id);
    const stickies = (globalThis.__test_stickies ||= []);
    return stickies.find((s) => s.id === id) ?? null;
  },
  async update(id, patch) {
    const stickies = (globalThis.__test_stickies ||= []);
    const sticky = stickies.find((s) => s.id === id);
    if (!sticky) return null;
    const merged = { ...sticky, ...patch };
    const idx = stickies.indexOf(sticky);
    stickies[idx] = merged;
    const calls = (globalThis.__test_stickyUpdateCalls ||= []);
    calls.push({ id, patch });
    return merged;
  },
  async complete(id, opts) {
    const calls = (globalThis.__test_stickyCompleteCalls ||= []);
    calls.push({ id, opts });
    // R-test-suite-completeSticky-toctou (test-coverage)：测试可预设
    // __test_stickyCompleteReturnsNull=true 强制 complete() 返回 null，
    // 模拟「同一天幂等」/「并发冲突」/「跨日被拒」三种语义。否则走
    // 默认语义：有 sticky 行就返回它（模拟写入成功后的 row）。
    if (globalThis.__test_stickyCompleteReturnsNull === true) return null;
    const stickies = (globalThis.__test_stickies ||= []);
    const sticky = stickies.find((s) => s.id === id);
    if (!stickies.length || !stickies.find((s) => s.id === id)) return null;
    return sticky;
  },
  async findByDateRange() { return []; },
  async listFiltered() { return []; },
  async findByStatus() { return []; },
  async search() { return []; },
  // R-test-suite-createSticky-rollback (test-coverage)：默认 null，
  // 测试可通过 globalThis.__test_stickyCreateThrow 注入 Error 让 create
  // 抛错（验证 stickyNotesRepo.create 失败时 createSticky 返回 ok:false
  // + error.message，不冒泡英文 SDK 错误）。
  async create(input) {
    const calls = (globalThis.__test_stickyCreateCalls ||= []);
    calls.push(input);
    const e = globalThis.__test_stickyCreateThrow;
    if (e) throw e instanceof Error ? e : new Error(String(e));
    return globalThis.__test_stickyCreateReturn ?? null;
  },
  async updateMany() { return []; },
  // R-fix-missing-sticky-tools (test-coverage)：deleteSticky 工具的 execute
  // 路径调 stickyNotesRepo.remove(id)，返 false → ok:false + '便签不存在'，
  // 返 true → ok:true + deletedStickyNoteId。stub 默认返 false（与 IPC 真
  // 实行为对齐：删除不存在的便签返 false），测试通过 __test_stickyRemoveReturn
  // 注入 true 走成功路径；通过 __test_stickyRemoveThrow 注入 Error 让 try/catch
  // 透传 error.message。
  async remove(id) {
    const calls = (globalThis.__test_stickyRemoveCalls ||= []);
    calls.push(id);
    const e = globalThis.__test_stickyRemoveThrow;
    if (e) throw e instanceof Error ? e : new Error(String(e));
    return globalThis.__test_stickyRemoveReturn ?? false;
  },
  async setStatus() { return null; },
  async archive() { return null; },
  async toggleStarred() { return null; },
  async recordCompletion() {},
  async addStep() { return null; },
  async updateStep() { return null; },
  async removeStep() { return null; },
};
export const stickyNotesRepo = repo;
export { STICKY_UPDATE_MANY_MAX_IDS };
export default { stickyNotesRepo: repo, STICKY_UPDATE_MANY_MAX_IDS };
`,
        shortCircuit: true,
      }
    case 'testmock://library-manager':
      return {
        format: 'module',
        source: `
// ../../lib/libraryManager —— createNote 路径只用到 getCurrentLibrary，
// 返回 globalThis.__test_currentLibrary（string | null）；测试可预先
// 设成 tmp dir 路径或 null 触发失败路径。
export async function getCurrentLibrary() {
  return (globalThis.__test_currentLibrary === undefined ? null : globalThis.__test_currentLibrary);
}
export default { getCurrentLibrary };
`,
        shortCircuit: true,
      }
    case 'testmock://path-safety':
      return {
        format: 'module',
        source: `
// ../../notes/pathSafety —— createNote 路径只用 isRealPathInside。
// 测试通过 globalThis.__test_isRealPathInside 注入返回 true / false。
// 默认 true（合法路径通过），测试把全局改成 false 触发拒绝分支。
export async function isRealPathInside(rootDir, target) {
  const fn = globalThis.__test_isRealPathInside;
  if (typeof fn === 'function') return fn(rootDir, target);
  return true;
}
export function isPathInside() { return true; }
export async function existsAndIsRegularFile() { return false; }
export default { isRealPathInside, isPathInside, existsAndIsRegularFile };
`,
        shortCircuit: true,
      }
    case 'testmock://notes-loader':
      return {
        format: 'module',
        source: `
// R-test-suite-tools-registry (test-coverage)：../ai/notesLoader 的 stub。
// searchNotes / summarizeNote 调 loadNotesReal(library)，从磁盘
// 读 .taskpilot/notes/*.md 并 realpath 验证。测试里通过 globalThis 上
// 预设的 __test_loadedNotes 数组直接返回（filename / realPath / text），
// 跳过真实文件系统 + realpath 链路。
//
// 默认行为：library 没设置 / __test_loadedNotes 是 undefined → 返回空结果。
// 测试 preset：globalThis.__test_loadedNotes = [{filename, realPath, text}]
export async function loadNotesReal(_library) {
  const preset = globalThis.__test_loadedNotes;
  if (Array.isArray(preset)) return { ok: true, notes: preset };
  if (globalThis.__test_loadedNotesError) {
    return { ok: false, error: globalThis.__test_loadedNotesError };
  }
  return { ok: true, notes: [] };
}
export default { loadNotesReal };
`,
        shortCircuit: true,
      }
    case 'testmock://sticky-notes-repo-sh':
      return {
        format: 'module',
        source: `
// R-test-suite-sticky-handlers (test-coverage)：sticky-note-handlers 的
// 专用 stickyNotesRepo stub。覆盖 14 个方法：
//   - create / update / remove / findById / findByDateRange
//   - addStep / updateStep / removeStep
//   - complete / setStatus / archive / toggleStarred
//   - search / listFiltered / recordCompletion
//
// 默认行为（globalThis 未预设时）：
//   - 每次调用都把入参追加到 globalThis.__test_sticky<Method>Calls 数组，
//     让测试断言副作用（验证 validateStickyInput 失败路径下对应 repo 方法
//     未被调用 —— 这是 R33-Corr-3 / R34-Corr-1a/b 测试的核心）
//   - 默认返回值：
//     - complete → globalThis.__test_stickyCompleteReturn（默认 null）
//     - setStatus → globalThis.__test_stickySetStatusReturn（默认 null）
//     - archive → globalThis.__test_stickyArchiveReturn（默认 null）
//     - 其他方法 → null / []
//
// 测试预设：
//   globalThis.__test_stickyCompleteReturn = { status: 'done', completedAt: '...' }
//   globalThis.__test_stickySetStatusReturn = { status: 'done', ... }
//   globalThis.__test_stickyArchiveReturn = { archived: true, ... }
//
// 计数 / 副作用：
//   globalThis.__test_stickyXxxCalls 数组 —— 测试 resetAll() 时清空。
const pushCall = (key, payload) => {
  const list = (globalThis.__test_stickyShCalls ||= {});
  (list[key] ||= []).push(payload);
};
const repo = {
  async create(input) {
    pushCall('create', input);
    return globalThis.__test_stickyCreateReturn ?? null;
  },
  async update(id, patch) {
    pushCall('update', { id, patch });
    return globalThis.__test_stickyUpdateReturn ?? null;
  },
  async remove(id) {
    pushCall('remove', { id });
    return globalThis.__test_stickyRemoveReturn ?? null;
  },
  async findById(id) {
    pushCall('findById', { id });
    const fn = globalThis.__test_stickyFindById;
    return typeof fn === 'function' ? fn(id) : null;
  },
  async findByDateRange(start, end) {
    pushCall('findByDateRange', { start, end });
    return globalThis.__test_stickyFindByDateRangeReturn ?? [];
  },
  async addStep(noteId, content, order) {
    pushCall('addStep', { noteId, content, order });
    return globalThis.__test_stickyAddStepReturn ?? null;
  },
  async updateStep(stepId, patch) {
    pushCall('updateStep', { stepId, patch });
    return globalThis.__test_stickyUpdateStepReturn ?? null;
  },
  async removeStep(stepId) {
    pushCall('removeStep', { stepId });
    return globalThis.__test_stickyRemoveStepReturn ?? null;
  },
  async complete(id, opts) {
    pushCall('complete', { id, opts });
    if (globalThis.__test_stickyCompleteReturn !== undefined) {
      return globalThis.__test_stickyCompleteReturn;
    }
    return null;
  },
  async setStatus(id, status) {
    pushCall('setStatus', { id, status });
    if (globalThis.__test_stickySetStatusReturn !== undefined) {
      return globalThis.__test_stickySetStatusReturn;
    }
    return null;
  },
  async archive(id, archived) {
    pushCall('archive', { id, archived });
    if (globalThis.__test_stickyArchiveReturn !== undefined) {
      return globalThis.__test_stickyArchiveReturn;
    }
    return null;
  },
  async toggleStarred(id) {
    pushCall('toggleStarred', { id });
    return globalThis.__test_stickyToggleStarredReturn ?? null;
  },
  async search(opts) {
    pushCall('search', { opts });
    return globalThis.__test_stickySearchReturn ?? [];
  },
  async listFiltered(filter) {
    pushCall('listFiltered', { filter });
    return globalThis.__test_stickyListFilteredReturn ?? [];
  },
  async recordCompletion(id, date) {
    pushCall('recordCompletion', { id, date });
    return globalThis.__test_stickyRecordCompletionReturn ?? null;
  },
};
export const stickyNotesRepo = repo;
export default { stickyNotesRepo: repo };
`,
        shortCircuit: true,
      }
    case 'testmock://pomodoro-service-sh':
      return {
        format: 'module',
        source: `
// R-test-suite-sticky-handlers (test-coverage)：sticky-note-handlers 的
// 专用 pomodoroService stub。handler 只 import invalidateStickyTitle 一
// 个符号，其他导出符号保留 no-op 占位避免 ESM 解析报 undefined export。
export function invalidateStickyTitle(stickyNoteId) {
  const calls = (globalThis.__test_invalidateStickyTitleCalls ||= []);
  calls.push(stickyNoteId);
}
export function getState() { return null; }
export async function loadConfig() { return null; }
export async function saveConfig() { return null; }
export function start() {}
export function stop() {}
export function pause() {}
export function resume() {}
export function skip() {}
export async function recordPomodoro() { return null; }
export async function listToday() { return []; }
export async function listRecent() { return []; }
export function validatePomodoroConfigPatch(p) { return p ?? {}; }
export function startPomodoroService() {}
export function stopPomodoroService() {}
export default { invalidateStickyTitle };
`,
        shortCircuit: true,
      }
    case 'testmock://notify-sh':
      return {
        format: 'module',
        source: `
// R-test-suite-sticky-handlers (test-coverage)：sticky-note-handlers 的
// 专用 notify stub。handler 只 import ackPendingDue 一个符号。stub 把每次
// 调用追加到 globalThis.__test_ackPendingDueCalls 数组，并维护一个本地计
// 数器模拟真实行为，让测试能断言：
//   (1) ackPendingDue 在哪些分支被调用
//   (2) 多次调用的累计 delta 与 pendingDueCount 是否一致
//
// 同时暴露 getPendingDueCount / resetPendingDue / bumpPendingDue 等占位
// 避免未来 sticky-note-handlers 加 import 时再修 stub。
let pendingDueCount = 0;
export function ackPendingDue(delta = 1) {
  const calls = (globalThis.__test_ackPendingDueCalls ||= []);
  calls.push(delta);
  pendingDueCount = Math.max(0, pendingDueCount - delta);
  globalThis.__test_ackPendingDueCount = pendingDueCount;
}
export function bumpPendingDue(delta = 1) {
  pendingDueCount = Math.max(0, pendingDueCount + delta);
  globalThis.__test_ackPendingDueCount = pendingDueCount;
}
export function getPendingDueCount() {
  return pendingDueCount;
}
export function resetPendingDue() {
  pendingDueCount = 0;
  globalThis.__test_ackPendingDueCount = 0;
}
export default { ackPendingDue, bumpPendingDue, getPendingDueCount, resetPendingDue };
`,
        shortCircuit: true,
      }
    case 'testmock://completions-repo-ch':
      return {
        format: 'module',
        source: `
// R-test-suite-completion-handlers (test-coverage)：completion-handlers 的
// 专用 completions / noteEvents stub。
//
// handler 用到：
//   - completionsRepo.record(stickyNoteId, date, count) → 推入
//     __test_completionsRecordCalls，返回 __test_completionsRecordReturn
//     （默认 {id, stickyNoteId, date, count, createdAt}）
//   - completionsRepo.dailyCounts(start, end) / totalInRange(start, end) →
//     占位返回 __test_completionsDailyCountsReturn / __test_completionsTotalReturn
//     （默认 {} / 0）
//   - noteEventsRepo.record(noteId, date, type) → 推入
//     __test_noteEventsRecordCalls；返回 undefined
//   - noteEventsRepo.dailyCounts → 占位
const completionsRepo = {
  async record(stickyNoteId, date, count) {
    const calls = (globalThis.__test_completionsRecordCalls ||= []);
    calls.push({ stickyNoteId, date, count });
    const preset = globalThis.__test_completionsRecordReturn;
    if (preset !== undefined) return preset;
    return {
      id: 'mock-completion-' + (calls.length),
      stickyNoteId,
      date,
      count,
      createdAt: new Date().toISOString(),
    };
  },
  async dailyCounts(start, end) {
    const calls = (globalThis.__test_completionsDailyCountsCalls ||= []);
    calls.push({ start, end });
    return globalThis.__test_completionsDailyCountsReturn ?? {};
  },
  async totalInRange(start, end) {
    const calls = (globalThis.__test_completionsTotalCalls ||= []);
    calls.push({ start, end });
    return globalThis.__test_completionsTotalReturn ?? 0;
  },
};
const noteEventsRepo = {
  async record(noteId, date, type) {
    const calls = (globalThis.__test_noteEventsRecordCalls ||= []);
    calls.push({ noteId, date, type });
  },
  async dailyCounts(start, end) {
    const calls = (globalThis.__test_noteEventsDailyCountsCalls ||= []);
    calls.push({ start, end });
    return globalThis.__test_noteEventsDailyCountsReturn ?? {};
  },
};
export { completionsRepo, noteEventsRepo };
export default { completionsRepo, noteEventsRepo };
`,
        shortCircuit: true,
      }
    case 'testmock://sticky-notes-repo-ch':
      return {
        format: 'module',
        source: `
// R-test-suite-completion-handlers (test-coverage)：completion-handlers
// 只 import stickyNotesRepo.recordCompletion 一个符号。stub 把每次调用推
// 入 globalThis.__test_stickyRecordCompletionCalls 数组，让测试断言
// completion:record 的「sticky 路径」是否走到了该函数（vs 系统级聚合
// 走 completionsRepo.record）。其他方法占位避免 ESM 解析报 undefined
// export（未来 completion-handlers 加 import 时不会炸）。
const repo = {
  async recordCompletion(id, date) {
    const calls = (globalThis.__test_stickyRecordCompletionCalls ||= []);
    calls.push({ id, date });
  },
  // 占位（handler 当前不调用，留给未来扩展）
  async findById() { return null; },
  async complete() { return null; },
  async setStatus() { return null; },
  async archive() { return null; },
  async create() { return null; },
  async update() { return null; },
  async remove() {},
  async toggleStarred() { return null; },
  async addStep() { return null; },
  async updateStep() { return null; },
  async removeStep() { return null; },
  async findByDateRange() { return []; },
  async listFiltered() { return []; },
  async findByStatus() { return []; },
  async search() { return []; },
  async updateMany() { return []; },
};
export const stickyNotesRepo = repo;
export default { stickyNotesRepo: repo };
`,
        shortCircuit: true,
      }
    case 'testmock://backfill-ch':
      return {
        format: 'module',
        source: `
// R-test-suite-completion-handlers (test-coverage)：completion-handlers
// 只 import runAllBackfills。stub 把每次调用推入
// __test_runAllBackfillsCalls 数组，返回 __test_runAllBackfillsReturn
// （默认 { completions: { ... }, noteEvents: { ... } }）。
//
// runAllBackfills 是 fire-and-forget 风格的「手动触发」入口；测试只关心
// (a) force 入参透传，(b) 返回值形状被 handler 直接 re-export 给渲染端。
const DEFAULT_RESULT = {
  completions: { scanned: 0, inserted: 0, skipped: 0 },
  noteEvents: { scanned: 0, inserted: 0, skipped: 0 },
};
export async function runAllBackfills(force) {
  const calls = (globalThis.__test_runAllBackfillsCalls ||= []);
  calls.push({ force: !!force });
  const fn = globalThis.__test_runAllBackfills;
  if (typeof fn === 'function') return fn(force);
  const preset = globalThis.__test_runAllBackfillsReturn;
  return preset !== undefined ? preset : DEFAULT_RESULT;
}
export default { runAllBackfills };
`,
        shortCircuit: true,
      }
    case 'testmock://db-connection':
      return {
        format: 'module',
        source: `
// R-test-suite-db-handlers (test-coverage)：db-handlers 只 import getStatus。
// stub 返回 globalThis.__test_dbStatus（默认 mock 对象），
// 让测试可预设返回值（ready / version / path / migrations 等字段）。
export async function getStatus() {
  const fn = globalThis.__test_getStatus;
  if (typeof fn === 'function') return fn();
  return globalThis.__test_dbStatus ?? {
    ready: true,
    path: '/mock/path/taskpilot.db',
    version: 1,
    migrationsApplied: 1,
  };
}
export default { getStatus };
`,
        shortCircuit: true,
      }
    case 'testmock://renderer-ipc':
      return {
        format: 'module',
        source: `
// R-test-suite-sticky-store-rollback (test-coverage)：renderer/lib/ipc 的
// stub。真实模块从 window.api.invoke 拉数据，Node 测试环境没有 window。
// 这里把每个 API 子模块（stickyNotesApi / tagsApi / ...）直接读
// globalThis.__test_<api>Mock；测试可在 import 前注入一个对象，按方法名
// 拿到响应值或 throw 模拟 CAS 冲突 / 网络错误等。
//
// 默认行为：每个方法都把入参 push 到 globalThis.__test_<api>Calls 数组，
// 并返回一个 null（让 store 的乐观更新路径继续跑 —— store 内部有 inflightOps
// 守卫保证不会丢更新）；测试用例需要响应时单独覆盖 mock。
function makeApi(name) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        const calls = (globalThis['__test_' + name + 'Calls'] ||= []);
        calls.push({ method: String(prop), args });
        const mock = globalThis['__test_' + name + 'Mock'];
        const m = mock && mock[String(prop)];
        if (typeof m === 'function') return m(...args);
        if (m !== undefined && m !== null) return m;
        return null;
      };
    },
  });
}
export const stickyNotesApi = makeApi('stickyNotesApi');
export const tagsApi = makeApi('tagsApi');
export const settingsApi = makeApi('settingsApi');
export const notesApi = makeApi('notesApi');
export const dbApi = makeApi('dbApi');
export const pomodoroApi = makeApi('pomodoroApi');
export const stickyAggregatesApi = makeApi('stickyAggregatesApi');
export const navigateBridgeApi = makeApi('navigateBridgeApi');
export const gitApi = makeApi('gitApi');
export const pomodoroBridgeApi = makeApi('pomodoroBridgeApi');
export const completionBackfillApi = makeApi('completionBackfillApi');
export default { stickyNotesApi, tagsApi, settingsApi, notesApi, dbApi, pomodoroApi };
`,
        shortCircuit: true,
      }
    case 'testmock://aria-announcer':
      return {
        format: 'module',
        source: `
// R-test-suite-sticky-store-rollback (test-coverage)：AriaAnnouncer 的 stub。
// 真实实现是 React Portal + useState/useEffect，在 Node 环境跑不起来。
// 这里只暴露 announce(text, channel) 一个函数，把调用写到 globalThis 让
// 测试断言「创建便签时屏幕阅读器收到了什么」（stickyNotes.create 调
// announce），其他导出保留占位避免 ESM 解析报 undefined export。
export function announce(text, channel = 'polite') {
  const calls = (globalThis.__test_announceCalls ||= []);
  calls.push({ text: String(text ?? ''), channel: String(channel ?? 'polite') });
}
export function AriaAnnouncerMount() { return null; }
export default { announce, AriaAnnouncerMount };
`,
        shortCircuit: true,
      }
    default:
      return nextLoad(url, context)
  }
}
