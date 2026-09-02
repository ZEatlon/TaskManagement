-- TaskPilot 便签（多级待办）schema
-- date 轴 + 优先级 + 多步骤；不与 tasks 表耦合（不动 tasks 表）
-- 每个便签按归属日（YYYY-MM-DD）聚合，每个步骤归属一个便签

-- ============== 便签 ==============
CREATE TABLE IF NOT EXISTS sticky_notes (
  id          TEXT PRIMARY KEY,                    -- UUID v4
  title       TEXT NOT NULL,                        -- 1级标题（便签名字）
  date        TEXT NOT NULL,                         -- YYYY-MM-DD（便签归属日，本地时区）
  priority    TEXT NOT NULL DEFAULT 'p3',           -- p0/p1/p2/p3
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sticky_notes_date        ON sticky_notes(date);
CREATE INDEX IF NOT EXISTS idx_sticky_notes_created_at  ON sticky_notes(created_at);

-- ============== 便签步骤（2级内容） ==============
CREATE TABLE IF NOT EXISTS sticky_note_steps (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL,                         -- FK -> sticky_notes.id ON DELETE CASCADE
  content     TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  order_num   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES sticky_notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sticky_note_steps_note_id ON sticky_note_steps(note_id);