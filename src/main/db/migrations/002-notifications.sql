-- TaskPilot Module 8: 通知历史表
-- 记录系统通知触发历史，防止同一天对同一任务重复推送。
-- 用 STORED 派生列 fired_date 承载 date(fired_at)，再对其建 UNIQUE 约束
-- （SQLite 不允许 UNIQUE 内含函数表达式，但允许引用派生列）。

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  task_id    TEXT,
  fired_at   TEXT NOT NULL,
  fired_date TEXT NOT NULL GENERATED ALWAYS AS (date(fired_at)) STORED,
  type       TEXT NOT NULL,           -- 'due' | 'scheduled' | 'reminder'
  title      TEXT NOT NULL,
  body       TEXT,
  UNIQUE(task_id, type, fired_date)
);

CREATE INDEX IF NOT EXISTS idx_notifications_fired   ON notifications(fired_at);
CREATE INDEX IF NOT EXISTS idx_notifications_task    ON notifications(task_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type    ON notifications(type);