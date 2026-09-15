/**
 * TaskPilot 主进程入口
 * 负责应用生命周期管理、窗口创建、IPC 注册
 */
import { trace } from './boot-trace' // 必须在最前：记录冷启动到 require 阶段的全过程
trace('index.ts:imports-start')

import { app, BrowserWindow, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import log from './log'
trace('index.ts:electron+log-imported')

import { createMainWindow } from './window/windowManager'
import { registerIpcHandlers } from './ipc/router'
import { initDatabase, closeDatabase } from './db/connection'
import { startAutoSync, stopAutoSync } from './git/autoSync'
import { runAllBackfills } from './db/backfill'
import { startAll as startScheduler, stopAll as stopScheduler } from './scheduler'
import { initTray, destroyTray } from './notifications/tray'
import { isFirstRun } from './lib/libraryManager'
import { notesManager } from './notes/notesManager'
import { startPomodoroService, stopPomodoroService } from './pomodoro/pomodoroService'
import { grantAttachmentPrivileges, registerAttachmentProtocol } from './attachments/protocol'
import { startNotifier, stopNotifier } from './sticky-notes'
trace('index.ts:all-imports-done')

const isDev = !app.isPackaged
let isQuitting = false

log.info(`[boot] TaskPilot starting (dev=${isDev})`)

// 注册自定义协议 scheme 权限（必须在 app ready 之前）
grantAttachmentPrivileges()
trace('index.ts:grantAttachmentPrivileges-done')

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock()
trace('index.ts:requestSingleInstanceLock', `got=${gotTheLock}`)
if (!gotTheLock) {
  log.warn('[boot] Another instance is running, quitting.')
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    trace('index.ts:whenReady-resolved')
    electronApp.setAppUserModelId('com.taskpilot.app')
    app.commandLine.appendSwitch('disable-renderer-backgrounding')

    // 注册 attachments:// 自定义协议（模块 6）
    registerAttachmentProtocol()
    trace('index.ts:registerAttachmentProtocol-done')

    // 初始化数据库（spawn sidecar worker + 打开 DB + 运行迁移）
    try {
      await initDatabase()
      trace('index.ts:initDatabase-ok')
    } catch (err) {
      trace('index.ts:initDatabase-FAILED', err instanceof Error ? err.message : String(err))
      log.error('[boot] database init failed', err)
      // 仍继续启动，但 IPC 操作会失败
    }

    // 检测是否首次启动（用于在 UI 中显示首次启动向导）
    try {
      const firstRun = await isFirstRun()
      if (firstRun) {
        log.info('[boot] first-run detected: no library path configured.')
      } else {
        log.info('[boot] not first-run, library already configured.')
      }
    } catch (err) {
      log.warn('[boot] isFirstRun check failed', err)
    }

    registerIpcHandlers()
    trace('index.ts:registerIpcHandlers-done')
    createMainWindow()
    trace('index.ts:createMainWindow-done')

    // 历史回填：把已有任务完成记录补到 completions / note_events 表
    // 仅首次启动执行（受 settings 标记控制），失败不影响主流程
    runAllBackfills().catch((err) => {
      log.error('[boot] backfill failed', err)
    })

    // Mock 数据：开发模式下首次启动自动塞入一组示例数据（笔记 / 便签 / 番茄钟 / 文件夹），
    // 便于手动测试各种功能。受 `mock.seed.v1` 设置项幂等控制，不会重复塞入。
    // - 默认 dev 跑、prod 不跑
    // - 设 MOCK_SEED=1 强制开启；设 MOCK_SEED=0 强制关闭
    try {
      const { seedMockDataIfNeeded } = await import('./db/mockData')
      void seedMockDataIfNeeded()
    } catch (err) {
      log.warn('[boot] mock seed init failed', err)
    }

    // 启动系统托盘（失败不影响主流程）。
    // R-fix-i18n-tray-menu (high)：initTray 改为 async，需要 await 拿到
    // settings.language → 渲染 locale 文案。失败时整体回退到默认 locale。
    try {
      await initTray()
    } catch (err) {
      log.warn('[boot] tray init failed', err)
    }

    // 启动调度器（数据库已就绪）
    try {
      startScheduler()
    } catch (err) {
      log.error('[boot] scheduler start failed', err)
    }

    // 启动番茄钟服务（无需任何依赖，加载配置 + 绑定 IPC 事件）
    try {
      startPomodoroService()
    } catch (err) {
      log.warn('[boot] pomodoro service start failed', err)
    }

    // 启动便签提醒派发服务（30s 扫描 + 系统通知 + IPC 推送）
    // 与 pomodoroService 一样容错启动：失败不影响主流程。
    try {
      startNotifier()
    } catch (err) {
      log.warn('[boot] sticky notifier start failed', err)
    }

    // 启动 Git 自动同步调度器（库目录就绪且 settings.gitAutoPushEnabled 时生效）
    try {
      await startAutoSync()
    } catch (err) {
      log.warn('[boot] autoSync start failed', err)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('before-quit', (event) => {
    if (isQuitting) return
    event.preventDefault()
    isQuitting = true
    // 先停止调度器和托盘，再关闭数据库
    void (async () => {
      try {
        stopAutoSync()
        stopScheduler()
        stopPomodoroService()
        // R28 修复 (medium)：stopNotifier 现在是 async，必须 await 以保证
        // in-flight scanOnce 落地后再 finalizeCachedStmts；否则 scanOnce 链
        // 上的 dbClient.call('run') 会命中已 finalize 的 stmtId 报错，setInterval
        // .catch 静默吞错 → notified_at 没落库 → 用户重复收到同一条便签提醒。
        await stopNotifier()
        destroyTray()
        await notesManager.stopWatching()
      } catch (err) {
        log.warn('[shutdown] scheduler/tray/autoSync/pomodoro/notifier stop failed', err)
      }
      try {
        await closeDatabase()
      } catch (err) {
        log.warn('[shutdown] closeDatabase failed', err)
      }
      // H14 修复 (high correctness)：原版用 app.exit() —— 这会跳过 will-quit /
      // quit 事件链，导致主进程 IPC handler 的"关闭前 flush"逻辑全部跳过。
      // 用户在退出瞬间保存的最后一条笔记 / 一条想法可能没真正落盘就被进程
      // 干掉。改用 app.quit() —— 经过完整的 will-quit → before-quit 链
      // （isQuitting 已 true，所以不会再触发本 handler 的 preventDefault 死循环），
      // 让 IPC 侧有机会跑完清理。
      app.quit()
    })()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      log.info('[boot] All windows closed, quitting.')
      app.quit()
    }
  })

  app.on('web-contents-created', (_event, contents) => {
    // R28-Corr-1：webContents 销毁时清掉 ai/tools 里的 openedNotes /
    // currentOpenNote 集合，避免反复开关窗口让 Map 无限增长。
    contents.on('destroyed', () => {
      void import('./ai/tools').then(({ clearWebContentsNoteState }) => {
        clearWebContentsNoteState(contents.id)
      }).catch((err) => {
        log.warn('[boot] failed to clearWebContentsNoteState on destroyed', err)
      })
    })

    // H8 修复 (high reliability)：渲染进程崩溃（OOM / V8 致命错 / 主进程
    // 主动 kill）默认会让 BrowserWindow 留下一个白屏、用户点哪都没反应的
    // "僵尸窗口"，整个 app 看起来死了但其实渲染端已被回收。Electron 提供
    // 'render-process-gone' 事件 —— 在这里尝试自动重建窗口；如果 owner
    // window 不存在或重建失败，至少 log 让用户能定位问题。
    contents.on('render-process-gone', (_event, details) => {
      log.error(
        `[crash] render process gone (reason=${details.reason} exitCode=${details.exitCode})`,
      )
      const ownerWin = BrowserWindow.fromWebContents(contents)
      if (!ownerWin || ownerWin.isDestroyed()) return
      // 给用户一个反馈：把窗口标题临时改成「已崩溃」便于排查。
      try {
        ownerWin.setTitle(`[crashed] ${ownerWin.getTitle()}`)
      } catch {
        /* title 设置失败吞掉 */
      }
    })

    // H15 修复 (medium reliability)：GPU 进程崩溃（驱动 bug / 显存 OOM）
    // 默认会让 Chromium 把整个 webContents 渲染降级到 software，会触发大量
    // 视觉异常。这里加监听做日志，让用户 / 上报系统能识别"页面卡顿"是
    // GPU 崩而不是前端 bug。
    // 注意：Electron 的 TS 类型在某些版本没把 gpu-process-crashed 加到
    // WebContents.on 的事件表里（实际运行时支持）—— 这里用 any cast 强转。
    ;(contents.on as unknown as (event: string, listener: (...args: unknown[]) => void) => void)(
      'gpu-process-crashed',
      (_event: unknown, killed: unknown) => {
        log.error(`[crash] gpu process crashed (killed=${String(killed)})`)
      },
    )
    contents.setWindowOpenHandler((details) => {
      // R25-Sec-1 修复 (medium SSRF)：原 setWindowOpenHandler 只校验协议，
      // 没有 SSRF 防御 —— 渲染端 XSS / 恶意 markdown 链接可以调
      // `window.open('http://internal-router.lan/admin')` 让 OS 默认浏览器
      // 打开内网设备管理面。和 system:open-external 一并用 isBlockedHostname
      // 拒 loopback / 私有 / link-local 主机。
      try {
        const url = new URL(details.url)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          // 异步 import：避免模块加载顺序问题（networkSafety 是被 git / settings
          // handler 加载的，这里只在 window.open 触发时按需加载）。
          void import('./lib/networkSafety').then(({ isBlockedHostname }) => {
            if (isBlockedHostname(url.hostname)) {
              log.warn(
                `[security] blocked window.open for loopback / private host: ${url.hostname}`,
              )
              return
            }
            shell.openExternal(details.url).catch((err) => {
              log.warn('[security] shell.openExternal failed', err)
            })
          }).catch((err) => {
            log.error('[security] failed to load networkSafety module', err)
          })
        } else {
          log.warn('[security] blocked openExternal for non-http(s) protocol', url.protocol)
        }
      } catch (err) {
        log.warn('[security] failed to parse window.open url', err)
      }
      return { action: 'deny' }
    })
  })

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })
}