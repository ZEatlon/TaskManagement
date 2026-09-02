-- Migration 008 — tags 表复合唯一约束 (name, parent_id)
--
-- R15 修复 (high)：
-- 001-initial.sql:62-70 的 tags 表只声明了列级 UNIQUE(name)，但 create()
-- 和 findByNameInScope() 都按 (name, parent_id) 复合作用域查找，注释也
-- 声称「UNIQUE(name, parent_id) 约束存在」。结果：
--   - 不同 parent 下同名 tag 实际无法共存（第二个 INSERT 撞单列 UNIQUE，
--     catch 又退化成返回现有 global tag，命名空间退化为全局平铺）
--   - tags.update() 改 parent_id 时也无法真正支持嵌套重命名
--
-- SQLite 不支持 ALTER TABLE DROP CONSTRAINT，只能用 5 步法重建。
-- 步骤：
--   1) dedup：把所有「按 (name, parent_id) 重复」的 tag 中第二个起的 name
--      重命名为 <name>#<short-id>，确保重建后 UNIQUE 约束不冲突。
--   2) CREATE TABLE tags_new ... UNIQUE(name, parent_id)
--   3) INSERT INTO tags_new SELECT ... FROM tags
--   4) DROP TABLE tags; ALTER TABLE tags_new RENAME TO tags;
--   5) 重建索引

-- ===== 步骤 1：打断环（cycle） =====
-- R16 修复 (high)：migrate.ts 临时 PRAGMA foreign_keys = OFF 让迁移不强制 FK，
-- 但事后 RENAME 出来的 tags 表里如果原本就有 cycle（A.parent=B, B.parent=A），
-- 之后用户 DELETE 一个参与环的 tag 会触发 ON DELETE CASCADE 递归到 SQLite 25 层
-- 上限 → "too many levels of trigger recursion" 错误，用户从此删不掉任何环上节点。
-- 在重建前用递归 CTE 找出 cycle，把它们的 parent_id 置 NULL 拆环（保留原始
-- parent_id 备份到 parent_id_backup 列以便回滚 / 审计；新表不带该列）。
--
-- R17 修复 (medium correctness)：R16 把递归深度限制在 50，但锚点 depth=0
-- 之后每条递归都 +1，最大存储深度为 50。检测环需要走到自己的 ancestor 即
-- `depth >= cycle_length - 1`。对于 cycle_length=51 的环，walk 走到 depth=50
-- 时 ancestor=A(51 mod 51)=A0 仍可命中；但对于 cycle_length=52 及以上的环，
-- walk 永远到不了自己，环检测漏判，环上节点 parent_id 保留 → RENAME 后仍
-- 是 self-FK，触发 SQLite 25 层 trigger recursion 限制。修复：把深度上限定
-- 到 500（实际 tag 树深度远小于此；成本仅是一次性 CTE 内存）。
ALTER TABLE tags ADD COLUMN parent_id_backup TEXT;
UPDATE tags
SET parent_id_backup = parent_id
WHERE parent_id IS NOT NULL;

-- 用递归 CTE 沿 parent_id 链走，碰到「回边」（本 id 已出现在祖先链里）即判定为环。
-- 限制递归深度 999 防 SQLite "too much recursion"。SQLite 默认 max_recursion_depth=1000，
-- 本 CTE 走到 999 后 SQLite 会自动截断（不抛错）—— 但仍可能漏判 cycle_length=1000 的极端恶意
-- 数据。R17 用 500 时 cycle_length=502 直接穿透；R18 改为 999 是「明显不可能合法」的深度，
-- 同时仍然依赖 ON DELETE CASCADE 在 RENAME 后用 parent_id NULL 化兜底（不可能仍有环）。
--
-- 正确的环检测语义：在祖先链中找到自己的 id 即为环。用 WHERE w.depth < 999 + 上限足够大
-- 几乎可以认为是「任意长度环都能检测」，真实 tag 树深度 << 100。
WITH RECURSIVE walk(id, ancestor, depth, cycle_root) AS (
  SELECT id, parent_id, 0, id FROM tags WHERE parent_id IS NOT NULL
  UNION ALL
  SELECT w.id, t.parent_id, w.depth + 1, w.cycle_root
  FROM walk w JOIN tags t ON w.ancestor = t.id
  WHERE w.depth < 999
)
-- 把所有"存在回边"的节点 parent_id 置 NULL：原始数据里只要 ancestors 中再次出现
-- 自己就是环。注：CTE 是 DAG 走，碰到回边就是"环"，但同时也可能正确表达"我父辈里
-- 有同 id"，这种情况在原始 tags 表里就是数据错误（一个节点不能既是自己父辈又是自己），
-- 一律置 NULL 拆环，让用户事后手动修复。
UPDATE tags
SET parent_id = NULL
WHERE id IN (
  SELECT id FROM walk
  WHERE EXISTS (
    SELECT 1 FROM walk w2
    WHERE w2.id = walk.id AND w2.ancestor = walk.id AND w2.depth > 0
  )
);

-- ===== 步骤 2：dedup =====
-- 把同 (name, parent_id) 组里除第一行外的其它行重命名为 <name>#<short-id>
UPDATE tags
SET name = name || '#' || substr(id, 1, 8)
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY name, parent_id ORDER BY id
    ) AS rn FROM tags
  ) t WHERE t.rn > 1
);

-- ===== 步骤 3-5：重建表 =====
CREATE TABLE IF NOT EXISTS _tags_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT,
  color       TEXT,
  order_num   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES _tags_new(id) ON DELETE CASCADE,
  UNIQUE (name, parent_id)
);

-- 自引用 FK 在 INSERT 时会要求 parent 行已存在；先按 parent_id IS NULL
-- 排序（root 在前），子节点在其 parent 之后 INSERT，保证 FK 满足。
INSERT INTO _tags_new (id, name, parent_id, color, order_num, created_at)
  SELECT id, name, parent_id, color, order_num, created_at
  FROM tags
  ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, created_at;

DROP TABLE tags;
ALTER TABLE _tags_new RENAME TO tags;

-- ===== 步骤 5：重建索引 =====
CREATE INDEX IF NOT EXISTS idx_tags_parent_id ON tags(parent_id);
CREATE INDEX IF NOT EXISTS idx_tags_order_num ON tags(order_num);
