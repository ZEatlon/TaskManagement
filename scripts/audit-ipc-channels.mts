#!/usr/bin/env node
/**
 * W0 Bug audit — IPC orphan channel scanner
 *
 * 目的：确保所有在 IPC_CHANNELS（共享声明）里出现的通道都有 handler 注册，
 *       或被显式列入"主→渲 推送事件"白名单（无 handler 是设计如此）。
 *
 * 防的 bug 类：
 *   - 渲染端 invoke 某个通道，主进程没注册 → IPC 永远 hang（不 reject 也不 resolve）
 *   - 历史上 R-fix-i18n-tray-menu、R-fix-... 类 bug 都是因为 renderer 调用了
 *     没注册的 channel 而 IPC 永久挂起
 *
 * 用法：node scripts/audit-ipc-channels.mts
 *       退出码：0 = 全部匹配；1 = 发现 orphan（declare 了但既无 handler 又不在推送白名单）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const CHANNELS_FILE = join(ROOT, 'src/shared/ipc/channels.ts')
const IPC_DIR = join(ROOT, 'src/main/ipc')

// 主→渲 推送事件：这些通道只走 webContents.send()，不需要 handler。
// 维护这个白名单是显式声明 —— 新增推送事件需要在这里加一行。
const PUSH_ONLY_EVENTS = new Set<string>([
  'note:fs-event',
  'ai:chunk',
  'app:navigate',
  'notify:dispatch',
  'sticky-note:due',
  'notify:reminder',
  'notify:persist-failed',
  'notify:toast-failed',
  'pomodoro:tick',
  'pomodoro:phase-complete',
  'pomodoro:state-changed',
  'pomodoro:persist-failed',
  'pomodoro:focus-mode-changed',
  'pomodoro:audio-set',
  'pomodoro:audio-play-sound',
  'window:on-maximize-changed',
  'git:state-changed',
  'git:sync-start',
  'git:sync-end',
  'git:sync-error',
  'updater:status',
])

// ───────── Step 1: 解析 IPC_CHANNELS ─────────
const channelsSrc = readFileSync(CHANNELS_FILE, 'utf8')
// 匹配 `KEY: 'value'` 形式（允许 value 含冒号、连字符、点）
const declRegex = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*['"]([^'"]+)['"]/gm
const declared = new Map<string, string>() // channel string → const name
for (const m of channelsSrc.matchAll(declRegex)) {
  declared.set(m[2], m[1])
}

// ───────── Step 2: 扫描 handler 注册 ─────────
// 收集两种模式：
//   - handle(CHANNELS.XXX, ...) —— 编译时常量
//   - handle('xxx', ...) —— 字符串字面量
//   - ipcMain.handle('xxx', ...) —— 直接 ipcMain.handle（navigateBridge 用）
const registered = new Set<string>()

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkTs(p))
    else if (/\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

// 一些模块直接在 src/main/{子目录}/*.ts 注册 handler（如 ai/navigateBridge.ts）
const EXTRA_SCAN_DIRS = [join(ROOT, 'src/main/ai')]

const SCAN_DIRS = [IPC_DIR, ...EXTRA_SCAN_DIRS]

for (const dir of SCAN_DIRS) {
  for (const f of walkTs(dir)) {
    const text = readFileSync(f, 'utf8')
    // 策略：handler 文件里同时存在 `handle(` 注册 + 通道引用（字面量或
    // IPC_CHANNELS.XXX）。文件级宽松匹配：
    //   - 任何 `'channel-name'` 或 `"channel-name"` 字面量 → 注册了该通道
    //   - 任何 `IPC_CHANNELS.XXX` 引用 → 反查常量值并注册
    // 这样不需要处理多行 handle<T1, T2>(...args) 跨行 case，也不会漏
    // 真正注册过的 channel（handler 文件几乎不会引用未注册的 channel）。
    const handleCount = (text.match(/\bhandle\s*[<(]/g) ?? []).length
      + (text.match(/\bipcMain\.handle\s*[<(]/g) ?? []).length
    if (handleCount === 0) continue

    // 字面量：要求字面量值已经在 declared 集合里（剔除 node:fs 这种
    // Node 内置模块导入，也剔除 assertSelfSender(..., 'get-state')
    // 这种调试标签里的任意字符串）。
    // 通道名形态：domain:verb 或 domain-verb:action（如 note-event:record）
    // 允许两段：domain (含 -) + 分隔符 + verb (含 - 和 : 不允许因为 verb 不含 :)
    // 这里放宽到 domain 含 -，verb 含 -，整体再交给 declared 过滤。
    const litRe = /['"]([a-z][a-z0-9-]*[:\-][a-z][a-z0-9\-]*)['"]/g
    for (const m of text.matchAll(litRe)) {
      if (declared.has(m[1])) registered.add(m[1])
    }

    // 常量：handler 文件通常用 `import { IPC_CHANNELS as CHANNELS } from ...`
    // 再以 CHANNELS.XXX 引用。两种形态都要收：IPC_CHANNELS.XXX 和
    // CHANNELS.XXX（按 import alias 推断）。
    const constRe = /(?:IPC_CHANNELS|CHANNELS)\.([A-Z_][A-Z0-9_]*)/g
    for (const m of text.matchAll(constRe)) {
      for (const [value, name] of declared) {
        if (name === m[1]) {
          registered.add(value)
          break
        }
      }
    }
  }
}

// ───────── Step 3: 对比 ─────────
const orphans: string[] = []
const dead: string[] = [] // 注册了但不在声明中 —— 可能 typo 或忘了删

for (const [chan, constName] of declared) {
  if (registered.has(chan)) continue
  if (PUSH_ONLY_EVENTS.has(chan)) continue
  orphans.push(`${chan} (${constName})`)
}

for (const chan of registered) {
  if (!declared.has(chan)) {
    dead.push(chan)
  }
}

console.log(`declared: ${declared.size}`)
console.log(`registered: ${registered.size}`)
console.log(`push-only events: ${PUSH_ONLY_EVENTS.size}`)

if (orphans.length > 0) {
  console.error(`\n❌ ORPHAN channels (declared but neither registered nor in push-only whitelist):`)
  for (const o of orphans) console.error(`  - ${o}`)
}

if (dead.length > 0) {
  console.error(`\n❌ DEAD channels (registered but not declared in IPC_CHANNELS):`)
  for (const d of dead) console.error(`  - ${d}`)
}

if (orphans.length > 0 || dead.length > 0) {
  process.exit(1)
}

console.log('\n✅ All IPC channels are accounted for (registered or push-only)')