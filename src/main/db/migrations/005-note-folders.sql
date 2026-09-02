-- TaskPilot 笔记文件夹管理
--
-- 引入「文件夹」概念，把多个笔记组织成一组。
-- 设计取舍：
--   - 一级文件夹（无嵌套）—— 与便签的扁平结构一致；用户可创建 / 重命名 / 删除文件夹
--   - 数据库层记录 folder_id；不创建真实文件系统子目录（笔记仍在 .taskpilot/notes/ 根目录）
--   - notes.folder_id NULL = 「未分类」，侧边栏独立分组显示
--   - 删除文件夹时把内部 notes 的 folder_id 置 NULL（不级联删除笔记）
--
-- 关联索引：notes.folder_id 让「按文件夹过滤」走索引而不是全表扫

-- ============== 文件夹 ==============
CREATE TABLE IF NOT EXISTS note_folders (
  id          TEXT PRIMARY KEY,                       -- UUID v4
  name        TEXT NOT NULL,                          -- 文件夹名（用户可重命名）
  color       TEXT,                                   -- 可选：6 种主题色（与便签 palette 一致）
  order_num   INTEGER NOT NULL DEFAULT 0,             -- 侧边栏展示顺序
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_folders_order_num ON note_folders(order_num);

-- ============== notes.folder_id ==============
ALTER TABLE notes ADD COLUMN folder_id TEXT;           -- NULL = 未分类

CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id);

-- R25-DI-3 修复 (high lost-update)：原 create() 用 SELECT COALESCE(MAX(order_num), -1)+1
-- 拿「下一个顺序」，再 INSERT —— 两次 IPC 之间让出事件循环。两个并发 create（用户在多
-- 窗口同时新建文件夹 / AI 工具同时创建）会各自读到相同的 MAX +1 → INSERT 同一
-- order_num → findAllOrdered() ORDER BY 同组时由 name 兜底但渲染顺序变成「两个新建
-- 谁先 name DESC 谁就后出」—— 用户视角是「新建文件夹顺序不确定」。
-- 修复：UNIQUE 约束加在 order_num 上，配合 INSERT 用 subquery 原子拿 MAX+1。
-- 一次 INSERT 内 SELECT...+ INSERT 在 SQLite 中是单语句原子，并发场景下第二个
-- INSERT 看到第一个已 commit 的 MAX+1 不会撞键；若真撞（极端 race）则 UNIQUE 报错，
-- 由 IPC 层捕获重试。
--
-- 注意：sqlite 不支持 ALTER TABLE ADD CONSTRAINT，要重建表。
CREATE TABLE IF NOT EXISTS _note_folders_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  order_num   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (order_num)
);
INSERT INTO _note_folders_new (id, name, color, order_num, created_at, updated_at)
  SELECT id, name, color, order_num, created_at, updated_at FROM note_folders;
DROP TABLE note_folders;
ALTER TABLE _note_folders_new RENAME TO note_folders;

CREATE INDEX IF NOT EXISTS idx_note_folders_order_num ON note_folders(order_num);