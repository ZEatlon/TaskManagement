-- TaskPilot Migration 004: 任务 / 便签统一
--
-- 背景：
--   旧 tasks 表承担了「任务」的全部职能，但 sticky_notes 已经完整覆盖
--   「一组任务 + 多步骤」场景。本迁移把 tasks 体系彻底删除，把能力合入 sticky_notes。
--
-- 用户决策：清空旧 tasks / subtasks / attachments / reminders 数据，不迁移历史。
--
-- 设计要点：
--   - sticky_notes 新增 13 字段（覆盖原 tasks 表全部字段 + 用户偏好 color）
--   - subtasks / attachments / reminders：删除（功能已被 sticky_notes.steps 替代）
--   - tasks：删除主表
--   - completions / pomodoros：保留并重命名 task_id → sticky_note_id
--     （重建表：SQLite ALTER TABLE 不能保留 FK 约束，需要重建）
--     旧 task_id 历史数据全部置为 NULL（用户已授权清空）
--   - notifications 表不动（只是历史日志，未来不被新代码写入）

PRAGMA foreign_keys = ON;

-- ============== 1. 先 DROP 依赖 tasks 的子表 ==============
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS subtasks;

-- ============== 2. 重建 completions：task_id → sticky_note_id ==============
-- 由于 SQLite ALTER TABLE RENAME COLUMN 不更新 FK 约束，且旧 task_id 行无意义
-- （用户授权清空），用「复制到新表 → DROP 旧表 → RENAME」的方式重建。
-- 新增 UNIQUE(sticky_note_id, date) —— 实现「同一天多次完成只算 1 次」的幂等去重。
CREATE TABLE IF NOT EXISTS completions_new (
  id             TEXT PRIMARY KEY,
  sticky_note_id TEXT,
  date           TEXT NOT NULL,
  count          INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  UNIQUE(sticky_note_id, date)
);
INSERT INTO completions_new (id, sticky_note_id, date, count, created_at)
  SELECT id, NULL, date, count, created_at FROM completions;
DROP TABLE completions;
ALTER TABLE completions_new RENAME TO completions;
CREATE INDEX IF NOT EXISTS idx_completions_date      ON completions(date);
CREATE INDEX IF NOT EXISTS idx_completions_note_id   ON completions(sticky_note_id);

-- ============== 3. 重建 pomodoros：task_id → sticky_note_id ==============
CREATE TABLE IF NOT EXISTS pomodoros_new (
  id             TEXT PRIMARY KEY,
  sticky_note_id TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  duration_min   INTEGER,
  completed      INTEGER NOT NULL DEFAULT 0
);
INSERT INTO pomodoros_new (id, sticky_note_id, started_at, ended_at, duration_min, completed)
  SELECT id, NULL, started_at, ended_at, duration_min, completed FROM pomodoros;
DROP TABLE pomodoros;
ALTER TABLE pomodoros_new RENAME TO pomodoros;
CREATE INDEX IF NOT EXISTS idx_pomodoros_started     ON pomodoros(started_at);
CREATE INDEX IF NOT EXISTS idx_pomodoros_note_id     ON pomodoros(sticky_note_id);

-- ============== 4. DROP 旧 tasks 主表 ==============
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_tasks_priority;
DROP INDEX IF EXISTS idx_tasks_due_at;
DROP INDEX IF EXISTS idx_tasks_scheduled_at;
DROP INDEX IF EXISTS idx_tasks_archived;
DROP TABLE IF EXISTS tasks;

-- ============== 5. 扩展 sticky_notes：13 新字段 ==============
ALTER TABLE sticky_notes ADD COLUMN description         TEXT;
ALTER TABLE sticky_notes ADD COLUMN status              TEXT NOT NULL DEFAULT 'todo';
ALTER TABLE sticky_notes ADD COLUMN scheduled_at        TEXT;
ALTER TABLE sticky_notes ADD COLUMN due_at              TEXT;
ALTER TABLE sticky_notes ADD COLUMN completed_at        TEXT;
ALTER TABLE sticky_notes ADD COLUMN tags_json           TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sticky_notes ADD COLUMN color               TEXT;
ALTER TABLE sticky_notes ADD COLUMN recurrence          TEXT;
ALTER TABLE sticky_notes ADD COLUMN estimated_minutes   INTEGER;
ALTER TABLE sticky_notes ADD COLUMN actual_minutes      INTEGER;
ALTER TABLE sticky_notes ADD COLUMN pomodoro_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticky_notes ADD COLUMN starred             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticky_notes ADD COLUMN archived            INTEGER NOT NULL DEFAULT 0;

-- ============== 6. 新索引 ==============
CREATE INDEX IF NOT EXISTS idx_sticky_notes_status       ON sticky_notes(status);
CREATE INDEX IF NOT EXISTS idx_sticky_notes_due_at       ON sticky_notes(due_at);
CREATE INDEX IF NOT EXISTS idx_sticky_notes_scheduled_at ON sticky_notes(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sticky_notes_archived     ON sticky_notes(archived);
CREATE INDEX IF NOT EXISTS idx_sticky_notes_starred      ON sticky_notes(starred);