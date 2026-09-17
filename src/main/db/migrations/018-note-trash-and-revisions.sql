-- Migration 018 — 笔记回收站 + 版本历史
--
-- 两条独立改动，可以独立回滚（两个事务段）。
--
-- 改动 1：notes 表加 deleted_at 列（软删除时间戳）
--   - NULL = 正常笔记
--   - 非 NULL = 在回收站（用户可在 UI 里看到 / 还原 / 永久删除）
--   - note:list 默认 WHERE deleted_at IS NULL（与现有 archived 列一致风格）
--   - 文件系统层面：note:trash 仅置 deleted_at，磁盘文件保留；
--     note:purge 真正删文件 + 行
--
-- 改动 2：note_revisions 表（每条笔记的版本快照）
--   - 每次 note:write 在写入新内容前，把当前正文 / frontmatter 序列化为
--     一行 snapshot（含 created_at）
--   - 最多保留 50 行 / 笔记（保留上限），超出按 created_at ASC 删最早
--   - 用户可在 history drawer 里：列表 → 读 → 还原（restore-revision 把它
--     复制为新当前正文 + 自动 snapshot 当前到 history 里，形成安全分支）
--
-- SQLite ALTER TABLE ADD COLUMN 不支持 NOT NULL DEFAULT —— 与 010 同款
-- 做法：先 NULL able，再 UPDATE 一遍。

-- ====== 改动 1：notes.deleted_at ======
ALTER TABLE notes ADD COLUMN deleted_at TEXT;
ALTER TABLE notes ADD COLUMN purged_at  TEXT;
-- 把现存所有笔记的 deleted_at / purged_at 设为 NULL（明确语义，避免
-- 旧 DB 里隐含 NULL 与"未设置"混淆）。
UPDATE notes SET deleted_at = NULL WHERE deleted_at IS NOT NULL;
UPDATE notes SET purged_at  = NULL WHERE purged_at  IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes(deleted_at);
-- 列出"未删除"时走 idx_notes_deleted_at IS NULL 即可，不用复合索引
-- （active notes 的 listing 已经按 mtime / path 等加索引，deleted_at
-- filter 通常只是薄 filter）。

-- ====== 改动 2：note_revisions 表 ======
CREATE TABLE IF NOT EXISTS note_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  frontmatter TEXT    NOT NULL DEFAULT '{}',
  source      TEXT    NOT NULL DEFAULT 'auto',  -- 'auto' = writeNote snapshot / 'manual' = user-saved revision
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_revisions_note_created
  ON note_revisions(note_id, created_at DESC);
-- 列表查询总是 ORDER BY created_at DESC + WHERE note_id = ?，复合索引
-- 一次性覆盖。

-- 每条笔记最多保留 50 行（保留上限）的 prune 在 repo 层做（需要先 SELECT
-- 计数再 DELETE，超出部分按 created_at ASC 删），不在 SQL 触发器里写
-- —— trigger 行为对调试不友好，且触发器数量越多越容易踩 SQLite 25 层
-- 递归上限。
