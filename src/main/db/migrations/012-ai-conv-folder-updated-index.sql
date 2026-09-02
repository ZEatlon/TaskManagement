-- 012-ai-conv-folder-updated-index.sql
--
-- Perf-fix #10：sidebar AI 对话列表的 hot query 是
--   SELECT … FROM ai_conversations WHERE folder_id = ?
--   ORDER BY updated_at DESC, created_at DESC LIMIT ?
-- 011 迁移加的是单列索引（folder_id）和（updated_at），SQLite 在两者间二选一
-- 然后再 ORDER BY 全表扫 → LIMIT，或者直接全表扫后再排序。对几百到几千条
-- 对话的用户来说，folder 切换时这个排序是显著的卡顿源。
--
-- 修复：复合索引 (folder_id, updated_at DESC, created_at DESC) —— SQLite 直接
-- 用索引覆盖 ORDER BY + LIMIT，O(log N + LIMIT) 而不是 O(N log N)。
-- 仅在 folder_id IS NOT NULL 的情况下索引有效（NULL 是「未分类」），所以
-- 未分类视图仍走 updated_at 单列索引 → 不需要单独为 NULL 加偏列。
--
-- 与现有 011 的索引兼容（folder_id 单列索引保留，folder 列表/计数用得到）。
CREATE INDEX IF NOT EXISTS idx_ai_conv_folder_updated
  ON ai_conversations(folder_id, updated_at DESC, created_at DESC)
  WHERE folder_id IS NOT NULL;