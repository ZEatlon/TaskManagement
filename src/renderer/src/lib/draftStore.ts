/**
 * IndexedDB 草稿存储（模块 7）
 *
 * 用途：
 *   - 在"未保存到磁盘"前，把编辑内容缓存在浏览器 IndexedDB
 *   - 避免意外关闭、崩溃造成内容丢失
 *   - 在重新打开时检测到草稿并提示恢复
 *
 * 设计：
 *   - 数据库名：taskpilot-drafts
 *   - ObjectStore：drafts（keyPath: id）
 *     - id: 形如 `note:${path}` 或 `note:__new__`
 *     - content: 字符串（Markdown / HTML / JSON 都按字符串存）
 *     - updatedAt: ISO 时间
 *   - 不引入 idb 依赖：使用原生 IndexedDB API
 *   - 失败容错：所有方法在 IDB 不可用时退化为 no-op
 */

const DB_NAME = 'taskpilot-drafts'
const DB_VERSION = 1
const STORE_NAME = 'drafts'

/** 一条草稿 */
export interface DraftEntry {
  id: string
  content: string
  updatedAt: string
  /** 来源笔记路径（null 表示新笔记草稿） */
  notePath: string | null
  /** 来源内容类型：markdown / html / json */
  kind: 'markdown' | 'html' | 'json'
}

let dbPromise: Promise<IDBDatabase | null> | null = null

/**
 * 打开数据库（懒加载），失败时返回 null
 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null)
    return dbPromise
  }
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      console.warn('[draft-store] open failed', req.error)
      resolve(null)
    }
    req.onblocked = () => {
      console.warn('[draft-store] open blocked')
      resolve(null)
    }
  })
  return dbPromise
}

/** 草稿 id 生成：note:<path> 或 note:__new__ */
export function draftIdFor(notePath: string | null): string {
  return notePath ? `note:${notePath}` : 'note:__new__'
}

/**
 * 保存草稿（upsert）。静默失败。
 */
export async function saveDraft(entry: DraftEntry): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.put(entry)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => {
        console.warn('[draft-store] save failed', tx.error)
        resolve(false)
      }
      tx.onabort = () => {
        console.warn('[draft-store] save aborted', tx.error)
        resolve(false)
      }
    } catch (err) {
      console.warn('[draft-store] save exception', err)
      resolve(false)
    }
  })
}

/**
 * 读取单条草稿
 */
export async function loadDraft(id: string): Promise<DraftEntry | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise<DraftEntry | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(id)
      req.onsuccess = () => resolve((req.result as DraftEntry) ?? null)
      req.onerror = () => {
        console.warn('[draft-store] load failed', req.error)
        resolve(null)
      }
    } catch (err) {
      console.warn('[draft-store] load exception', err)
      resolve(null)
    }
  })
}

/**
 * 删除单条草稿
 */
export async function deleteDraft(id: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.delete(id)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => {
        console.warn('[draft-store] delete failed', tx.error)
        resolve(false)
      }
    } catch (err) {
      console.warn('[draft-store] delete exception', err)
      resolve(false)
    }
  })
}

/**
 * 列出全部草稿（按 updatedAt 降序）
 */
export async function listDrafts(): Promise<DraftEntry[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise<DraftEntry[]>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.getAll()
      req.onsuccess = () => {
        const all = (req.result as DraftEntry[]) ?? []
        all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        resolve(all)
      }
      req.onerror = () => {
        console.warn('[draft-store] list failed', req.error)
        resolve([])
      }
    } catch (err) {
      console.warn('[draft-store] list exception', err)
      resolve([])
    }
  })
}

/**
 * 清理过期草稿（默认超过 7 天未更新视为过期）
 */
export async function pruneStaleDrafts(maxAgeMs = 7 * 24 * 3600 * 1000): Promise<number> {
  const all = await listDrafts()
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const d of all) {
    const t = Date.parse(d.updatedAt)
    if (Number.isNaN(t) || t < cutoff) {
      if (await deleteDraft(d.id)) removed++
    }
  }
  return removed
}
