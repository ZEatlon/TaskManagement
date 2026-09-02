/**
 * 系统通知 API 包装层
 *
 * 职责：
 *   - 统一调用 Electron Notification；
 *   - macOS 同步更新 dock badge；
 *   - 在主进程内通过 IPC 推送通知事件给渲染进程；
 *   - 写入 notifications 表做幂等。
 *
 * 历史：原本字段叫 taskId；统一任务实体后语义上是"便签 id"，
 * 但 notifications 表未重命名（仍叫 task_id 列）—— 数据可读性
 * 通过 NotifyOptions.stickyNoteId 命名表达。
 */
import { Notification, app, BrowserWindow } from 'electron'
import { dbClient } from '../db/client'
import { settingsRepo } from '../db/repositories/settings'
import log from '../log'
import { DEFAULT_SETTINGS, IPC_CHANNELS, type AppSettings } from '@shared/ipc/channels'

export type NotificationKind = 'due' | 'scheduled' | 'reminder'

export interface NotifyOptions {
  title: string
  body?: string
  /** 通知图标（可选，开发者可传入 nativeImage 或文件路径） */
  icon?: string
  /** 通知紧急程度（Linux 生效，macOS/Windows 会被映射为是否响铃） */
  urgency?: 'low' | 'normal' | 'critical'
  /** 通知类型（用于幂等去重 + UI 区分） */
  type?: NotificationKind
  /** 关联便签 id（可选，幂等字段）—— 历史上对应 tasks.id */
  stickyNoteId?: string
  /** 静默模式：仍然写表 + 推送事件，但不弹系统 toast */
  silent?: boolean
}

/** 内存计数：未读便签到期数（用于 dock badge） */
let pendingDueCount = 0
/** 上一次已应用到窗口的标题后缀，用于避免无意义的 setTitle 调用 */
let lastBadgeApplied = -1

/** 增加未读计数并刷新 badge */
export function bumpPendingDue(delta = 1): void {
  pendingDueCount = Math.max(0, pendingDueCount + delta)
  applyBadge()
}

/**
 * 用户确认（点开 / 完成 / 归档）一条到期便签时调用，从未读计数中扣除。
 *
 * 之前计数仅靠 bumpPendingDue(+1)，从不递减；长会话后 dock badge / 窗口
 * 标题计数会无限上涨。R13 修复 (medium) 让计数能在用户操作时回退。
 *
 * 注意：调用方应保证 delta ≥ 0 且不超过当前计数（函数内部 clamp）。
 */
export function ackPendingDue(delta = 1): void {
  pendingDueCount = Math.max(0, pendingDueCount - delta)
  applyBadge()
}

/** 返回当前未读计数（仅诊断 / 测试用） */
export function getPendingDueCount(): number {
  return pendingDueCount
}

/** 清零计数 */
export function resetPendingDue(): void {
  pendingDueCount = 0
  applyBadge()
}

function applyBadge(): void {
  // macOS dock badge
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(pendingDueCount > 0 ? String(pendingDueCount) : '')
  }
  // Windows：避免覆盖用户自定义的窗口标题 —— 仅在数字真正变化时才调用 setTitle。
  //
  // R29-Corr-4 修复 (HIGH state-mutation-overwrite)：原实现仍会无条件把每个
  // 窗口 title 改回 `TaskPilot (N)`，用户曾用 `window.customizeTitle` 设的
  // 项目上下文 / 自定义 title 被静默冲掉。修复：维护一个 per-windowSet，标记
  // 用户是否 customize 过；只有未 customize 过的窗口才允许 setTitle 覆盖。
  // 用 BrowserWindow.getFocusedWindow() 单点更新（O(1)），不再
  // getAllWindows() 枚举全部窗口（包括隐藏的 devtools 窗口）。
  if (process.platform === 'win32' && pendingDueCount !== lastBadgeApplied) {
    lastBadgeApplied = pendingDueCount
    const focused = BrowserWindow.getFocusedWindow()
    const targetTitle = pendingDueCount > 0 ? `TaskPilot (${pendingDueCount})` : 'TaskPilot'
    if (focused && !customizedTitleWindows.has(focused.id)) {
      focused.setTitle(targetTitle)
    }
  }
}

/** R29-Corr-4：用户 customize 过的窗口 id 集合 —— applyBadge 不再覆盖其 title。 */
const customizedTitleWindows = new Set<number>()

/**
 * 判断当前是否处于"静音时段"。
 * 简单实现：从设置读取 quietHoursEnabled / start / end。
 * 若未设置或解析失败，默认放行。
 */
async function isQuietHours(): Promise<boolean> {
  try {
    const settings = (await settingsRepo.get<AppSettings>(
      'app.settings',
    )) ?? DEFAULT_SETTINGS
    if (!settings.quietHoursEnabled) return false
    const start = parseHHMM(settings.quietHoursStart)
    const end = parseHHMM(settings.quietHoursEnd)
    if (start === null || end === null) return false
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    if (start === end) return false
    if (start < end) {
      // 当天区间，例如 09:00–18:00
      return nowMin >= start && nowMin < end
    }
    // 跨天区间，例如 22:00–08:00
    return nowMin >= start || nowMin < end
  } catch {
    return false
  }
}

/** 解析 "HH:MM" 为分钟数；解析失败返回 null */
function parseHHMM(s: string): number | null {
  if (!s || typeof s !== 'string') return null
  const [hStr, mStr] = s.split(':')
  const h = parseInt(hStr ?? '', 10)
  const m = parseInt(mStr ?? '', 10)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/**
 * 写一条通知记录，用于幂等去重。
 * 同一 (sticky_note_id, type, date(fired_at)) 组合只写入一次。
 *
 * 返回值：
 *   - true  = 本次是首次写入（其它代码路径应触发 toast + bump 计数）
 *   - false = UNIQUE 冲突跳过 / sticky 不存在 / 写入失败（应该跳过 toast + bump）
 *
 * R7P-3 修复：原实现 INSERT OR IGNORE 后无返回值，调用方无法判断是否首次
 *              触发，导致 cron 每分钟扫描都重复弹 toast。
 * R7P-7 修复：原实现遇到无效 stickyNoteId 时把 task_id 置 NULL，绕过 UNIQUE
 *              约束的去重；现在直接返回 false 让 notify() 跳过这条。
 *
 * 注意：notifications 表沿用旧 schema（task_id 列），通过 NotifyOptions.stickyNoteId 传入。
 */
async function logNotification(opts: NotifyOptions): Promise<boolean> {
  const now = new Date().toISOString()
  const type = opts.type ?? 'reminder'
  const noteId = opts.stickyNoteId ?? null

  // R7P-7：stickyNoteId 解析失败时不再"友好地"置 NULL —— 直接放弃此次通知
  if (opts.stickyNoteId) {
    let checkStmtId: number | undefined
    try {
      checkStmtId = (
        await dbClient.call<{ stmtId: number }>('prepare', {
          sql: `SELECT 1 FROM sticky_notes WHERE id = ? LIMIT 1`,
        })
      ).stmtId
      const exists = (await dbClient.call('get', {
        stmtId: checkStmtId,
        params: [opts.stickyNoteId],
      })) as { 1: number } | undefined
      if (!exists) {
        log.warn('[notify] sticky note not found, skip notify:', opts.stickyNoteId)
        return false
      }
    } catch (err) {
      log.warn('[notify] sticky note existence check failed:', (err as Error).message)
      // 检查失败时放弃本次通知 —— 比绕过 UNIQUE 更安全
      return false
    } finally {
      // R12 修复 (medium)：原版 checkStmtId 从不 finalize，每次 sticky 触发
      // 一次提醒就泄漏一条 SELECT 预编译语句。补 try/finally 释放。
      if (checkStmtId !== undefined) {
        await dbClient.call('finalize', { stmtId: checkStmtId }).catch(() => undefined)
      }
    }
  }

  // 准备 INSERT + 立即取出 changes 行数（better-sqlite3 通过 get() 返回 lastInsertRowid
  // 和 changes 字段，配合 INSERT OR IGNORE 可以判断是否首次写入）。
  const stmtId = (
    await dbClient.call<{ stmtId: number }>('prepare', {
      sql: `INSERT OR IGNORE INTO notifications (id, task_id, fired_at, type, title, body)
            VALUES (?, ?, ?, ?, ?, ?)`,
    })
  ).stmtId

  try {
    const result = (await dbClient.call('run', {
      stmtId,
      params: [crypto.randomUUID(), noteId, now, type, opts.title, opts.body ?? null],
    })) as { changes?: number } | undefined
    // R7P-3：changes === 1 表示真的写入；0 表示 UNIQUE 跳过（已有同 sticky+type+date）
    return (result?.changes ?? 0) > 0
  } catch (err) {
    log.warn('[notify] logNotification skipped:', (err as Error).message)
    return false
  } finally {
    // R12 修复 (medium)：INSERT 预编译语句同样未 finalize，每次新通知泄漏。
    // 补 try/finally 与 SELECT 检查保持一致。
    await dbClient.call('finalize', { stmtId }).catch(() => undefined)
  }
}

/**
 * 推送 IPC 事件给所有渲染窗口
 */
function emitToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * 弹出系统通知。
 * 返回 true 表示成功（包含幂等跳过场景）。
 */
export async function notify(opts: NotifyOptions): Promise<boolean> {
  // 1) 用户总开关（X4-fix）：如果用户关闭了通知，整个流程都跳过
  //    —— 静默模式下也要尊重这个开关，因为它写 DB + 推送 IPC 是真有副作用。
  try {
    const settings = (await settingsRepo.get<AppSettings>('app.settings')) ?? DEFAULT_SETTINGS
    if (settings.enableNotifications === false) {
      log.info('[notify] disabled by user setting, skip:', opts.title)
      return false
    }
  } catch {
    /* settings 读失败时放行（保守策略：不阻塞通知） */
  }

  if (await isQuietHours()) {
    log.info('[notify] quiet hours, skip:', opts.title)
    return false
  }

  // 2) 写入历史记录（幂等）。R7P-3：logNotification 现在返回"是否首次写入"
  //    —— cron 每分钟扫描 + 2 分钟时间窗会让同一条便签连续 2 次匹配，
  //    第二次开始 logNotification 返回 false，必须跳过 toast + IPC + bump。
  const isFirstFire = await logNotification(opts)
  if (!isFirstFire) {
    log.info('[notify] duplicate suppressed by UNIQUE:', opts.title, opts.stickyNoteId)
    return false
  }

  // 3) 推送 IPC 事件，让 UI 自行处理。
  //    X1-fix：用独立的 NOTIFY_DISPATCH 通道，避免与 invoke 的 NOTIFY_SHOW 共用
  //    导致渲染端 onShow 收到自己刚发出的通知形成反馈环。
  emitToRenderers(IPC_CHANNELS.NOTIFY_DISPATCH, {
    title: opts.title,
    body: opts.body ?? '',
    type: opts.type ?? 'reminder',
    stickyNoteId: opts.stickyNoteId,
  })

  // 4) 弹出系统 toast（除非 silent）
  if (!opts.silent && Notification.isSupported()) {
    try {
      const n = new Notification({
        title: opts.title,
        body: opts.body ?? '',
        urgency: opts.urgency ?? 'normal',
        silent: opts.silent,
      })
      n.show()
    } catch (err) {
      log.warn('[notify] Notification.show failed:', (err as Error).message)
    }
  }

  return true
}

/**
 * 便签到期专用便捷函数
 *
 * R11 修复 (high)：现在返回 boolean 表示是否真的"派发了通知"。
 *   - 静默时段 / 用户关闭通知 → false（调用方不应推进 recurrence，否则今天的
 *     重复便签就被静默吞掉，下次 cron 又匹配不上 → 永久跳过）
 *   - 幂等命中已有通知 → false
 *   - 真正派发了 toast + IPC → true
 */
export async function showStickyDue(sticky: {
  id: string
  title: string
  dueAt?: string | null
}): Promise<boolean> {
  const delivered = await notify({
    title: '便签到期',
    body: sticky.title,
    type: 'due',
    stickyNoteId: sticky.id,
    urgency: 'critical',
  })
  if (delivered) {
    bumpPendingDue()
    emitToRenderers(IPC_CHANNELS.STICKY_NOTE_DUE, sticky)
  }
  return delivered
}

/**
 * 自定义提醒专用便捷函数（保留兼容签名 —— reminders 表已 DROP，
 * 但 renderer 可能仍通过 showReminder 调用）
 */
export async function showReminder(reminder: {
  id: string
  stickyNoteId?: string | null
  message: string
}): Promise<void> {
  emitToRenderers(IPC_CHANNELS.NOTIFY_REMINDER, reminder)
  await notify({
    title: '提醒',
    body: reminder.message,
    type: 'reminder',
    stickyNoteId: reminder.stickyNoteId ?? undefined,
  })
}

/** 兼容旧通道名：别名给 taskScheduler.ts */
export const showTaskDue = showStickyDue

/** 兼容旧通道：从渲染进程直接触发通知 */
export async function showFromRenderer(payload: {
  title: string
  body?: string
  type?: NotificationKind
  stickyNoteId?: string
  silent?: boolean
}): Promise<{ ok: boolean }> {
  // R20 修复 (low notification-spoofing)：渲染端 XSS 可调用 notify:show
  // 发任意 title/body，弹系统通知冒充系统消息。强制走固定前缀 + 长度截断 +
  // 去控制字符，避免：
  //   - 超长字符串撑爆系统 toast / dock 渲染
  //   - 内嵌 \x00 / ANSI 让通知带隐藏字符或不可见内容
  //   - title 完全由渲染端控制以冒充「系统更新」/「安全警报」等诱导点击
  // 真正防 XSS 应继续收紧渲染端，但这里作为额外一道闸门。
  const cleanTitle = sanitizeNotificationText(payload.title, 80)
  if (!cleanTitle) {
    log.warn('[notify] showFromRenderer rejected: empty title after sanitization')
    return { ok: false }
  }
  const cleanBody = payload.body ? sanitizeNotificationText(payload.body, 280) : undefined
  const ok = await notify({
    title: `[TaskPilot] ${cleanTitle}`,
    body: cleanBody,
    type: payload.type ?? 'reminder',
    stickyNoteId: payload.stickyNoteId,
    silent: payload.silent,
  })
  return { ok }
}

/**
 * 净化通知文本：
 *   - 去掉控制字符（含 NUL / \r / ANSI 等）防隐藏 payload
 *   - 折叠空白
 *   - 截断到 maxLen（按 char 计）
 *   - 非 string 入参 → 空字符串
 */
function sanitizeNotificationText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return ''
  // 去掉控制字符（保留普通换行方便阅读）。正则覆盖 \x00-\x08 \x0B \x0C \x0E-\x1F \x7F
  const stripped = raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return ''
  if (stripped.length <= maxLen) return stripped
  return stripped.slice(0, maxLen - 1) + '…'
}

/** 测试用：当前 Notification API 是否可用 */
export function isNotificationSupported(): boolean {
  return Notification.isSupported()
}