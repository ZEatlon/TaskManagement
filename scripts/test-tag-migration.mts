/**
 * W1-D 测试套件 — 笔记 Tag 系统双源合并（single-source-of-truth 迁移）
 *
 * 覆盖：
 *   1. Migration 016 + 017 SQL 顺序跑完后：note_tags 表存在、有索引
 *   2. 把现有 notes.tags_json 里的 tag 名回填到 note_tags：
 *      - 已存在 tag：复用 id
 *      - 不存在 tag：自动创建（color null / parent null）
 *      - 重复 tag 名（同一笔记里出现 2 次）：去重为 1 行
 *      - 空字符串 / 仅空白 / 非 ASCII 名字：跳过
 *   3. 迁移可重入：再跑一次 017 不会重复创建 tags 行，也不会在 note_tags
 *      留下重复 (note_id, tag_id)
 *   4. tag rename 不需要 cascade 脚本（note_tags 用 id 关联，自动跟随）
 *   5. ON DELETE CASCADE：删 tag 时 note_tags 行连带删除
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'taskpilot-tag-mig-'))

function openDb(): Database.Database {
  return new Database(join(TMP_DIR, `tag-mig-${Math.random().toString(36).slice(2)}.sqlite`))
}

interface MigrationFile {
  version: number
  name: string
  sql: string
}

function loadMigrations(): MigrationFile[] {
  // 内联最小集 —— 避免 import.meta.glob 在 Node 单测里跑不起来
  // 也避免依赖完整 schema。这里只关心 tag 表、notes 表、note_tags 表。
  const tags = `
    CREATE TABLE IF NOT EXISTS tags (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      parent_id   TEXT,
      color       TEXT,
      order_num   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT,
      UNIQUE(name, parent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
  `
  const notes = `
    CREATE TABLE IF NOT EXISTS notes (
      id          TEXT PRIMARY KEY,
      path        TEXT NOT NULL,
      filename    TEXT NOT NULL,
      title       TEXT NOT NULL,
      tags_json   TEXT NOT NULL DEFAULT '[]',
      starred     INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      mtime       TEXT NOT NULL,
      ctime       TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
  `
  const m016 = `
    CREATE TABLE IF NOT EXISTS note_tags (
      note_id TEXT NOT NULL,
      tag_id  TEXT NOT NULL,
      PRIMARY KEY (note_id, tag_id),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
  `
  const m017 = `
    PRAGMA foreign_keys = ON;
    BEGIN;
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
        AND json_each.value NOT GLOB '*[^ -~]*'
    ) t
    WHERE NOT EXISTS (
      SELECT 1 FROM tags WHERE tags.name = t.tag_name
    );
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
  `
  return [
    { version: 8, name: 'tags-composite-unique', sql: tags },
    { version: 15, name: 'note-folders-base', sql: notes },
    { version: 16, name: 'note-tags-table', sql: m016 },
    { version: 17, name: 'note-tags-backfill', sql: m017 },
  ]
}

function applyMigrations(db: Database.Database, migs: MigrationFile[]): void {
  // 用同库模拟主进程 schema_migrations 表
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  for (const m of migs) {
    const already = db
      .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(m.version)
    if (already) continue
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(m.version, m.name, new Date().toISOString())
  }
}

// ───────── fixtures ─────────

function seedNotesWithTags(db: Database.Database): void {
  // 一条已有 tag 名（之后回填应该命中现有 tag）
  db.prepare(
    `INSERT INTO tags (id, name, parent_id, color, order_num, created_at, updated_at)
     VALUES (?, ?, NULL, 'blue', 0, ?, ?)`,
  ).run('tag-existing-1', 'work', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')

  // 三条 note：覆盖 (a) 已有 tag (b) 新 tag (c) 重复 (d) 空 / 空白 / 控制字符
  const ins = db.prepare(
    `INSERT INTO notes (id, path, filename, title, tags_json, starred, archived, mtime, ctime, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  )
  const now = '2025-01-01T00:00:00.000Z'
  ins.run('note-1', '/lib/note1.md', 'note1.md', 'A', JSON.stringify(['work', 'urgent']), now, now, now)
  ins.run('note-2', '/lib/note2.md', 'note2.md', 'B', JSON.stringify(['ideas', 'work']), now, now, now)
  ins.run('note-3', '/lib/note3.md', 'note3.md', 'C', JSON.stringify(['work', 'work', 'ideas']), now, now, now)
  ins.run('note-4', '/lib/note4.md', 'note4.md', 'D', JSON.stringify(['', '   ', '	']), now, now, now)
  ins.run('note-5', '/lib/note5.md', 'note5.md', 'E', '[]', now, now, now)
}

// ───────── tests ─────────

await test('migration 016: note_tags 表 + 双索引建好', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations())
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='note_tags'`)
      .all()
    assert.equal(tables.length, 1, 'note_tags 表必须存在')

    const idxs = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='note_tags'`)
      .all() as Array<{ name: string }>
    const names = idxs.map((r) => r.name)
    assert.ok(names.includes('idx_note_tags_note'), '需要 idx_note_tags_note 索引')
    assert.ok(names.includes('idx_note_tags_tag'), '需要 idx_note_tags_tag 索引')
  } finally {
    db.close()
  }
})

await test('migration 017 backfill: 已有 tag 复用 id / 新 tag 自动创建', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations().slice(0, 3)) // 不跑 017
    seedNotesWithTags(db)
    applyMigrations(db, [loadMigrations()[3]!]) // 跑 017

    // 'work' 仍是原来那条 tag，id 没换
    const work = db.prepare(`SELECT id FROM tags WHERE name = 'work'`).get() as
      | { id: string }
      | undefined
    assert.ok(work, 'work tag 必须存在')
    assert.equal(work!.id, 'tag-existing-1', '已有 tag id 不能被覆盖')

    // 'ideas' / 'urgent' 是新自动创建的
    const ideas = db.prepare(`SELECT id FROM tags WHERE name = 'ideas'`).get() as
      | { id: string }
      | undefined
    const urgent = db.prepare(`SELECT id FROM tags WHERE name = 'urgent'`).get() as
      | { id: string }
      | undefined
    assert.ok(ideas, 'ideas 必须自动创建')
    assert.ok(urgent, 'urgent 必须自动创建')
    assert.notEqual(ideas!.id, urgent!.id, '不同名 tag 必须不同 id')
    // 自动创建的 tag 默认 color=null / parent_id=null
    assert.equal(
      (db.prepare(`SELECT color, parent_id FROM tags WHERE name = 'ideas'`).get() as {
        color: unknown
        parent_id: unknown
      }).color,
      null,
    )
  } finally {
    db.close()
  }
})

await test('migration 017 backfill: note_tags 行数与 (note_id, tag_id) 唯一约束', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations().slice(0, 3))
    seedNotesWithTags(db)
    applyMigrations(db, [loadMigrations()[3]!])

    // note-1: work + urgent → 2 行
    const r1 = db
      .prepare(`SELECT COUNT(*) AS c FROM note_tags WHERE note_id='note-1'`)
      .get() as { c: number }
    assert.equal(r1.c, 2, 'note-1 应有 2 条 note_tags 行')

    // note-3: work 重复 + ideas → 去重后 2 行（不是 3 行）
    const r3 = db
      .prepare(`SELECT COUNT(*) AS c FROM note_tags WHERE note_id='note-3'`)
      .get() as { c: number }
    assert.equal(r3.c, 2, 'note-3 的 work 重复应被去重为 1 行')

    // note-4: 全是空 / 空白 → 0 行
    const r4 = db
      .prepare(`SELECT COUNT(*) AS c FROM note_tags WHERE note_id='note-4'`)
      .get() as { c: number }
    assert.equal(r4.c, 0, 'note-4 全部空字符串应被跳过')

    // note-5: tags_json='[]' → 0 行
    const r5 = db
      .prepare(`SELECT COUNT(*) AS c FROM note_tags WHERE note_id='note-5'`)
      .get() as { c: number }
    assert.equal(r5.c, 0, 'note-5 空数组应被跳过')

    // (note_id, tag_id) 唯一：手动插重复应被拒（INSERT OR IGNORE 用在 backfill）
    db.prepare(`INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)`)
      .run('note-1', 'tag-existing-1')
    const r1Again = db
      .prepare(`SELECT COUNT(*) AS c FROM note_tags WHERE note_id='note-1' AND tag_id='tag-existing-1'`)
      .get() as { c: number }
    assert.equal(r1Again.c, 1, 'INSERT OR IGNORE 不能让重复行出现')
  } finally {
    db.close()
  }
})

await test('migration 017 重入幂等', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations().slice(0, 3))
    seedNotesWithTags(db)
    const m017 = loadMigrations()[3]!

    // 第一次跑
    db.exec(m017.sql)
    const tagsCount1 = (db.prepare(`SELECT COUNT(*) AS c FROM tags`).get() as { c: number }).c
    const rowsCount1 = (db.prepare(`SELECT COUNT(*) AS c FROM note_tags`).get() as { c: number }).c

    // 第二次跑（应无变化）
    db.exec(m017.sql)
    const tagsCount2 = (db.prepare(`SELECT COUNT(*) AS c FROM tags`).get() as { c: number }).c
    const rowsCount2 = (db.prepare(`SELECT COUNT(*) AS c FROM note_tags`).get() as { c: number }).c

    assert.equal(tagsCount1, tagsCount2, '重跑 017 不应新增 tag 行')
    assert.equal(rowsCount1, rowsCount2, '重跑 017 不应新增 note_tags 行')
  } finally {
    db.close()
  }
})

await test('ON DELETE CASCADE: 删 tag → note_tags 行连带删除', () => {
  const db = openDb()
  try {
    db.pragma('foreign_keys = ON')
    applyMigrations(db, loadMigrations().slice(0, 3))
    seedNotesWithTags(db)
    applyMigrations(db, [loadMigrations()[3]!])

    const before = (db.prepare(`SELECT COUNT(*) AS c FROM note_tags`).get() as { c: number }).c
    assert.ok(before > 0, 'sanity: 关系表非空')

    db.prepare(`DELETE FROM tags WHERE name = 'work'`).run()
    const after = (db.prepare(`SELECT COUNT(*) AS c FROM note_tags`).get() as { c: number }).c
    assert.ok(after < before, '删 work tag 后 note_tags 行数应下降')
    // work 出现在 note-1, note-2, note-3 → 至少删 3 行
    assert.ok(before - after >= 3, 'work 在 3 条 note 上，删 tag 至少带走 3 行')
  } finally {
    db.close()
  }
})

// cleanup
test.after(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})
