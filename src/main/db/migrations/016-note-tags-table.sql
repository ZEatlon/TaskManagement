-- Migration 016 — note_tags 关系表（笔记 ↔ 标签 多对多）
--
-- 背景：
--   - notes.tags_json 是从 markdown frontmatter 解析出来的 tag **名称** 列表
--   - tags 表存的是 tag **字典**（id, name, color, parent_id），由
--     useTagsStore (renderer) 维护
--   - 两边独立，tag 重命名后 notes.tags_json 不会跟着改，造成
--     「dictionary 里是『work』，frontmatter 里是『Work』，搜索两边都不匹配」
--
-- 解决方案：加 note_tags(note_id, tag_id) 关系表作为「单一真源」——
--   - 关系按 tag_id（不是 name），重命名 tag 自动跟随
--   - 删 tag 时连带 note_tags 行删掉（外键 ON DELETE CASCADE）
--   - notes.tags_json 仍保留写入（frontmatter 不能丢，markdown 文件是
--     用户可见的源），但读路径优先 note_tags
--
-- 双写窗口策略（dual-write window）：
--   - 写入笔记时：notes.tags_json + note_tags 同时写
--   - 读取笔记 tag 列表：note_tags 优先，frontmatter 解析兜底
--   - 下一个 release 评估「移除 tags_json 写入」的安全窗口

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL,
  tag_id  TEXT NOT NULL,
  PRIMARY KEY (note_id, tag_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
);

-- 按 note_id 查 tag 的索引（listForNote 主路径）
CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id);
-- 按 tag_id 反查笔记（listByTag 主路径）
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
