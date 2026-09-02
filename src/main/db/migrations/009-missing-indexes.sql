-- Migration 009 — 补全 R15/R16 review 发现缺失的索引
--
-- 1. notes.archived：notesRepo.findAll/findByFolder/findStarred/findArchived 全部
--    WHERE archived = ?，001-initial.sql 只建了 idx_notes_path / idx_notes_starred，
--    006-foreign-keys 重建时也没补。归档/取消归档/最近笔记列表全表扫描。
--
-- 2. note_events.note_id：声明了 FK 但没建索引。note_events 表只有 date 一个索引，
--    任何"按 note_id 过滤事件"的查询（全表扫描）。completions.sticky_note_id
--    和 pomodoros.sticky_note_id 已有覆盖（completions PK 是 id 但有 idx_completions_sticky，
--    pomodoros 有 idx_pomodoros_sticky），所以这里只补 note_events。

CREATE INDEX IF NOT EXISTS idx_notes_archived_mtime ON notes(archived, mtime DESC);
CREATE INDEX IF NOT EXISTS idx_note_events_note_id ON note_events(note_id);