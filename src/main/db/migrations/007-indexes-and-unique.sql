-- Migration 007 — 索引补齐 + sticky_note_steps (note_id, order_num) 唯一约束
--
-- R13 修复 (medium)：
-- 1. 006 migration 重建了 4 张表（completions / pomodoros / notifications /
--    notes），但 CREATE TABLE _new 只写了 FK 与必要 UNIQUE，没有把原表
--    的索引显式重建。RENAME 之后旧的 idx_completions_date /
--    idx_pomodoros_note_id 等全部消失，导致：
--    - heatmap（completions JOIN notes）走全表扫描
--    - 通知去重 (task_id, type, fired_date) 走全表扫描
--    - pomodoros 按 sticky_note_id 聚合走全表扫描
-- 2. sticky_note_steps.addStep() 用 SELECT MAX(order_num)+1 然后 INSERT，
--    两步之间无事务，并发调用会撞同一 order_num。给 (note_id, order_num)
--    加 UNIQUE 约束 + INSERT 用 ON CONFLICT 重试即可。

-- ===== 索引重建 =====
CREATE INDEX IF NOT EXISTS idx_completions_date        ON completions(date);
CREATE INDEX IF NOT EXISTS idx_completions_note_id     ON completions(sticky_note_id);
CREATE INDEX IF NOT EXISTS idx_pomodoros_note_id       ON pomodoros(sticky_note_id);
CREATE INDEX IF NOT EXISTS idx_notifications_task      ON notifications(task_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type      ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_fired_at  ON notifications(fired_at);

-- ===== sticky_note_steps (note_id, order_num) 唯一约束 =====
-- 注意：sqlite 不支持 ALTER TABLE ADD CONSTRAINT；只能用 5 步法重建。
-- 先查 (note_id, order_num) 是否有重复；如有则把整个 note 的所有 step
-- 按 ROW_NUMBER 重新编号到 0..N-1（保证 UNIQUE 约束建立时不冲突）。
--
-- R15 修复 (critical)：原版用 `GROUP BY id HAVING COUNT(*) > 1`，但 id 是
-- PRIMARY KEY，每组永远只有一行，dedup 永远不命中。如有预存重复
-- (note_id, order_num)，下方 CREATE TABLE 的 UNIQUE 会立刻失败，整个
-- 007 transaction rollback → schema_migrations 不写入 → 每次启动重试。
-- 改为对所有「含重复 (note_id, order_num) 的 note」，整组按 ROW_NUMBER
-- 重新编号。干净 note 不动（避免无谓的写放大）。
UPDATE sticky_note_steps
SET order_num = (
  SELECT rn - 1 FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY note_id ORDER BY order_num, id
    ) AS rn FROM sticky_note_steps
  ) t WHERE t.id = sticky_note_steps.id
)
WHERE note_id IN (
  SELECT note_id FROM sticky_note_steps
  GROUP BY note_id, order_num HAVING COUNT(*) > 1
);

CREATE TABLE IF NOT EXISTS _sticky_note_steps_new (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL,
  content     TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  order_num   INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES sticky_notes(id) ON DELETE CASCADE,
  UNIQUE (note_id, order_num),
  CHECK (done IN (0, 1))
);
-- R14 修复 (critical)：原 sticky_note_steps 没有 updated_at 列（见
-- 003-sticky-notes.sql:19-27），007 之前的 INSERT...SELECT 引用了不存在的
-- updated_at 会让 007 在任何走完 003/006 的 DB 上启动失败。改为只拷贝
-- 真实存在的列。
INSERT INTO _sticky_note_steps_new (id, note_id, content, done, order_num, created_at)
  SELECT id, note_id, content, done, order_num, created_at FROM sticky_note_steps;
DROP TABLE sticky_note_steps;
ALTER TABLE _sticky_note_steps_new RENAME TO sticky_note_steps;

-- 重建索引
CREATE INDEX IF NOT EXISTS idx_sticky_note_steps_note_id ON sticky_note_steps(note_id);