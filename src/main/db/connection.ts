/**
 * 数据库连接管理（高级 API）
 *
 * - init(): 启动 worker, 打开数据库文件, 运行迁移
 * - getDb(): 获取数据库访问接口
 * - close(): 关闭
 */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { app } from 'electron'
import { dbClient } from './client'
import { runMigrations, getCurrentVersion } from './migrate'
import log from '../log'
import type { DbStatus } from '@shared/types'
import { notesManager } from '../notes/notesManager'
import { getCurrentLibrary } from '../lib/libraryManager'

export function getDatabasePath(): string {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  return join(userData, 'taskpilot.db')
}

let initialized = false
let initPromise: Promise<void> | null = null

/**
 * 初始化数据库连接
 * - 启动 sidecar worker
 * - 打开 DB 文件
 * - 运行待执行的迁移
 */
export async function initDatabase(): Promise<void> {
  if (initialized) return
  if (initPromise) return initPromise

  // 同步设置 in-flight promise：关闭 "guard 之后才设 flag" 的竞态窗口
  initPromise = (async () => {
    log.info('[db] initializing...')
    await dbClient.start()

    const dbPath = getDatabasePath()
    log.info(`[db] opening ${dbPath}`)
    await dbClient.call('open', { filePath: dbPath })

    await runMigrations()
    initialized = true
    log.info('[db] ready')

    // 模块 4 笔记库：DB 就绪后尝试启动监听与首次 hydration
    // 不阻塞启动：失败仅记录警告
    try {
      const lib = await getCurrentLibrary()
      if (lib) {
        // 异步触发，不 await（避免拖慢启动）
        notesManager.startWatching().catch((err) => {
          log.warn('[db] notes watcher startup failed', err)
        })
      }
    } catch (err) {
      log.warn('[db] notes watcher init skipped', err)
    }
  })()

  try {
    await initPromise
  } finally {
    initPromise = null
  }
}

export async function closeDatabase(): Promise<void> {
  if (!initialized) return
  try {
    await dbClient.call('close', {})
  } catch (err) {
    log.warn('[db] close error', err)
  }
  await dbClient.stop()
  initialized = false
}

/**
 * 数据库状态（用于 IPC 调试 / 设置页）
 */
export async function getStatus(): Promise<DbStatus> {
  if (!initialized) {
    return { initialized: false, version: 0, path: getDatabasePath(), sizeBytes: 0 }
  }
  const stats = (await dbClient.call<{ sizeBytes: number }>('stats', {})) ?? {
    sizeBytes: 0,
  }
  return {
    initialized: true,
    version: await getCurrentVersion(),
    path: getDatabasePath(),
    sizeBytes: stats.sizeBytes,
  }
}

/** 数据库访问接口 */
export const db = {
  isReady: () => initialized,
  client: dbClient,
}