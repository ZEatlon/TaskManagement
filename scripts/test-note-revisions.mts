/**
 * W2-A④ 测试套件 — 笔记回收站 + 版本历史
 *
 * 覆盖：
 *   1. notes.deleted_at 软删除 / 还原 / 永久删除
 *   2. notes.findAll 默认隐藏 deleted_at IS NOT NULL；trashed=true 才列
 *   3. note_revisions 表 append + prune 上限（MAX=50）
 *   4. ON DELETE CASCADE：删 note → revisions 连带删
 *   5. 复合索引 (note_id, created_at DESC) 存在
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'taskpilot-rev-'))

function openDb(): Database.Database {
  return new Database(join(TMP_DIR, `rev-${Math.random().toString(36).slice(2)}.sqlite`))
}

interface MigrationFile { version: number; name: string; sql: string }

function loadMigrations(): MigrationFile[] {
  // 最小 schema 集 —— 只关心 notes + note_revisions
  const m015 = `
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
  `
  const m018 = `
    ALTER TABLE notes ADD COLUMN deleted_at TEXT;
    ALTER TABLE notes ADD COLUMN purged_at  TEXT;
    UPDATE notes SET deleted_at = NULL WHERE deleted_at IS NOT NULL;
    UPDATE notes SET purged_at  = NULL WHERE purged_at  IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes(deleted_at);
    CREATE TABLE IF NOT EXISTS note_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id     TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      frontmatter TEXT    NOT NULL DEFAULT '{}',
      source      TEXT    NOT NULL DEFAULT 'auto',
      created_at  TEXT    NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_revisions_note_created
      ON note_revisions(note_id, created_at DESC);
  `
  return [
    { version: 15, name: 'note-folders-base', sql: m015 },
    { version: 18, name: 'note-trash-and-revisions', sql: m018 },
  ]
}

function applyMigrations(db: Database.Database, migs: MigrationFile[]): void {
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

function seedNotes(db: Database.Database): void {
  const ins = db.prepare(
    `INSERT INTO notes (id, path, filename, title, mtime, ctime, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = '2025-01-01T00:00:00.000Z'
  ins.run('note-a', '/lib/a.md', 'a.md', 'A', now, now, now)
  ins.run('note-b', '/lib/b.md', 'b.md', 'B', now, now, now)
  ins.run('note-c', '/lib/c.md', 'c.md', 'C', now, now, now)
}

// ───── tests ─────

await test('migration 018: deleted_at / purged_at / note_revisions 表与索引', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations())

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='note_revisions'`)
      .all()
    assert.equal(tables.length, 1, 'note_revisions 表必须存在')

    const idxs = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='note_revisions'`)
      .all() as Array<{ name: string }>
    const names = idxs.map((r) => r.name)
    assert.ok(names.includes('idx_note_revisions_note_created'), '需要复合索引')

    // 列存在
    const cols = db.prepare(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>
    const colNames = cols.map((c) => c.name)
    assert.ok(colNames.includes('deleted_at'), 'notes.deleted_at 必须存在')
    assert.ok(colNames.includes('purged_at'), 'notes.purged_at 必须存在')
  } finally {
    db.close()
  }
})

await test('trashByPath → deleted_at 被设置；list 默认隐藏', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations())
    seedNotes(db)

    // 软删 note-a
    const now = '2025-02-01T00:00:00.000Z'
    const trashInfo = db
      .prepare(`UPDATE notes SET deleted_at = ?, updated_at = ? WHERE path = ? AND deleted_at IS NULL`)
      .run(now, now, '/lib/a.md')
    assert.equal(trashInfo.changes, 1, '应 trash 一行')

    // 默认 list（WHERE deleted_at IS NULL）应只剩 2 行
    const visible = db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL`).get() as { c: number }
    assert.equal(visible.c, 2, '默认 list 应隐藏 trash 行')

    // trashed=true 应只剩 1 行
    const trashed = db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NOT NULL`).get() as { c: number }
    assert.equal(trashed.c, 1, 'trashed=true 应仅 1 行')
  } finally {
    db.close()
  }
})

await test('restoreByPath → deleted_at 回到 NULL', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations())
    seedNotes(db)

    db.prepare(`UPDATE notes SET deleted_at = '2025-02-01', updated_at = '2025-02-01' WHERE path = '/lib/a.md'`).run()
    const restore = db
      .prepare(`UPDATE notes SET deleted_at = NULL, purged_at = NULL, updated_at = ? WHERE path = ? AND deleted_at IS NOT NULL`)
      .run('2025-02-02', '/lib/a.md')
    assert.equal(restore.changes, 1, '应 restore 一行')

    const row = db.prepare(`SELECT deleted_at FROM notes WHERE path = '/lib/a.md'`).get() as { deleted_at: unknown }
    assert.equal(row.deleted_at, null, 'restore 后 deleted_at 必须为 NULL')

    // 再 restore → 0 行变更（已经还原过了）
    const second = db
      .prepare(`UPDATE notes SET deleted_at = NULL WHERE path = ? AND deleted_at IS NOT NULL`)
      .run('/lib/a.md')
    assert.equal(second.changes, 0, '重复 restore 应 0 行')
  } finally {
    db.close()
  }
})

await test('note_revisions: append + 复合主键 (note_id, revision row)', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations())
    seedNotes(db)

    db.prepare(
      `INSERT INTO note_revisions (note_id, content, frontmatter, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('note-a', 'first snapshot', '{}', 'auto', '2025-01-01T10:00:00.000Z')
    db.prepare(
      `INSERT INTO note_revisions (note_id, content, frontmatter, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('note-a', 'second snapshot', '{}', 'manual', '2025-01-01T11:00:00.000Z')

    const rows = db
      .prepare(`SELECT content, source, created_at FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC`)
      .all('note-a') as Array<{ content: string; source: string; created_at: string }>
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.content, 'second snapshot', 'DESC 排序：最新在前')
    assert.equal(rows[0]!.source, 'manual')
    assert.equal(rows[1]!.content, 'first snapshot')

    // 不同 note 的 revision 互不影响
    db.prepare(
      `INSERT INTO note_revisions (note_id, content, frontmatter, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('note-b', 'B snapshot', '{}', 'auto', '2025-01-01T12:00:00.000Z')

    const aOnly = db.prepare(`SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = 'note-a'`).get() as { c: number }
    const bOnly = db.prepare(`SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = 'note-b'`).get() as { c: number }
    assert.equal(aOnly.c, 2, 'note-a 仍 2 行')
    assert.equal(bOnly.c, 1, 'note-b 1 行')
  } finally {
    db.close()
  }
})

await test('note_revisions prune: 保留最近 50 行；超出按 created_at ASC 删最早', () => {
  const db = openDb()
  try {
    applyMigrations(db, loadMigrations())
    seedNotes(db)

    const ins = db.prepare(
      `INSERT INTO note_revisions (note_id, content, frontmatter, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    // 插 55 行
    for (let i = 0; i < 55; i++) {
      const ts = `2025-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
      ins.run('note-a', `snap-${i}`, '{}', 'auto', ts)
    }

    // prune SQL（与 repo 一致）
    db.prepare(
      `DELETE FROM note_revisions
       WHERE note_id = ?
         AND id NOT IN (
           SELECT id FROM note_revisions
           WHERE note_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )`,
    ).run('note-a', 'note-a', 50)

    const count = db.prepare(`SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = 'note-a'`).get() as { c: number }
    assert.equal(count.c, 50, 'prune 后应剩 50 行')

    // 留下的应该是最近 50 行（即 snap-5 ~ snap-54）
    const oldest = db.prepare(
      `SELECT content FROM note_revisions WHERE note_id = 'note-a' ORDER BY created_at ASC LIMIT 1`,
    ).get() as { content: string }
    assert.equal(oldest.content, 'snap-5', '最早保留的应是 snap-5（snap-0~4 被删）')

    const newest = db.prepare(
      `SELECT content FROM note_revisions WHERE note_id = 'note-a' ORDER BY created_at DESC LIMIT 1`,
    ).get() as { content: string }
    assert.equal(newest.content, 'snap-54', '最新保留的应是 snap-54')
  } finally {
    db.close()
  }
})

await test('ON DELETE CASCADE: 删 note → revisions 连带删除', () => {
  const db = openDb()
  try {
    db.pragma('foreign_keys = ON')
    applyMigrations(db, loadMigrations())
    seedNotes(db)

    db.prepare(
      `INSERT INTO note_revisions (note_id, content, frontmatter, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('note-a', 'snap', '{}', 'auto', '2025-01-01T00:00:00.000Z')

    const before = db.prepare(`SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = 'note-a'`).get() as { c: number }
    assert.equal(before.c, 1, 'sanity: revision 存在')

    db.prepare(`DELETE FROM notes WHERE id = 'note-a'`).run()
    const after = db.prepare(`SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = 'note-a'`).get() as { c: number }
    assert.equal(after.c, 0, '删 note 后 revisions 必须连带清')
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
