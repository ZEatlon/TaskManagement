-- Migration 015 — AI 对话标题占位标志位
--
-- 背景：stores/ai.ts 的 title_updated 事件 handler 原版用
--   `if (c.title && !c.title.startsWith('新对话')) return c`
--   判定「这仍是系统生成的占位，可以被 AI 自动覆盖」。把"系统占位"状态
--   与中文字面量绑死，未来加非 zh-CN locale 后这条判定永远 false →
--   首轮对话结束后 AI 自动重命名整个失效。
--
-- 修复：加 stable flag 列 title_is_auto，handler / autoTitle.ts 改读
-- 本字段，不再 prefix-match 字面量。占位标题本身的渲染字面量走
-- @shared/i18n/locales.getRelativeTimeMessages(locale).conversationTitlePlaceholder
-- （双轨修复：状态靠列、字面量靠字典）。
--
-- 列语义：
--   - 1 = 系统占位，等待 AI 在首轮结束后覆盖
--   - 0 = 终态：用户已手动改名 / AI 已自动覆盖 / 第三方工具改名
--   - DEFAULT 0 是保守默认；新建对话由渲染端 newConversation 显式传 1
--
-- 回填：旧 DB 中已经存在的『新对话 · datetime』形态占位行直接置 1，
-- 避免历史占位因迁移后立刻不再被 AI 自动重写。
--
-- 索引：title_updated 事件触发后只需要按 id 命中，无需新索引。

ALTER TABLE ai_conversations ADD COLUMN title_is_auto INTEGER NOT NULL DEFAULT 0;

-- 历史占位回填：只要现存 title 还以『新对话』开头，认为它就是当时创建时
-- 渲染端生成的占位，迁移后应保持 titleIsAuto=true 让首轮对话结束时
-- AI 能继续覆盖。注意：本 UPDATE 只跑一次（迁移本身只跑一次），不会影响
-- 后续用户已经手动改过名字的行（那些行 title 已经不是『新对话 ...』开头）。
UPDATE ai_conversations
   SET title_is_auto = 1
 WHERE title IS NOT NULL
   AND title LIKE '新对话%';
