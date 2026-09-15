/**
 * 系统托盘
 *
 * 基础行为：
 *   - 单击：切换主窗口显示/隐藏
 *   - 右键菜单：显示窗口、隐藏窗口、退出应用
 *   - 图标缺省使用一个简单的 PNG 字节数组（Electron 内置 nativeImage.createFromBuffer）
 *
 * 注意：tray 模块对外提供 init() / destroy()，由主进程在合适时机调用。
 *
 * R-fix-i18n-tray-menu (high)：右键菜单的「显示窗口 / 隐藏窗口 / 退出」三
 * 条文案原本 inline 硬编码中文，绕过 @shared/i18n/locales registry。改为
 * 启动时一次从 settings.language 解析 TrayMessages，缓存到模块作用域，
 * buildContextMenu() 从缓存取 —— 与 NotificationMessages 同结构（短语 →
 * 字符串）。
 */
import { Tray, Menu, nativeImage, BrowserWindow, app, NativeImage } from 'electron'
import log from '../log'
import { settingsRepo } from '../db/repositories/settings'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/channels'
import { getTrayMessages, type TrayMessages } from '@shared/i18n/locales'

let tray: Tray | null = null
/**
 * tray 右键菜单文案缓存。initTray() 时一次解析 settings.language 并写入；
 * refreshTrayMessages(rawLocale) 主动刷新（settings.language 变更路径）。
 * 未初始化时回退到 toLocaleValue(undefined) → 默认 locale，与
 * getTrayMessages() 内部回退策略一致。
 */
let trayMessages: TrayMessages = getTrayMessages(undefined)

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

/** 构建右键菜单 —— 文案从 trayMessages（locale 缓存）取 */
function buildContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: trayMessages.showWindow,
      click: () => showMainWindow(),
    },
    {
      label: trayMessages.hideWindow,
      click: () => hideMainWindow(),
    },
    { type: 'separator' },
    {
      label: trayMessages.quit,
      click: () => {
        app.quit()
      },
    },
  ])
}

/**
 * 用指定 locale 重建右键菜单文案缓存并刷新 tray。
 *
 * 设计取舍：tray 模块暴露这个 refresh 接口，让 settings.language 变更路径
 * （settings store → IPC → 主进程）能主动重渲菜单，避免「用户改了语言，
 * 但托盘右键菜单仍渲染旧语言」的分裂 UI。调用方只需 await 即可，未初始化
 * 时仅更新缓存、下次 init 自动生效。
 */
export async function refreshTrayMessages(rawLocale: unknown): Promise<void> {
  trayMessages = getTrayMessages(rawLocale)
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildContextMenu())
  }
}

/**
 * 初始化托盘。若已存在则先销毁。
 * 失败（Linux 无系统托盘等）时不抛错，仅记录日志。
 *
 * 改为 async：需要 await settingsRepo.get<AppSettings> 解析 language 后
 * 才能构建右键菜单。settings 读取失败时回退到默认 locale（与
 * getTrayMessages 内部 toLocaleValue 回退策略一致）。
 */
export async function initTray(): Promise<Tray | null> {
  if (tray && !tray.isDestroyed()) {
    log.warn('[tray] already initialized')
    return tray
  }
  try {
    // 一次性解析 locale 缓存到 trayMessages，buildContextMenu() 直接读
    // 缓存，避免每次右键点击都 await settingsRepo.get。失败回退默认 locale。
    try {
      const settings = (await settingsRepo.get<AppSettings>('app.settings')) ?? DEFAULT_SETTINGS
      trayMessages = getTrayMessages(settings.language)
    } catch (err) {
      log.warn('[tray] settings read failed, fallback to default locale:', (err as Error).message)
      trayMessages = getTrayMessages(undefined)
    }
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
