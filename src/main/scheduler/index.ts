/**
 * 调度器入口
 *
 * - startAll(): 数据库初始化完成后调用，启动便签到期 cron
 * - stopAll(): app.before-quit 中调用，停止所有 cron
 *
 * 历史上曾同时跑 task + reminder 两个 cron；统一任务 → sticky 后，
 * reminders 表已 DROP；到点通知由 taskScheduler 统一处理。
 */
import log from '../log'
import { startTaskScheduler, stopTaskScheduler, runOnce } from './taskScheduler'

let started = false

/**
 * 启动所有调度器。
 * 若数据库尚未就绪，函数会直接返回（避免 cron 读到空表）。
 */
export function startAll(): void {
  if (started) {
    log.warn('[scheduler] already started')
    return
  }
  started = true
  try {
    startTaskScheduler()
    log.info('[scheduler] sticky scheduler started')
  } catch (err) {
    log.error('[scheduler] startAll failed', err)
    started = false
    throw err
  }
}

/** 停止所有调度器 */
export function stopAll(): void {
  if (!started) return
  stopTaskScheduler()
  started = false
  log.info('[scheduler] sticky scheduler stopped')
}

/** 是否已启动 */
export function isStarted(): boolean {
  return started
}

/** 测试用：手动触发一次到期便签扫描 */
export async function triggerTaskScan(): Promise<{ hit: number }> {
  return runOnce()
}

/** @deprecated reminders 调度已合并入 sticky，到点通知由 taskScheduler 处理 */
export async function triggerReminderScan(): Promise<{ hit: number }> {
  return runOnce()
}
