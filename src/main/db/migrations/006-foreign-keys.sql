-- Migration 006 — Foreign Key 补齐 + 索引优化
--
-- R8D-1：completions / pomodoros 的 sticky_note_id 列之前没有 FK 约束，
--        删除 sticky_note 会留下孤儿行（污染热力图聚合）。
-- R8D-2：notifications.task_id 历史字段，迁移后表 tasks 已不存在，
--        建议加 FK 到 sticky_notes(id)。但因列名是 task_id 加 FK 会让
--        历史 NULL 值被禁（completions 也是），先做孤儿清理 + 加 FK。
-- R8D-3：notes.folder_id 加 FK → note_folders(id) ON DELETE SET NULL。
-- R8D-7：pomodoros 把 date(started_at) 查询改成 started_at 范围查询可走索引。
--        增加复合索引 (date, priority) 服务 ORDER BY。
-- R8D-8：sticky_notes.priority 单列索引。

-- ===== 孤儿清理（FK 加上后 INSERT/UPDATE 不允许孤儿） =====
-- sticky_notes 已被物理删除的行：把对应 completions / pomodoros 行的 sticky_note_id 置 NULL
-- 这样历史 heatmap 数据不被破坏（仍按"日期 + sticky"统计），同时新 FK 可以接受 NULL。
UPDATE completions SET sticky_note_id = NULL
  WHERE sticky_note_id IS NOT NULL
    AND sticky_note_id NOT IN (SELECT id FROM sticky_notes);
UPDATE pomodoros SET sticky_note_id = NULL
  WHERE sticky_note_id IS NOT NULL
    AND sticky_note_id NOT IN (SELECT id FROM sticky_notes);
-- notifications.task_id 同理（先 NULL 化再加 FK，避免 FK 触发删除孤儿）
UPDATE notifications SET task_id = NULL
  WHERE task_id IS NOT NULL
    AND task_id NOT IN (SELECT id FROM sticky_notes);
-- notes.folder_id 同理
UPDATE notes SET folder_id = NULL
  WHERE folder_id IS NOT NULL
    AND folder_id NOT IN (SELECT id FROM note_folders);

-- ===== 重建带 FK 的表 =====
-- SQLite ALTER TABLE 不能直接加 FK 到已有列，所以采用 5 步法：
--   CREATE TABLE _new (...含 FK...) → INSERT SELECT → DROP 旧表 → RENAME → recreate indexes
-- 但更稳妥的做法：用 NOT NULL 触发器无法做，只能用 NOT VALID 风格的"半 FK"（SQLite 不支持）。
-- 退而求其次：把 FK 写到 _new 表里，让 PRAGMA foreign_keys=ON 生效。

-- completions：原本已有 UNIQUE(sticky_note_id, date) — 注意 NULL 在 UNIQUE 里被视作 distinct，
-- 因此多个 NULL sticky_note_id 可以共存（不同 sticky 删除后的孤儿都置 NULL 后不会冲突）。
--
-- R9 修复：006 初版丢了 UNIQUE(sticky_note_id, date)，导致 INSERT ... ON CONFLICT
-- 是 no-op；现恢复 UNIQUE，并加 CHECK 防止 count 出现 0 / 负数导致 heatmap 聚合异常。
CREATE TABLE IF NOT EXISTS _completions_new (
  id              TEXT PRIMARY KEY,
  sticky_note_id  TEXT,
  date            TEXT NOT NULL,
  count           INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (sticky_note_id) REFERENCES sticky_notes(id) ON DELETE SET NULL,
  UNIQUE (sticky_note_id, date),
  CHECK (count >= 1),
  CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
INSERT INTO _completions_new (id, sticky_note_id, date, count, created_at)
  SELECT id, sticky_note_id, date, count, created_at FROM completions
  WHERE 1=1
    ON CONFLICT(sticky_note_id, date) DO UPDATE SET count = count;  -- R8D-1 修复：去重同 sticky+date 累积行
DROP TABLE completions;
ALTER TABLE _completions_new RENAME TO completions;

-- R26-DI-1 修复 (high migration)：migration 004 重建 pomodoros 时**没有** created_at
-- 列（只 6 列：id/sticky_note_id/started_at/ended_at/duration_min/completed）。
-- 下面的 _pomodoros_new 重建要求 created_at NOT NULL，但 INSERT ... SELECT ... created_at
-- 在旧表上找不到该列 → 整条 006 事务 ROLLBACK → schema_migrations 不会写入 006 →
-- 007/008/009/010 永远不跑（外键、UNIQUE、index 全部缺失）。修复：先给旧 pomodoros
-- 加上 created_at（NULLable），再用 started_at 回填历史行，再做 INSERT SELECT。
ALTER TABLE pomodoros ADD COLUMN created_at TEXT;
UPDATE pomodoros SET created_at = started_at WHERE created_at IS NULL;
CREATE TABLE IF NOT EXISTS _pomodoros_new (
  id              TEXT PRIMARY KEY,
  sticky_note_id  TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_min    INTEGER,
  completed       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (sticky_note_id) REFERENCES sticky_notes(id) ON DELETE SET NULL,
  CHECK (completed IN (0, 1)),
  CHECK (duration_min IS NULL OR duration_min >= 0)
);
INSERT INTO _pomodoros_new (id, sticky_note_id, started_at, ended_at, duration_min, completed, created_at)
  SELECT id, sticky_note_id, started_at, ended_at, duration_min, completed, created_at FROM pomodoros;
DROP TABLE pomodoros;
ALTER TABLE _pomodoros_new RENAME TO pomodoros;

-- notifications：保留旧列名 task_id（避免破坏前端 IPC 序列化），但加 FK
-- R9 修复：原版 UNIQUE(task_id, type, fired_at) 用 ISO 时间戳去重，毫秒精度下
-- 几乎不会撞，与 migration 002 设计的「同一天同任务同 type 最多一条」语义不同。
-- 改回 STORED fired_date + UNIQUE(task_id, type, fired_date) 实现真正按天去重。
CREATE TABLE IF NOT EXISTS _notifications_new (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  fired_at    TEXT NOT NULL,
  fired_date  TEXT GENERATED ALWAYS AS (substr(fired_at, 1, 10)) STORED,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  UNIQUE(task_id, type, fired_date),
  FOREIGN KEY (task_id) REFERENCES sticky_notes(id) ON DELETE SET NULL
);
INSERT OR IGNORE INTO _notifications_new (id, task_id, fired_at, type, title, body)
  SELECT id, task_id, fired_at, type, title, body FROM notifications;
DROP TABLE notifications;
ALTER TABLE _notifications_new RENAME TO notifications;

-- notes：folder_id 加 FK
CREATE TABLE IF NOT EXISTS _notes_new (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  title       TEXT NOT NULL,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  starred     INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  mtime       TEXT NOT NULL,
  ctime       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  folder_id   TEXT,
  FOREIGN KEY (folder_id) REFERENCES note_folders(id) ON DELETE SET NULL
);
INSERT INTO _notes_new (id, path, filename, title, tags_json, starred, archived, mtime, ctime, created_at, updated_at, folder_id)
  SELECT id, path, filename, title, tags_json, starred, archived, mtime, ctime, created_at, updated_at, folder_id FROM notes;
DROP TABLE notes;
ALTER TABLE _notes_new RENAME TO notes;

-- ===== 重建 / 新增索引 =====
-- R8D-7：把 pomodoros 的 date(started_at) 函数索引转为范围扫描友好
CREATE INDEX IF NOT EXISTS idx_pomodoros_started ON pomodoros(started_at);
-- R8D-8：sticky_notes 增加 priority 索引 + 复合 (date, priority) 索引服务 ORDER BY
CREATE INDEX IF NOT EXISTS idx_sticky_notes_priority ON sticky_notes(priority);
CREATE INDEX IF NOT EXISTS idx_sticky_notes_date_priority ON sticky_notes(date, priority);
-- notes 的 folder_id 之前已有索引；FK 加上后确保索引不丢
CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id);
