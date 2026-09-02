/**
 * 窗口管理器
 * 单一职责：管理主窗口的创建、销毁、生命周期事件
 */
import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import log from '../log'
import { attachWindowEventForwarding } from '../ipc/window-handlers'
import { isBlockedHostname } from '../lib/networkSafety'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log.warn('[window] Main window already exists, focusing instead.')
    mainWindow.focus()
    return mainWindow
  }

  // 取主显示器可用区域
  const display = screen.getPrimaryDisplay()
  const { width: screenW, height: screenH } = display.workAreaSize

  // 默认窗口尺寸：约 70% 屏幕，约束到合理区间
  const width = Math.min(Math.max(Math.floor(screenW * 0.7), 1024), 1600)
  const height = Math.min(Math.max(Math.floor(screenH * 0.8), 720), 1100)

  // 图标路径：生产环境走 extraResources 落地的 resources/build/icon.png，
  // 开发环境回退到项目根 build/icon.png
  const prodIcon = join(process.resourcesPath ?? '', 'build/icon.png')
  const devIcon = join(__dirname, '../../build/icon.png')
  const icon = existsSync(prodIcon) ? prodIcon : devIcon

  mainWindow = new BrowserWindow({
    width,
    height,
    // 最小窗口尺寸：保证三栏 Dashboard + 今日分屏 + 笔记三栏布局 都能完整呈现
    minWidth: 1180,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    // 自定义窗口栏：去掉系统标题栏，由渲染端 Header 提供。
    // macOS 仍保留 hiddenInset 行为（保留左上角红绿灯 + 内容上移贴边）。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: process.platform === 'darwin' ? true : false,
    backgroundColor: '#0f1115',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    log.info('[window] Main window shown.')
  })

  // 注册自定义标题栏需要的事件转发（maximize / unmaximize）
  attachWindowEventForwarding(mainWindow)

  // 阻止外链导航
  // R27-Sec-1 修复 (medium SSRF / context confusion)：原版 will-navigate 走到
  // !allowedHosts 分支后，对 http/https 直接 shell.openExternal(url) —— 与
  // setWindowOpenHandler (index.ts:158-191) 的 SSRF 防御不一致。攻击：
  // 渲染端被劫持后用 <a target="_self" href="https://192.168.1.1/admin"> 或
  // window.location.href = 'http://internal.lan/...' → will-navigate 命中
  // shell.openExternal，绕过 R25-Sec-1 的 isBlockedHostname 检查，弹出 OS
  // 浏览器访问内网主机。修复：与 setWindowOpenHandler 走同一份
  // isBlockedHostname 校验，仅放行公开主机；非公开主机直接吞掉 preventDefault
  // 拒绝打开（不让 OS 浏览器代为访问）。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      event.preventDefault()
      return
    }
    const deniedProtocols = ['file:', 'javascript:', 'data:', 'blob:']
    const allowedHosts = ['http://localhost:5173', 'http://localhost:5174']
    if (deniedProtocols.includes(parsed.protocol) || !allowedHosts.includes(parsed.origin)) {
      event.preventDefault()
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        // 与 setWindowOpenHandler 一致：拒绝任何内网/loopback/CGN 主机
        if (isBlockedHostname(parsed.hostname)) {
          log.warn(`[window] will-navigate blocked internal host: ${parsed.hostname}`)
        } else {
          shell.openExternal(url)
        }
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    log.info('[window] Main window closed.')
  })

  // 加载页面
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    log.info(`[window] Dev URL: ${process.env['ELECTRON_RENDERER_URL']}`)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function destroyMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
    mainWindow = null
  }
}