-- TaskPilot 初始数据库 schema
-- 所有表使用 TEXT 主键（UUID v4），时间使用 ISO 8601 字符串

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============== 任务 ==============
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'todo',
  priority        TEXT NOT NULL DEFAULT 'p3',
  tags_json       TEXT NOT NULL DEFAULT '[]',
  due_at          TEXT,
  scheduled_at    TEXT,
  completed_at    TEXT,
  recurrence      TEXT,
  estimated_minutes INTEGER,
  actual_minutes  INTEGER,
  pomodoro_count  INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status        ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority      ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at        ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at  ON tasks(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_archived        ON tasks(archived);

-- ============== 子任务 ==============
CREATE TABLE IF NOT EXISTS subtasks (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  order_num   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id);

-- ============== 附件 ==============
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  filename    TEXT NOT NULL,
  path        TEXT NOT NULL,
  mime_type   TEXT,
  size        INTEGER,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id);

-- ============== 标签（支持嵌套） ==============
CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  parent_id   TEXT,
  color       TEXT,
  order_num   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_parent_id ON tags(parent_id);

-- ============== 设置（key-value） ==============
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ============== AI 对话 ==============
CREATE TABLE IF NOT EXISTS ai_conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  token_input   INTEGER NOT NULL DEFAULT 0,
  token_output  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_conv_updated ON ai_conversations(updated_at);

-- ============== 完成日志（用于热力图） ==============
CREATE TABLE IF NOT EXISTS completions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  date        TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_completions_date ON completions(date);

-- ============== 番茄钟记录 ==============
CREATE TABLE IF NOT EXISTS pomodoros (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_min INTEGER,
  completed   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pomodoros_started ON pomodoros(started_at);
CREATE INDEX IF NOT EXISTS idx_pomodoros_task ON pomodoros(task_id);

-- ============== 提醒 ==============
CREATE TABLE IF NOT EXISTS reminders (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  remind_at   TEXT NOT NULL,
  message     TEXT,
  fired       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_fired ON reminders(fired);

-- ============== 笔记元数据（实际文件在文件系统） ==============
CREATE TABLE IF NOT EXISTS notes (
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
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(starred);

-- ============== 笔记历史（热力图） ==============
CREATE TABLE IF NOT EXISTS note_events (
  id          TEXT PRIMARY KEY,
  note_id     TEXT,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL, -- create/edit/delete
  count       INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_note_events_date ON note_events(date);

-- ============== 迁移记录 ==============
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);