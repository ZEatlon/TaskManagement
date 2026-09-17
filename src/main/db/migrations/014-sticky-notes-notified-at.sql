-- Migration 014 — 便签提醒派发追踪列
--
-- 背景：sticky-notes/notifier.ts（main 进程）需要每 30 秒扫描「due_at <= now
-- 且 archived = 0 且从未派发过系统通知」的便签，命中后弹通知 + 推 IPC，并把
-- notified_at 写为派发时间，避免下次扫描重复弹出（替代之前依赖 notifications
-- 表 UNIQUE(task_id, type, fired_date) 的方案——这套方案对「用户编辑后再次
-- 到期」的语义不够友好）。
--
-- 设计要点：
--   - 列：notified_at TEXT DEFAULT NULL；NULL 表示「这条 sticky 当前没有
--     待发的提醒」（已派发 = 列非空）
--   - 索引：idx_sticky_notes_due_pending —— 只索引 notified_at IS NULL 的行
--     （partial index），让扫描走覆盖索引而不是全表扫。已派发的 sticky 不进
--     索引，体量随已通知的 sticky 增长保持稳定。
--   - 跨天重新到期：用户在编辑 modal 把 notified_at 显式置 NULL（或直接
--     重新设置 due_at）后，下一轮扫描会再次命中。这条留给上层编辑器处理，
--     本迁移只搭骨架。

ALTER TABLE sticky_notes ADD COLUMN notified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_sticky_notes_due_pending
  ON sticky_notes(due_at)
  WHERE notified_at IS NULL;

-- R-fix-migration-014-notification-flood (HIGH correctness)：
-- ADD COLUMN 默认 NULL。已存在的 sticky_notes 行（含 archived=0 且
-- due_at <= now 的过期便签）现在 notified_at = NULL → notifier.ts
-- fetchDueRows 的 WHERE notified_at IS NULL 全命中 → 升级后 30s 内
-- 一次性向用户弹 N 条系统通知，N = 历史所有「未归档 + 已到期」便签。
-- 已派发语义本应是「这一会话里真正弹过通知」，升级从 0.8.x 跳到本版
-- 的用户显然不期望收到批量旧通知。
--
-- 修复：对所有 due_at NOT NULL 的现有 sticky 反向回填 notified_at
-- = '1970-01-01T00:00:00.000Z' 作为「迁移前已存在、未真正派发过」
-- 的 sentinel。notifier 的 WHERE notified_at IS NULL 过滤会把这些行
-- 跳过；用户主动编辑（清 notified_at / 重设 due_at）后仍可正常触发
-- 新提醒。'1970-01-01' 远早于任何真实派发时间，UI 上读 notified_at
-- 时能通过 "1970-01-01" 直接识别这是 sentinel（与 stickyNotes.ts
-- 里的 `displayNotifiedAt` 行为互不干扰）。
UPDATE sticky_notes
SET notified_at = '1970-01-01T00:00:00.000Z'
WHERE due_at IS NOT NULL
  AND notified_at IS NULL;