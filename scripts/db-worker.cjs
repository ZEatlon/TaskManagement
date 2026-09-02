#!/usr/bin/env node
/**
 * 数据库 Sidecar Worker
 *
 * 独立 Node 进程，运行 better-sqlite3（system Node 24 ABI 的预编译二进制）。
 * 通过 stdio JSON-RPC 与 Electron 主进程通信。
 *
 * 协议：
 *   请求：{ id: number, method: string, params: object }
 *   响应：{ id: number, result?: any, error?: string }
 *   通知：{ method: string, params: object }  // 单向
 */

const path = require('node:path')
const fs = require('node:fs')

let Database
try {
  Database = require('better-sqlite3')
} catch (err) {
  fatal(`Failed to load better-sqlite3: ${err.message}`)
}

/** @type {import('better-sqlite3').Database | null} */
let db = null

/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pending = new Map()
let nextId = 1

const METHODS = {
  ping() {
    return { pong: Date.now(), pid: process.pid }
  },

  open({ filePath }) {
    if (db) close()
    db = new Database(filePath, { fileMustExist: false })
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('temp_store = MEMORY')
    return { ok: true }
  },

  close() {
    if (db) {
      db.close()
      db = null
    }
    return { ok: true }
  },

  exec({ sql }) {
    if (!db) throw new Error('Database not opened')
    db.exec(sql)
    return { ok: true }
  },

  prepare({ sql }) {
    if (!db) throw new Error('Database not opened')
    return { stmtId: prepareCache.alloc(db.prepare(sql)) }
  },

  finalize({ stmtId }) {
    prepareCache.free(stmtId)
    return { ok: true }
  },

  run({ stmtId, params = [] }) {
    const stmt = prepareCache.get(stmtId)
    if (!stmt) throw new Error('Invalid stmtId')
    return stmt.run(...params)
  },

  get({ stmtId, params = [] }) {
    const stmt = prepareCache.get(stmtId)
    if (!stmt) throw new Error('Invalid stmtId')
    return stmt.get(...params) || null
  },

  all({ stmtId, params = [] }) {
    const stmt = prepareCache.get(stmtId)
    if (!stmt) throw new Error('Invalid stmtId')
    return stmt.all(...params)
  },

  /**
   * R7P-6 修复：在 BEGIN/COMMIT 块里执行多个 prepared statement 调用，全部成功才提交。
   *
   * 原 transaction 方法签名是 db.transaction(fn) 但被错误地写成
   * `trx.apply(db, [fn])` —— better-sqlite3 的 db.transaction(fn) 返回的是
   * 一个包装函数，应该这样调用 trx(...args)。原实现既不是真正的事务，也
   * 从未被任何调用方使用（grep 全仓库 0 个 transaction 调用方）。这里替换为
   * steps[] 形式，更通用且对调用方清晰。
   *
   * steps: [{ stmtId, params: any[] }] —— 按顺序执行，任一抛出则 ROLLBACK。
   * 返回: { results: any[] } —— 顺序对应每个 step 的返回值（stmt.run 的结果）。
   */
  transaction({ steps }) {
    if (!db) throw new Error('Database not opened')
    if (!Array.isArray(steps)) throw new Error('transaction: steps must be array')
    const trx = db.transaction((items) => {
      const results = []
      for (const item of items) {
        const stmt = prepareCache.get(item.stmtId)
        if (!stmt) throw new Error(`Invalid stmtId: ${item.stmtId}`)
        results.push(stmt.run(...(item.params ?? [])))
      }
      return results
    })
    const results = trx(steps)
    return { results }
  },

  pragma({ sql }) {
    if (!db) throw new Error('Database not opened')
    return db.pragma(sql)
  },

  vacuum() {
    if (!db) throw new Error('Database not opened')
    db.exec('VACUUM')
    return { ok: true }
  },

  stats() {
    if (!db) throw new Error('Database not opened')
    const pageCount = db.pragma('page_count', { simple: true })
    const pageSize = db.pragma('page_size', { simple: true })
    return {
      sizeBytes: pageCount * pageSize,
      pageCount,
      pageSize,
    }
  },
}

/** 简单的 stmt 缓存 */
const prepareCache = (() => {
  /** @type {Map<number, any>} */
  const items = new Map()
  let next = 1
  // R11 修复 (medium #40)：原版 prepareCache 完全无界 —— 任何忘记调 finalize 的
  // 调用方都会让 items Map 累积 stmt 句柄（每个 ~KB 级 + better-sqlite3 内部
  // 持有 native handle），最终触发 SQLITE_MAX_PREPARED_STATEMENTS（默认 16384）
  // → allocate 抛错，全部 SQL 操作停止。加入软上限：超过 SOFT_LIMIT 时按 Map
  // 插入顺序（= FIFO）evict 最旧的句柄并 finalize。理想做法是所有调用方都
  // finalize，但作为兜底保护避免进程长时间运行后整个 DB worker 不可用。
  const SOFT_LIMIT = 4096
  return {
    alloc(stmt) {
      const id = next++
      items.set(id, stmt)
      while (items.size > SOFT_LIMIT) {
        const oldestId = items.keys().next().value
        if (typeof oldestId !== 'number') break
        const oldestStmt = items.get(oldestId)
        try {
          oldestStmt?.finalize?.()
        } catch (_) {
          // ignore
        }
        items.delete(oldestId)
        process.stderr.write(
          `[db-worker] prepareCache LRU-evicted stmtId=${oldestId} (size=${items.size})\n`,
        )
      }
      return id
    },
    get(id) {
      return items.get(id)
    },
    free(id) {
      const stmt = items.get(id)
      if (stmt) {
        try {
          stmt.finalize ? stmt.finalize() : null
        } catch (_) {
          // ignore
        }
        items.delete(id)
      }
    },
    clear() {
      for (const [id] of items) {
        try {
          items.get(id)?.finalize?.()
        } catch (_) {
          // ignore
        }
      }
      items.clear()
    },
  }
})()

function send(obj) {
  const json = JSON.stringify(obj) + '\n'
  if (process.stdout.writable) {
    process.stdout.write(json)
  }
}

function sendResult(id, result) {
  send({ id, result })
}

function sendError(id, message) {
  send({ id, error: message })
}

function sendNotification(method, params) {
  send({ method, params })
}

function fatal(message) {
  process.stderr.write(`[db-worker] FATAL: ${message}\n`)
  process.exit(1)
}

/** 处理一行 JSON 请求 */
function handleLine(line) {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch (err) {
    process.stderr.write(`[db-worker] Bad JSON: ${line}\n`)
    return
  }

  // 通知（无 id）
  if (typeof req.id === 'undefined' && req.method) {
    if (req.method === 'shutdown') {
      gracefulShutdown()
    }
    return
  }

  const { id, method, params = {} } = req
  const fn = METHODS[method]
  if (!fn) {
    sendError(id, `Unknown method: ${method}`)
    return
  }
  try {
    const result = fn(params)
    sendResult(id, result)
  } catch (err) {
    sendError(id, err && err.message ? err.message : String(err))
  }
}

function gracefulShutdown() {
  prepareCache.clear()
  if (db) {
    try {
      db.close()
    } catch (_) {
      // ignore
    }
  }
  process.exit(0)
}

// 启动信号
sendNotification('ready', { pid: process.pid })

// 监听 stdin
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    handleLine(line)
  }
})

process.stdin.on('end', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// 防止意外退出
process.on('uncaughtException', (err) => {
  process.stderr.write(`[db-worker] uncaught: ${err.stack || err.message}\n`)
})
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[db-worker] unhandled rejection: ${err}\n`)
})

// 通知主进程 stderr 用于日志
const origStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, encoding, cb) => {
  // 将 worker 的 stderr 直接透传
  return origStderrWrite(chunk, encoding, cb)
}