/**
 * 完成日志 IPC 处理器（用于热力图）
 *
 * 历史：原本字段叫 taskId；统一任务实体后语义上是"便签 id"。
 *
 * R29-DI-3 修复 (CRITICAL invariant-violation)：原 completion:record IPC
 * 直接调 completionsRepo.record(stickyNoteId, date, count)，**完全绕过**
 * sticky 存在性 / status / archived 校验。被 XSS 控制的渲染端可对已取消
 * 或已归档的便签批量灌入 completion 行，污染热力图（违反「status=done iff
 * completed_at NOT NULL」核心不变式）。修复：当 stickyNoteId 非 null 时，
 * 改走 stickyNotesRepo.recordCompletion(其内部 SELECT 校验 status /
 * archived，已 R27-DI-10 加 status='cancelled' 守卫、R28-DI-2 加
 * validateDayKey 守卫)；null 路径保留 completionsRepo.record (系统级聚合，
 * 不绑定具体便签)。同时对 count 做 Math.max(1, count) 防御负数(热力图
 * SUM 溢出保护)。
 */
import { handle } from './channels'
import { completionsRepo, noteEventsRepo } from '../db/repositories/completions'
import { stickyNotesRepo } from '../db/repositories/stickyNotes'
import { runAllBackfills } from '../db/backfill'

export function registerCompletionHandlers(): void {
  handle('completion:record', async (_e, args: { stickyNoteId: string | null; date: string; count?: number }) => {
    const safeCount = Math.max(1, Math.floor(args.count ?? 1))
    if (args.stickyNoteId) {
      // 走粘性仓库的高层 API —— 拒 cancelled / archived / missing sticky，
      // 让热力图统计与 UI 可见状态保持一致。
      await stickyNotesRepo.recordCompletion(args.stickyNoteId, args.date)
      return { ok: true, count: 1, stickyNoteId: args.stickyNoteId, date: args.date }
    }
    // 系统级聚合路径 (stickyNoteId = null) —— 仍走 completionsRepo 直接
    // INSERT，保留给「应用级里程碑」使用（不带 sticky 归属）。
    const result = await completionsRepo.record(null, args.date, safeCount)
    return { ok: true, ...result }
  })

  handle('completion:daily', async (_e, args: { startDate: string; endDate: string }) => {
    return completionsRepo.dailyCounts(args.startDate, args.endDate)
  })

  handle('completion:total', async (_e, args: { startDate: string; endDate: string }) => {
    return completionsRepo.totalInRange(args.startDate, args.endDate)
  })

  handle('note-event:record', async (_e, args: { noteId: string | null; date: string; type?: 'create' | 'edit' | 'delete' }) => {
    await noteEventsRepo.record(args.noteId, args.date, args.type ?? 'edit')
    return { ok: true }
  })

  handle('note-event:daily', async (_e, args: { startDate: string; endDate: string }) => {
    return noteEventsRepo.dailyCounts(args.startDate, args.endDate)
  })

  /** 手动触发历史回填（用于设置页） */
  handle('completion:backfill', async (_e, args: { force?: boolean } | undefined) => {
    const result = await runAllBackfills(args?.force ?? false)
    return result
  })
}