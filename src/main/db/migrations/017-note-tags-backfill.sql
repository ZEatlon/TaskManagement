-- Migration 017 — note_tags 反向回填
--
-- 目标：把现有 notes.tags_json 里的 tag **名称** 解析出来，匹配 / 创建
-- tags 表里对应的行，把 (note_id, tag_id) 插入 note_tags。
--
-- 设计要点：
--   1. 同一 note 可能 frontmatter 里多次出现同 tag 名（写错了）—— 用 DISTINCT
--      去重后再 join。
--   2. tag 名在 tags 表里找不到时 —— 自动创建（color null, parent null）。
--      这是「隐式 tag」机制：用户写了 frontmatter 就视为合法 tag，无需先
--      在 Sidebar 手动建。
--   3. 已存在的 (note_id, tag_id) 行 INSERT OR IGNORE —— 重跑幂等。
--   4. 把 tags_json 里空字符串 / 仅空白 / 含控制字符的「假名」过滤掉，
--      避免创建污染字典的垃圾行。
--
-- 不依赖外部 JS / 脚本：纯 SQL，事务包裹，启动期跑一次。

PRAGMA foreign_keys = ON;

BEGIN;

-- 1. 收集「所有出现过、且尚未在 tags 表里」的名字
-- 注：tags 表的列名是 order_num（不是 order）—— 沿用 001 + 008 重建后的命名。
INSERT OR IGNORE INTO tags (id, name, color, parent_id, order_num, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr('0123456789abcdef', abs(random()) % 16 + 1, 1) ||
    lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))) AS id,
  t.tag_name AS name,
  NULL AS color,
  NULL AS parent_id,
  0    AS order_num,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
FROM (
  SELECT DISTINCT json_each.value AS tag_name
  FROM notes, json_each(notes.tags_json)
  WHERE notes.tags_json != '[]'
    AND json_each.value != ''
    AND length(trim(json_each.value)) > 0
    AND json_each.value NOT GLOB '*[^ -~]*'  -- ASCII 可见字符
) t
WHERE NOT EXISTS (
  SELECT 1 FROM tags WHERE tags.name = t.tag_name
);

-- 2. 把每条 note 的 tag 名 → tag_id 写到 note_tags
INSERT OR IGNORE INTO note_tags (note_id, tag_id)
SELECT DISTINCT n.id AS note_id, g.id AS tag_id
FROM notes n,
     json_each(n.tags_json) AS je
JOIN tags g ON g.name = je.value
WHERE n.tags_json != '[]'
  AND je.value != ''
  AND length(trim(je.value)) > 0
  AND je.value NOT GLOB '*[^ -~]*';

COMMIT;
