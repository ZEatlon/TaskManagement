/**
 * 系统托盘
 *
 * 基础行为：
 *   - 单击：切换主窗口显示/隐藏
 *   - 右键菜单：显示窗口、隐藏窗口、退出应用
 *   - 图标缺省使用一个简单的 PNG 字节数组（Electron 内置 nativeImage.createFromBuffer）
 *
 * 注意：tray 模块对外提供 init() / destroy()，由主进程在合适时机调用。
 */
import { Tray, Menu, nativeImage, BrowserWindow, app, NativeImage } from 'electron'
import log from '../log'

let tray: Tray | null = null

/** 创建一个 16x16 占位图标（深灰色填充 PNG） */
function buildDefaultIcon(): NativeImage {
  // 16x16 透明背景 + 紫色方块，最简 PNG 字节
  // 来源：手工构造的最简 RGBA PNG（透明）
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, // 16x16
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0xf3, 0xff,
    0x61,
    0x00, 0x00, 0x00, 0x4d, 0x49, 0x44, 0x41, 0x54, // IDAT
    0x78, 0x9c, 0xed, 0xc1, 0x01, 0x0d, 0x00, 0x00,
    0x00, 0xc2, 0xa0, 0xf7, 0x4f, 0x6d, 0x0e, 0x37,
    0xa0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xbe, 0x0d, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x06, 0x18, 0x30, 0x00, 0x01, 0x90, 0x83,
    0xa6, 0xfe, 0xd4, 0x76, 0xb0, 0x09, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0xb0,
    0x05, 0x68, 0x06, 0xa6, 0x9e,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND
    0xae, 0x42, 0x60, 0x82,
  ])
  return nativeImage.createFromBuffer(pngBytes)
}

/** 主窗口显示/隐藏切换 */
function toggleMainWindow(): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) return
  const win = wins[0]
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) {
    win.hide()
  } else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

/** 显示主窗口（不切换） */
function showMainWindow(): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) return
  const win = wins[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 隐藏主窗口 */
function hideMainWindow(): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) return
  const win = wins[0]
  if (!win) return
  win.hide()
}

/** 构建右键菜单 */
function buildContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => showMainWindow(),
    },
    {
      label: '隐藏窗口',
      click: () => hideMainWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      },
    },
  ])
}

/**
 * 初始化托盘。若已存在则先销毁。
 * 失败（Linux 无系统托盘等）时不抛错，仅记录日志。
 */
export function initTray(): Tray | null {
  if (tray && !tray.isDestroyed()) {
    log.warn('[tray] already initialized')
    return tray
  }
  try {
    const icon = buildDefaultIcon()
    tray = new Tray(icon)
    tray.setToolTip('TaskPilot')
    tray.setContextMenu(buildContextMenu())
    tray.on('click', () => toggleMainWindow())
    tray.on('double-click', () => showMainWindow())
    log.info('[tray] initialized')
    return tray
  } catch (err) {
    log.warn('[tray] init failed:', (err as Error).message)
    tray = null
    return null
  }
}

/** 销毁托盘 */
export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    try {
      tray.destroy()
    } catch (err) {
      log.warn('[tray] destroy failed:', (err as Error).message)
    }
  }
  tray = null
}

/** 当前托盘实例（用于测试） */
export function getTray(): Tray | null {
  return tray
}