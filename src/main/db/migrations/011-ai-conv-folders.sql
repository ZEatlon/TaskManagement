-- Migration 011 — AI 对话文件夹管理
--
-- 背景：之前 ai_conversations 是扁平列表，用户无法按主题（工作 / 学习 / 个人）
--       分组。引入「文件夹」概念，与笔记的 note_folders 隔离（独立的表，独立
--       的 UI）—— 笔记 folder 与 AI folder 互不引用，避免误删 / 跨模块污染。
--
-- 设计取舍（与 migrations/005-note-folders.sql 对齐）：
--   - 一级文件夹（无嵌套）—— 与便签 / 笔记 folder 保持一致
--   - 数据库层记录 folder_id；不创建真实文件系统目录
--   - ai_conversations.folder_id NULL = 「未分类」，UI 独立分组显示
--   - 删除文件夹时把内部 conversations 的 folder_id 置 NULL（不级联删除对话）
--
-- 关联索引：ai_conversations.folder_id 让「按文件夹过滤」走索引而不是全表扫

-- ============== 文件夹表 ==============
CREATE TABLE IF NOT EXISTS ai_conversation_folders (
  id          TEXT PRIMARY KEY,                       -- UUID v4
  name        TEXT NOT NULL,                          -- 文件夹名（用户可重命名）
  color       TEXT,                                   -- 可选：6 种主题色（与 note palette 一致）
  order_num   INTEGER NOT NULL DEFAULT 0,             -- 侧边栏展示顺序
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_conv_folders_order_num ON ai_conversation_folders(order_num);

-- ============== ai_conversations.folder_id ==============
ALTER TABLE ai_conversations ADD COLUMN folder_id TEXT;  -- NULL = 未分类

CREATE INDEX IF NOT EXISTS idx_ai_conv_folder_id ON ai_conversations(folder_id);