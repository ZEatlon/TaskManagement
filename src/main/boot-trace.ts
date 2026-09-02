/**
 * 早期启动追踪器（诊断用）
 *
 * 设计目的：在 src/main/index.ts 的最顶部立即写入 %TEMP% 文件，捕获 Electron
 * 主进程从冷启动到第一次稳定运行期间的所有关键事件。即使主进程在 require 阶段、
 * 当 app.whenReady() 之前就崩溃，也能留下可读日志用于诊断。
 *
 * 使用同步写入（fs.writeSync + O_APPEND）—— 不依赖任何异步/事件循环，
 * 不依赖 electron-log 的缓冲策略，进程级崩溃也能保留已写入的行。
 *
 * 写入路径：C:/Users/James/AppData/Local/Temp/taskpilot-dev-trace.log
 * （也可通过 TASKPILOT_BOOT_TRACE 环境变量覆盖）
 *
 * 当 boot-trace.ts 自己失败时（例如磁盘满、权限拒绝），不会阻塞主进程启动——
 * 所有 I/O 都包了 try/catch，降级为 no-op。
 */
import { writeSync, appendFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'

const TRACE_PATH =
  process.env['TASKPILOT_BOOT_TRACE'] ||
  'C:/Users/James/AppData/Local/Temp/taskpilot-dev-trace.log'

function ensureParent(p: string): void {
  try {
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
}

ensureParent(TRACE_PATH)

let fd: number | null = null
try {
  // O_APPEND: 多进程/多入口追加；O_CREAT: 首次运行创建；O_WRONLY
  fd = openSync(TRACE_PATH, 'a')
} catch {
  fd = null
}

function writeLine(line: string): void {
  const stamp = `[${new Date().toISOString()}] `
  const payload = stamp + line + '\n'
  // 1) 同步写入 fd（最快、最可靠）
  if (fd !== null) {
    try {
      writeSync(fd, payload)
    } catch {
      /* ignore */
    }
  }
  // 2) appendFileSync 兜底（不同步但确保至少有一次写入机会）
  try {
    appendFileSync(TRACE_PATH, payload)
  } catch {
    /* ignore */
  }
  // 3) 控制台（stdout/stderr 在 Windows GUI 下可能丢失，但尽力而为）
  try {
    process.stderr.write(payload)
  } catch {
    /* ignore */
  }
}

/** R7S-7：崩溃时确保 trace 缓冲写到磁盘。Node 进程退出时 buffer 不会自动 flush。 */
function flushTraceFile(): void {
  if (fd === null) return
  try {
    // fsync 在 Node 没有直接 API，但 fdatasync 接近同步；不能保证跨平台，
    // 退而求其次是关闭 fd 让 close 触发内核缓冲 flush。
    // 这里使用 fsyncSync（Linux/macOS 都有；Windows 上是 _commit 的 polyfill）。
    // Node 没有内置 fsyncSync，统一走 close → 重开的方式。
    closeSync(fd)
    fd = openSync(TRACE_PATH, 'a')
  } catch {
    /* ignore */
  }
}

// 启动时立即记录进程信息（覆盖上次运行，便于对比）
try {
  writeLine('--- new run ---')
  writeLine(`execPath=${process.execPath}`)
  // R14 修复 (low)：argv 整串写盘有未来泄漏风险（--inspect / 凭据 / token
  // 都能通过命令行注入并落到 TEMP）。改为只记录 argv 数量与每个元素的
  // 长度 + 第一段（进程路径），其余元素只标序号，避免凭据直存。
  const argvList = process.argv
  writeLine(`argv.len=${argvList.length}`)
  argvList.forEach((a, i) => {
    const head = i === 0 ? a : `${i}:len${a.length}`
    writeLine(`argv[${i}]=${head}`)
  })
  writeLine(`node=${process.version}`)
  writeLine(`platform=${process.platform}/${process.arch}`)
  writeLine(`pid=${process.pid}`)
  writeLine(`cwd=${process.cwd()}`)
  writeLine(`env.ELECTRON_RENDERER_URL=${process.env['ELECTRON_RENDERER_URL'] || '(unset)'}`)
  writeLine(`env.ELECTRON_ENABLE_LOGGING=${process.env['ELECTRON_ENABLE_LOGGING'] || '(unset)'}`)
} catch {
  /* ignore */
}

// 进程级错误兜底——理论上 electron-log 的 errorHandler 已经捕获，但显式再装一次
// 防止日志系统在崩溃路径上先于本模块时也能记录到崩溃前的栈。
// R7S-7 修复：原实现只写 trace 文件就吞掉异常，IPC bridge 可能已部分撕裂、
// SQLite 锁可能仍持有，导致 UI 永远冻结在「看似活着但啥都不响应」。先同步
// flush trace，再调用 app.exit(1) 让 Electron 清理资源后退出，避免用户面对
// 一个永远卡死的窗口而不知道发生了什么。
process.on('uncaughtException', (err) => {
  writeLine(`[uncaughtException] ${(err && (err.stack || err.message)) || String(err)}`)
  try {
    // 强制把缓冲 flush 到磁盘（writeLine 内部已经同步，但保险起见再 fsync 一下）
    flushTraceFile()
  } catch {
    /* ignore */
  }
  // 仅在 Electron app 已 ready 时才 exit —— 否则会破坏 app 自身启动
  try {
    setImmediate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron') as typeof import('electron')
        if (app.isReady()) {
          app.exit(1)
        }
      } catch {
        /* non-electron 环境下（如 CLI 测试）不做 exit */
      }
    })
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (reason) => {
  writeLine(
    `[unhandledRejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
  )
  // unhandledRejection 不一定致命 —— 不强制 exit，只记录
})
process.on('exit', (code) => {
  writeLine(`[process.exit] code=${code}`)
})

/**
 * 暴露给业务代码的 step 标记器。每个 module-load / async milestone 都应当调一次。
 * 用法：import { trace } from './boot-trace'; trace('initDatabase:about-to-spawn-worker')
 */
export function trace(tag: string, extra?: string): void {
  writeLine(extra ? `[trace] ${tag} | ${extra}` : `[trace] ${tag}`)
}

/**
 * 让主进程退出码可被外部观察：在 before-quit / quit / window-all-closed 等
 * 关键生命周期上挂一个一次性监听，把触发的路径写一行。
 */
export function installLifecycleHooks(): void {
  try {
    // electron 在 require('electron') 后才可用；这里延迟到 next tick 再 require，
    // 保证 boot-trace.ts 自身可以在 electron 还没加载完时就先记录 init 信息。
    setImmediate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron') as typeof import('electron')
        trace('installLifecycleHooks:app-available', `isReady=${app.isReady()}`)
        const events: Array<[string, string]> = [
          ['ready', 'app:ready'],
          ['will-quit', 'app:will-quit'],
          ['before-quit', 'app:before-quit'],
          ['quit', 'app:quit'],
          ['window-all-closed', 'app:window-all-closed'],
          ['render-process-gone', 'app:render-process-gone'],
          ['child-process-gone', 'app:child-process-gone'],
          ['gpu-process-crashed', 'app:gpu-process-crashed'],
        ]
        for (const [event, tag] of events) {
          app.on(event as any, (...args: unknown[]) => {
            trace(`app.on:${tag}`, JSON.stringify(args.map((a) => safeStr(a))))
          })
        }
      } catch (err) {
        trace(
          'installLifecycleHooks:require-electron-failed',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
  } catch {
    /* ignore */
  }
}

function safeStr(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '...' : v
  try {
    return JSON.stringify(v).slice(0, 200)
  } catch {
    return '<unserializable>'
  }
}

// 自动安装生命周期挂钩
installLifecycleHooks()