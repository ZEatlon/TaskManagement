-- Migration 010 — 给 tags 加 updated_at 列（CAS 必需）
--
-- R17 修复 (high correctness)：tags.update 之前用 created_at 做 CAS predicate
-- （WHERE id=? AND created_at=?），但 UPDATE SET 子句不修改 created_at，所有
-- 并发写者都读到相同 created_at 快照并都 changes=1，CAS 永远不冲突——R15 写的
-- 「并发安全」实际是死代码。修复需要：
--   1. tags 表增加 updated_at 列（不可空，默认 = created_at）
--   2. tags.update() 的 UPDATE 把 updated_at = NOW()，CAS predicate 用
--      WHERE id=? AND updated_at=existing.updated_at（每写者不同步 → 真实 CAS）
--
-- SQLite 不支持 ALTER TABLE 加 NOT NULL 列有默认值（ADD COLUMN 不能直接配
-- NOT NULL DEFAULT）。先用 NULL able + 默认 '1970' 再 UPDATE 一遍。

ALTER TABLE tags ADD COLUMN updated_at TEXT;

-- 把当前所有 tag 的 updated_at 初始化为 created_at。新增 tag 在 tags.ts:create()
-- / tags.ts:update() 内显式写入 updated_at = now。
UPDATE tags SET updated_at = created_at WHERE updated_at IS NULL;

-- 索引可加可不加：tags.update 按 id 走主键就够；updated_at 不参与检索。
