/**
 * 自动更新模块（主进程）
 *
 * 串联：
 *   - electron-updater（检查 / 下载 / 安装新版本）
 *   - 主进程 IPC（接收渲染端的 check / download / install 调用）
 *   - 渲染端 IPC 推送（status / progress 事件）
 *
 * 安全设计：
 *   - 默认 autoDownload=false：用户主动点"下载"才下载
 *   - 默认 autoInstallOnAppQuit=false：用户主动点"立即重启"才装
 *   - dev 模式下检查自动跳过（避免 dev 环境疯狂弹更新）
 *   - 所有 IPC handler 限制 sender === 自己的主窗口 webContents
 *   - 通过 webContents.send 推送状态时检查 webContents 是否已销毁
 */
import { app, BrowserWindow, webContents } from 'electron'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'
import log from './log'
import { IPC_CHANNELS as CHANNELS } from '@shared/ipc/channels'
import type { UpdaterState } from '@shared/types/updater'

const { autoUpdater } = electronUpdater

export type { UpdaterState, UpdaterStatus, UpdaterProgress } from '@shared/types/updater'

let initialized = false

/** 启动时是否自动检查更新。dev 模式下不生效。 */
let autoCheckOnStart = true

function getDefaultState(): UpdaterState {
  return {
    status: 'idle',
    currentVersion: app.getVersion(),
  }
}

let state: UpdaterState = getDefaultState()

/** 推送状态到所有 renderer webContents（过滤已销毁的） */
function emitToRenderers(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    try {
      wc.send(channel, payload)
    } catch (err) {
      log.warn('[updater] emit failed; skipping', err)
    }
  }
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch }
  emitToRenderers(CHANNELS.UPDATER_STATUS, state)
}

/** 初始化 electron-updater 事件监听。仅在 app ready 后调用一次。 */
export function initUpdater(): void {
  if (initialized) return
  initialized = true

  // dev 模式（electron-vite 启动）下跳过 autoUpdater —— 它会去 GitHub
  // 拉 latest.yml，dev 包没签名过 / version 也不对，会一直报错。
  const isDev = !app.isPackaged
  if (isDev) {
    log.info('[updater] dev mode — autoUpdater disabled')
    setState({ status: 'disabled' })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // 拉取更新元数据时的 logger —— 出错时帮助定位是 network / 签名 / 协议问题
  autoUpdater.logger = log

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking-for-update')
    setState({ status: 'checking', error: undefined })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('[updater] update-available', info.version)
    setState({
      status: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log.info('[updater] update-not-available', info.version)
    setState({ status: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setState({
      status: 'downloading',
      progress: {
        transferred: progress.transferred,
        total: progress.total,
        percent: progress.percent,
      },
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('[updater] update-downloaded', info.version)
    setState({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err: Error) => {
    log.error('[updater] error', err)
    setState({ status: 'error', error: err.message ?? String(err) })
  })

  // 启动后 5 秒做一次后台检查（不阻塞 UI）
  if (autoCheckOnStart) {
    setTimeout(() => {
      void checkForUpdates().catch((err) => {
        log.warn('[updater] initial background check failed', err)
      })
    }, 5000)
  }
}

/** 主动检查更新（由 settings 页面或菜单触发） */
export async function checkForUpdates(): Promise<UpdaterState> {
  if (!app.isPackaged) {
    setState({ status: 'disabled' })
    return state
  }
  if (state.status === 'checking' || state.status === 'downloading') {
    return state
  }
  setState({ status: 'checking', error: undefined })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('[updater] checkForUpdates failed', err)
    setState({ status: 'error', error: message })
  }
  return state
}

/** 下载已发现的新版本（用户点"下载"按钮） */
export async function downloadUpdate(): Promise<UpdaterState> {
  if (state.status !== 'available') {
    log.warn('[updater] downloadUpdate called but status=', state.status)
    return state
  }
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('[updater] downloadUpdate failed', err)
    setState({ status: 'error', error: message })
  }
  return state
}

/** 立即退出并安装新版本 */
export function quitAndInstall(): void {
  if (state.status !== 'downloaded') {
    log.warn('[updater] quitAndInstall called but status=', state.status)
    return
  }
  // 第二个参数 forceRunAfter=true 让 isForceRunAfter 强制立即退出（不询问其它窗口）
  autoUpdater.quitAndInstall(true, true)
}

/** 取当前状态（供 IPC handler 返回） */
export function getUpdaterState(): UpdaterState {
  return { ...state }
}

/** 注册主窗口引用（占位：保留 API 兼容性，mainWindow 由调用方持有） */
export function setMainWindow(_win: BrowserWindow): void {
  // 当前实现下 emitToRenderers 已经覆盖所有 webContents（含主窗口），
  // 保留此函数便于将来要区分主窗口 vs DevTools 等场景扩展。
}
