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
import { prepareCached } from '../db/cachedStmt'
import { dbClient } from '../db/client'
import { settingsRepo } from '../db/repositories/settings'
import { emitToRenderers } from '../ipc/emit'
import log from '../log'
import { DEFAULT_SETTINGS, IPC_CHANNELS, type AppSettings } from '@shared/ipc/channels'
import { getNotificationMessages } from '@shared/i18n/locales'

export type NotificationKind = 'due' | 'scheduled' | 'reminder'

/**
 * R35-Corr-1 修复 (low defense-in-depth)：渲染端入参 `type` 的运行时白名单。
 *
 * 背景：`showFromRenderer(payload)` 接 `payload.type: NotificationKind`，
 * TypeScript 只是编译期装饰 —— IPC structured-clone 跨信任边界（被攻渲染
 * 端 / devtools / 落后 schema 的旧渲染端 / 旁路 preload）可注入任意 string /
 * number / object。被攻渲染端就能 `notify:show({ type: '' })` 让
 * notifications 表里写入 `type=''`，与 cron 的 `type='due'` 走不同
 * UNIQUE (task_id, type, date) 键 → 同一便签到期被重复提醒；或注入
 * `type='system_update'` 等伪装成系统消息污染 type 列。
 *
 * 修复：与 sticky-note-handlers ALLOWED_STATUS / ALLOWED_PRIORITY 对齐，
 * 在 IPC 边界把 `payload.type` 钳到白名单内（不在白名单 → 退化为默认
 * 'reminder'），不让攻击者控制的字符串进入 notify() → logNotification
 * → INSERT / NOTIFY_DISPATCH 全链路。
 *
 * 注意：保持向后兼容 —— 已有 `due | scheduled | reminder` 三个值全部
 * 放行；只是钳掉非法值，不抛错（与 sticky-note-handlers 抛错风格不同，
 * 因为这里是低危路径，宽容处理不会污染数据）。
 */
const ALLOWED_NOTIFY_TYPES: ReadonlySet<NotificationKind> = new Set([
  'due',
  'scheduled',
  'reminder',
])

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

/**
 * 增加未读计数并刷新 badge。
 *
 * R36-Corr-1 (low notification-ux-consistency)：语义是"用户经任意渠道能感知
 * 到的未读到期数"。即便系统 toast 被组策略关闭（Notification.isSupported
 * 返 false）或 n.show() 抛错，渲染端 NOTIFY_DISPATCH 仍会显示 in-app banner
 * —— 这种情况下仍应 bump，因为用户能看到。dock badge 与 in-app banner 反映
 * 的都是"有未读"，用户从哪条渠道感知并不影响计数。
 */
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
  // R32-Corr-X 修复 (medium)：之前 `lastBadgeApplied` 在 setTitle 前就无条件
  // 推进，导致窗口失焦 / 最小化 / Linux 无 WM focus 时 badge 永远丢失，且
  // 下一次 bump 也不会重试。现在仅在 setTitle 真正落到可见窗口时才推进
  // lastBadgeApplied；并通过 app.on('browser-window-focus') 在窗口重新获焦
  // 时重跑 applyBadge 把挂起的 badge 补上。
  if (process.platform === 'win32' && pendingDueCount !== lastBadgeApplied) {
    const targetTitle = pendingDueCount > 0 ? `TaskPilot (${pendingDueCount})` : 'TaskPilot'
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) {
      focused.setTitle(targetTitle)
      lastBadgeApplied = pendingDueCount
    }
    // else: 当前没有可写的可见窗口 —— 保持 lastBadgeApplied 不变，等
    // 浏览器/窗口拿到 focus 时由 listener 重跑 applyBadge。
  }
}

// R32-Corr-X：窗口重新获焦时补上挂起的 badge。注册一次（模块单例）。
app.on('browser-window-focus', () => {
  applyBadge()
})

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
 * 返回值（discriminated union）—— 通知写库的所有可能结局：
 *   - { kind: 'inserted' }  本次是首次写入（其它代码路径应触发 toast + bump 计数）
 *   - { kind: 'duplicate' } UNIQUE 冲突跳过（已有同 sticky+type+date）—— 应跳过
 *                          toast + bump，保持幂等
 *   - { kind: 'db-error', message } 真正的写库失败（SQLITE_FULL 磁盘满 /
 *                          SQLITE_BUSY 事务争用 / schema 漂移导致
 *                          no such column 等）—— 通知历史落不下，
 *                          调用方应 log.error + 走 NOTIFY_PERSIST_FAILED
 *                          让用户看到一次性 sticky diagnostic
 *
 * R7P-3 修复：原实现 INSERT OR IGNORE 后无返回值，调用方无法判断是否首次
 *              触发，导致 cron 每分钟扫描都重复弹 toast。
 * R7P-7 修复：原实现遇到无效 stickyNoteId 时把 task_id 置 NULL，绕过 UNIQUE
 *              约束的去重；现在直接走 db-error 让 notify() 跳过这条。
 * R-fix-notify-persist-failed (medium silent-error)：原版把所有失败（UNIQUE
 *              跳过 / sticky 不存在 / 写库抛错）坍缩为 boolean false，
 *              写库抛错被误标为「duplicate suppressed by UNIQUE」。
 *              拆成 discriminated union 后，调用方可以单独 log.error
 *              写库错误并派发 NOTIFY_PERSIST_FAILED。
 *
 * 注意：notifications 表沿用旧 schema（task_id 列），通过 NotifyOptions.stickyNoteId 传入。
 */
type LogNotificationOutcome =
  | { kind: 'inserted' }
  | { kind: 'duplicate' }
  | { kind: 'db-error'; message: string }

async function logNotification(opts: NotifyOptions): Promise<LogNotificationOutcome> {
  const now = new Date().toISOString()
  const type = opts.type ?? 'reminder'
  const noteId = opts.stickyNoteId ?? null

  // R7P-7：stickyNoteId 解析失败时不再"友好地"置 NULL —— 直接放弃此次通知
  if (opts.stickyNoteId) {
    try {
      // R-fix-notify-prepared-roundtrip (high sql-n+1)：原本每次 notify 都
      // 走 dbClient.call('prepare', ...) IPC + finalize。cron 30s tick +
      // 多 sticky 同分钟到期 → N×2 次 prepare+finalize IPC，await finalize
      // 还阻塞 notify 链路放大 in-app banner 延迟。改为走共享 prepareCached：
      // 首次 miss 走 IPC，命中缓存零 IPC；stmtId 是跨调用方共享的，不能
      // finalize（worker respawn 时 dbClient 自动广播 invalidate 清缓存）。
      const checkStmtId = await prepareCached(
        `SELECT 1 FROM sticky_notes WHERE id = ? LIMIT 1`,
      )
      const exists = (await dbClient.call('get', {
        stmtId: checkStmtId,
        params: [opts.stickyNoteId],
      })) as { 1: number } | undefined
      if (!exists) {
        log.warn('[notify] sticky note not found, skip notify:', opts.stickyNoteId)
        // sticky 不存在 —— 跟 db-error 同类（写不进去），也归到 db-error 让
        // 渲染端知情（不过这条比较常见，是数据一致性问题不是数据库问题，
        // reason 字符串里带 stickyNoteId 方便排查）。
        return { kind: 'db-error', message: `sticky note not found: ${opts.stickyNoteId}` }
      }
    } catch (err) {
      // R-fix-notify-persist-failed：检查阶段抛错（schema 漂移 / worker 故障）
      // 也归 db-error，不要静默吞。原版这里 return false 跟 UNIQUE 跳过混在一起。
      log.warn('[notify] sticky note existence check failed:', (err as Error).message)
      return { kind: 'db-error', message: `sticky note existence check failed: ${(err as Error).message}` }
    }
  }

  // 准备 INSERT + 立即取出 changes 行数（better-sqlite3 通过 get() 返回 lastInsertRowid
  // 和 changes 字段，配合 INSERT OR IGNORE 可以判断是否首次写入）。
  //
  // R-fix-notify-prepared-roundtrip：同上，INSERT 走 prepareCached，零 IPC 命中
  // 后不再 finalize，notify 链路不被 prepare/finalize 序列化阻塞。
  const stmtId = await prepareCached(
    `INSERT OR IGNORE INTO notifications (id, task_id, fired_at, type, title, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  try {
    const result = (await dbClient.call('run', {
      stmtId,
      params: [crypto.randomUUID(), noteId, now, type, opts.title, opts.body ?? null],
    })) as { changes?: number } | undefined
    // R7P-3：changes === 1 表示真的写入；0 表示 UNIQUE 跳过（已有同 sticky+type+date）
    if ((result?.changes ?? 0) > 0) return { kind: 'inserted' }
    return { kind: 'duplicate' }
  } catch (err) {
    // R-fix-notify-persist-failed：原版这里 log.warn + return false，跟
    // duplicate 坍缩 —— 调用方误标为「duplicate suppressed by UNIQUE」。
    // 改回 log.warn（保留告警级别；升级到 error 在 notify() 那一层做，
    // 避免双重打印），并把 message 通过 outcome 透传给调用方。
    log.warn('[notify] logNotification INSERT failed:', (err as Error).message)
    return { kind: 'db-error', message: (err as Error).message }
  }
}

/** 推送 IPC 事件给所有渲染窗口 —— 统一走 src/main/ipc/emit.ts，本地不再定义 */

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
  //    第二次开始 logNotification 走 'duplicate' 分支，必须跳过 toast + IPC + bump。
  //
  //    R-fix-notify-persist-failed (medium silent-error)：原版坍缩 boolean
  //    把 INSERT 失败标为「duplicate suppressed by UNIQUE」。现在 logNotification
  //    返回 discriminated union：duplicate / db-error 各自走不同分支。
  //    db-error 走 log.error + NOTIFY_PERSIST_FAILED 让渲染端能贴一条
  //    一次性 sticky diagnostic（"通知写入失败：<reason>"）给用户看。
  const outcome = await logNotification(opts)
  if (outcome.kind === 'duplicate') {
    log.info('[notify] duplicate suppressed by UNIQUE:', opts.title, opts.stickyNoteId)
    return false
  }
  if (outcome.kind === 'db-error') {
    log.error(
      '[notify] logNotification failed (skipping toast/IPC/bump):',
      outcome.message,
      'title=',
      opts.title,
      'stickyNoteId=',
      opts.stickyNoteId,
    )
    emitToRenderers(IPC_CHANNELS.NOTIFY_PERSIST_FAILED, {
      title: opts.title,
      stickyNoteId: opts.stickyNoteId,
      reason: outcome.message,
    })
    return false
  }
  // outcome.kind === 'inserted' —— 继续走系统 toast + IPC 派发 + bump

  // 3) 弹出系统 toast（除非 silent）—— 先尝试系统 toast，再推 IPC。
  //    这样如果系统 toast 抛错，下面的 IPC 推送已经发生（IPC 是 fire-and-forget，
  //    失败也是下一次 tick 才暴露），pendingDue 是否 bump 完全由调用方基于
  //    notify() 的返回值决定；不会因为 Notification.show 抛错而漏触发 IPC。
  //
  //    R36-Corr-1 修复 (low notification-ux-consistency)：原顺序是先 emit IPC
  //    再尝试系统 toast。若 isSupported() === false（Linux 无 libnotify /
  //    Windows toast 被组策略关闭 / macOS 通知权限被拒）或 n.show() 抛错，
  //    IPC 已经派发但用户拿不到系统 toast —— pendingDue 仍然 bump 反映
  //    "有未读到期"，但 dock badge 不会反映用户的真实体感（无 toast）。
  //    改为先尝试系统 toast 是为了"失败时序"的清晰：抛错只影响本 toast，
  //    不污染 IPC / bump / STICKY_NOTE_DUE 的派发链。
  //
  //    注意：pendingDue 语义是"用户经任意渠道能看到"，所以即便系统 toast
  //    失败，渲染端的 NOTIFY_DISPATCH 仍会显示 in-app banner —— 调用方
  //    仍应 bump（这是有意的设计，不算 bug）。
  if (!opts.silent) {
    if (Notification.isSupported()) {
      try {
        const n = new Notification({
          title: opts.title,
          body: opts.body ?? '',
          urgency: opts.urgency ?? 'normal',
          silent: opts.silent,
        })
        n.show()
      } catch (err) {
        // R36-Corr-1：记一条 warn 但不 throw —— 失败只影响系统 toast 这一个
        // 渠道，in-app banner 仍会通过下面的 NOTIFY_DISPATCH 派发。
        // R-fix-notify-toast-failed (medium silent-error)：原版只 log.warn，
        // 用户报「我看不到通知」时排查无据。补一条 NOTIFY_TOAST_FAILED
        // IPC 让渲染端写进诊断 bundle —— 不弹 toast（in-app banner 已经会
        // 走 NOTIFY_DISPATCH 了），纯支持 bundle 用。
        const reason = (err as Error).message
        log.warn('[notify] Notification.show failed:', reason)
        emitToRenderers(IPC_CHANNELS.NOTIFY_TOAST_FAILED, {
          title: opts.title,
          reason,
        })
      }
    } else {
      log.info('[notify] Notification not supported by OS, in-app banner only:', opts.title)
    }
  }

  // 4) 推送 IPC 事件，让 UI 自行处理。
  //    X1-fix：用独立的 NOTIFY_DISPATCH 通道，避免与 invoke 的 NOTIFY_SHOW 共用
  //    导致渲染端 onShow 收到自己刚发出的通知形成反馈环。
  emitToRenderers(IPC_CHANNELS.NOTIFY_DISPATCH, {
    title: opts.title,
    body: opts.body ?? '',
    type: opts.type ?? 'reminder',
    stickyNoteId: opts.stickyNoteId,
  })

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
 *
 * R-fix-i18n-notification-toast (high)：title 改走 getNotificationMessages()，
 * 从 settings 读当前 locale 后查字典；缺设置 / 读失败 → 回退默认 locale
 * （与 toLocaleValue() 一致），不会让 cron 在 settings 未初始化时炸出英文
 * （或任何非 zh-CN）toast。
 */
export async function showStickyDue(sticky: {
  id: string
  title: string
  dueAt?: string | null
}): Promise<boolean> {
  const messages = await resolveNotificationMessages()
  const delivered = await notify({
    title: messages.stickyDueTitle,
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
 *
 * R-fix-i18n-notification-toast (high)：同 showStickyDue，title 改走
 * getNotificationMessages()，跟随 locale 切换。
 */
export async function showReminder(reminder: {
  id: string
  stickyNoteId?: string | null
  message: string
}): Promise<void> {
  const messages = await resolveNotificationMessages()
  emitToRenderers(IPC_CHANNELS.NOTIFY_REMINDER, reminder)
  await notify({
    title: messages.reminderTitle,
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
  // R35-Corr-1 (low defense-in-depth)：钳 type 到白名单内，防止攻击者控制的
  // 字符串污染 notifications.type 列 / NOTIFY_DISPATCH payload。非法值（含
  // '' / null / undefined / object）退化为默认 'reminder'，与下方
  // payload.type ?? 'reminder' 兜底对齐。
  const safeType: NotificationKind =
    payload.type && ALLOWED_NOTIFY_TYPES.has(payload.type) ? payload.type : 'reminder'
  // R-fix-i18n-notification-toast (high)：前缀也从 locale 字典查；不再硬编码
  // '[TaskPilot]'。settings 读失败 / 字段缺失 → 回退默认 locale（与
  // getNotificationMessages 内部 toLocaleValue 回退策略一致）。
  const messages = await resolveNotificationMessages()
  const ok = await notify({
    title: `${messages.rendererTitlePrefix} ${cleanTitle}`,
    body: cleanBody,
    type: safeType,
    stickyNoteId: payload.stickyNoteId,
    silent: payload.silent,
  })
  return { ok }
}

/**
 * 读取 settings 里的 language 并解析到 notification 文案字典。
 *
 * 提取成独立函数（而不是在 showStickyDue / showReminder / showFromRenderer
 * 三处重复 try/catch）的两点收益：
 *   1) 失败语义统一 —— 都用 toLocaleValue 回退默认 locale，调用方零分支
 *   2) 后续若需要把 language 缓存 / 监听 settings 变化（避免每次 cron tick
 *      都 await settingsRepo.get）只改这一处
 */
async function resolveNotificationMessages() {
  try {
    const settings = (await settingsRepo.get<AppSettings>('app.settings')) ?? DEFAULT_SETTINGS
    return getNotificationMessages(settings.language)
  } catch {
    // settings 读失败时按默认 locale 解析（getNotificationMessages 内部
    // 会走 toLocaleValue 回退到首个 locale，与缺省 / 损坏字段语义一致）。
    return getNotificationMessages(undefined)
  }
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