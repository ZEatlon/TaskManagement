/**
 * 数据库客户端
 *
 * 通过 stdio JSON-RPC 与 sidecar worker 通信。
 * 所有 SQL 操作都经由此处转发。
 */
import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'
import log from '../log'

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export interface WorkerNotification {
  (method: string, params: unknown): void
}

export class DbClient {
  private worker: ChildProcess | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private ready = false
  private readyPromise: Promise<void> | null = null
  // R16 修复 (critical)：start() 内创建的 Promise 没有 reject 出口 —— 如果
  // worker 在发 'ready' 通知之前就退出（better-sqlite3 ABI 不匹配 / native panic /
  // spawn 即失败），await this.readyPromise 永久挂起。显式存 reject，让 exit handler
  // 在「worker died before ready」路径上 reject 当前 start()。
  private readyReject: ((err: Error) => void) | null = null
  private notificationHandlers = new Set<WorkerNotification>()
  private buffer = ''
  // R15 修复 (high)：worker 崩溃后自动 respawn，避免一次 OOM/native panic 把整个 app 永久打废。
  // 上限 3 次重试；连续失败后转入指数退避（1s / 4s / 16s），避免无谓紧贴 spawn。
  private respawnAttempts = 0
  private respawnTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private static readonly MAX_RESPAWN = 3
  private static readonly RESPAWN_BACKOFF_MS = [1000, 4000, 16000]

  // R23-DI-2 修复 (high data integrity)：better-sqlite3 在 BEGIN/COMMIT 之间
  // 必须保证**单线程独占**——一次只能有一个事务存活。原仓库内 12+ 处
  // BEGIN/COMMIT 跨多次 dbClient.call IPC，每次 await 都让出 Node 事件循环。
  // 串流 A 发 BEGIN → 让出 → 串流 B 也发 BEGIN → 「cannot start a transaction
  // within a transaction」抛错 → 走 catch 块对**A 的事务**发 ROLLBACK（错杀），
  // A 之后 UPDATE 落到事务外被自动提交，A 的 COMMIT 又 no-op。修复：在 JS
  // 侧加事务互斥锁，所有事务路径必须经过 runInTransaction(work) 进入；work
  // 内部仍由调用方自行发 BEGIN/COMMIT，互斥锁保证 work 在前一个事务完成
  // （COMMIT 或 ROLLBACK）前不会启动。非事务调用（普通 prepare/run/get）
  // 不受影响。
  private txLock: Promise<unknown> = Promise.resolve()

  // R25-DI-5 修复 (high cache-stale-after-respawn)：主进程侧的 Repository.stmtCache
  // 是按 SQL 文本缓存 stmtId 的 Map。worker 进程被 scheduleRespawn 重生后，
  // 新 worker 的 prepareCache 从 nextId=1 重新开始编号，但主进程 caches 里
  // 仍持有旧的 stmtId（5 / 17 / 42 ...）。下一次 prepare(sql) 命中 main 缓存
  // → 返回 stale stmtId → worker 侧 prepareCache.get(staleId) === undefined →
  // 「Invalid stmtId」抛错 → 整应用对该 SQL 路径永久失败，除非完全重启。
  //
  // 修复：所有 Repository 在构造时向 dbClient 注册一个 invalidate 回调；
  // worker respawn 成功后（new start() 拿到 ready）向所有注册回调广播
  // invalidate 信号，让每个 Repository 清空自己的 stmtCache。下一次 prepare
  // 看到缓存 miss 就重新走 dbClient.call('prepare', ...) 拿新 stmtId。
  private stmtCacheInvalidators = new Set<() => void>()

  /** Repository 在构造时调用，注册一个「worker 已重生」回调清空自己的 stmtCache。 */
  registerStmtCacheInvalidator(fn: () => void): () => void {
    this.stmtCacheInvalidators.add(fn)
    return () => this.stmtCacheInvalidators.delete(fn)
  }

  /**
   * 启动 sidecar worker 进程
   */
  async start(): Promise<void> {
    if (this.worker) return
    this.shuttingDown = false
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyReject = reject
      const onReady = (method: string) => {
        if (method === 'ready') {
          this.ready = true
          this.notificationHandlers.delete(onReady)
          this.readyReject = null
          resolve()
        }
      }
      this.notificationHandlers.add(onReady)
    })

    const workerPath = this.resolveWorkerPath()
    const nodePath = this.resolveNodePath()
    log.info(`[db-client] spawning node worker: ${nodePath} ${workerPath}`)

    this.worker = spawn(nodePath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.worker.stdout?.setEncoding('utf8')
    this.worker.stderr?.setEncoding('utf8')

    this.worker.stdout?.on('data', (chunk: string) => this.handleStdout(chunk))
    this.worker.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[db-worker stderr] ${chunk}`)
    })

    this.worker.on('exit', (code, signal) => {
      log.warn(`[db-client] worker exited code=${code} signal=${signal}`)
      this.worker = null
      this.ready = false
      // R16 修复 (critical)：如果 start() 仍在等 ready，worker 在发 ready 前就死了，
      // 必须 reject 让 initDatabase 失败而不是永久挂起（"splash window 永远转圈"）。
      const dyingBeforeReady = this.readyReject !== null
      if (dyingBeforeReady) {
        const reject = this.readyReject
        this.readyReject = null
        reject?.(new Error(`db worker died before ready (exit code=${code} signal=${signal})`))
        // 删除订阅的 onReady 监听器
        for (const h of Array.from(this.notificationHandlers)) {
          if (h.toString().includes('onReady')) this.notificationHandlers.delete(h)
        }
      }
      // 拒绝所有挂起的请求
      for (const [, p] of this.pending) {
        p.reject(new Error('Worker process exited'))
      }
      this.pending.clear()
      // R16 修复 (low)：worker 死前可能写出半截 JSON（缺尾部 \n），buffer 留着
      // 会与下一轮新 worker 的 ready 行粘连。exit handler 清 buffer。
      this.buffer = ''
      // R15 修复 (high)：自动 respawn。stop() 调用或初始 start 阶段不重连。
      // R16 修复 (critical)：只有「worker 曾成功 ready 过」才计入 respawnAttempts；
      // 如果 worker 在 ready 前就死（ABI / 路径错），直接放弃 respawn 循环，
      // 让 caller 拿到错误退出。否则 start() reject 后没人 await.then 回调里
      // 增加 attempts，scheduleRespawn() 会无限循环每秒重 spawn 同款崩的 worker。
      if (!this.shuttingDown) {
        if (dyingBeforeReady) {
          log.error('[db-client] worker died during startup; not scheduling respawn')
          return
        }
        this.scheduleRespawn()
      }
    })

    this.worker.on('error', (err) => {
      // R20 修复 (medium error-handling)：原 handler 只 log；'error' 事件
      // 触发后可能不再触发 'exit'（Windows 上 child 被 TaskKill / 某些
      // spawn 失败路径），所有 pending call() 的 Promise 永远挂起 → 渲染
      // 端 UI 卡死没有错误提示。复刻 exit handler 的 reject + cleanup 逻辑，
      // 并拒绝 start() 的 readyPromise（如果尚未 ready）。
      log.error('[db-client] worker spawn / runtime error', err)
      // 1. 拒绝所有 pending 请求
      for (const [, p] of this.pending) {
        p.reject(err instanceof Error ? err : new Error(String(err)))
      }
      this.pending.clear()
      // 2. 拒绝 start() 的 readyPromise（如果还在等 ready）
      if (this.readyReject) {
        const reject = this.readyReject
        this.readyReject = null
        reject(new Error(`db worker died before ready: ${err.message}`))
      }
      this.buffer = ''
    })

    await this.readyPromise
    log.info('[db-client] worker ready')
    // R25-DI-5：worker 复活（无论是初次 start 还是 respawn）都意味着新
    // worker 的 prepareCache 是干净的 nextId=1 起步，旧 stmtId 全部失效。
    // 立即广播 invalidate，强制所有 Repository 清缓存。否则下一次缓存命中
    // 会返回旧 stmtId，worker 侧找不到对应的 prepared statement → 「Invalid
    // stmtId」抛错 → 应用对该 SQL 路径永久失败。
    for (const inv of this.stmtCacheInvalidators) {
      try {
        inv()
      } catch (err) {
        log.error('[db-client] stmtCacheInvalidator threw', err)
      }
    }
  }

  /** 调度自动 respawn。指数退避；超 MAX_RESPAWN 次后停手（保留人工重启路径）。 */
  private scheduleRespawn(): void {
    if (this.respawnTimer || this.shuttingDown) return
    const attempt = this.respawnAttempts
    if (attempt >= DbClient.MAX_RESPAWN) {
      log.error(
        `[db-client] respawn aborted after ${attempt} attempts; user must restart the app`,
      )
      return
    }
    const delay = DbClient.RESPAWN_BACKOFF_MS[attempt] ?? 16000
    log.warn(`[db-client] scheduling respawn attempt ${attempt + 1}/${DbClient.MAX_RESPAWN} in ${delay}ms`)
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      // start() 内的 readyPromise 替换 / 内部 ready 状态会在 spawn 后被新 ready 信号覆盖。
      void this.start()
        .then(() => {
          this.respawnAttempts = 0
        })
        .catch((err) => {
          this.respawnAttempts += 1
          log.error(`[db-client] respawn failed (attempt ${this.respawnAttempts})`, err)
          this.scheduleRespawn()
        })
    }, delay)
  }

  /** 关闭 worker */
  async stop(): Promise<void> {
    this.shuttingDown = true
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
    }
    if (!this.worker) return
    try {
      await this.notify('shutdown', {})
    } catch (_) {
      // ignore
    }
    this.worker.kill()
    this.worker = null
    this.ready = false
  }

  /** 调用 worker 方法 */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.worker.stdin?.writable) {
        reject(new Error('Worker not available'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const payload = JSON.stringify({ id, method, params }) + '\n'
      this.worker.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  /** 通知 worker（不期待响应） */
  notify(method: string, params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      if (!this.worker || !this.worker.stdin?.writable) {
        resolve()
        return
      }
      const payload = JSON.stringify({ method, params }) + '\n'
      this.worker.stdin.write(payload, () => resolve())
    })
  }

  /**
   * 在事务互斥锁下执行 work()。
   *
   * work 内必须自行发 `dbClient.call('exec', { sql: 'BEGIN' })` 和 COMMIT /
   * ROLLBACK；runInTransaction 只负责**串行化**：在前一个事务完全收尾
   * （COMMIT 成功 / ROLLBACK 成功 / 异常）前，work 不会启动。
   *
   * 设计动机见 txLock 字段注释。本方法对外不感知 BEGIN/COMMIT，调用方仍
   * 保持原有的 4-5 步 IPC 事务语义。失败时锁会在下一个微任务里释放（catch
   * 不会传播给后续 work —— 它们各自独立 try/catch）。
   */
  runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const next = this.txLock.then(work, work)
    // 锁的释放只看"本 work 是否完成"，不再串接其结果——避免 work 抛错后
    // 后续 work 永远拿不到锁（Promise 链一断就截断）。
    this.txLock = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  isReady(): boolean {
    return this.ready
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: string }
    try {
      msg = JSON.parse(line)
    } catch (err) {
      log.error('[db-client] bad JSON from worker:', line)
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) {
        p.reject(new Error(msg.error))
      } else {
        p.resolve(msg.result)
      }
    } else if (msg.method) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(msg.method, msg.params)
        } catch (err) {
          log.error('[db-client] notification handler error', err)
        }
      }
    }
  }

  private resolveWorkerPath(): string {
    // 路径搜索顺序：
    // 1) 生产环境：electron-builder extraResources 把 scripts/ 落地到 resources/scripts/
    // 2) 开发环境：src/main 指向项目根 scripts/
    // 3) 单测 / 备用：cwd/scripts/
    const paths = [
      pathResolve(process.resourcesPath ?? '', 'scripts/db-worker.cjs'),
      pathResolve(__dirname, '../../scripts/db-worker.cjs'),
      pathResolve(process.cwd(), 'scripts/db-worker.cjs'),
    ]
    for (const p of paths) {
      if (existsSync(p)) return p
    }
    throw new Error(`Cannot locate db-worker.cjs. Searched: ${paths.join(', ')}`)
  }

  private resolveNodePath(): string {
    // 优先使用环境变量
    if (process.env['TASKPILOT_NODE_PATH']) {
      return process.env['TASKPILOT_NODE_PATH']
    }
    // 生产：extraResources 把 resources/node/ 落地到 resources/node/
    //   windows → resources/node/node.exe
    //   mac/linux → resources/node/node
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'node.exe' : 'node'
    const bundled = pathResolve(process.resourcesPath ?? '', 'node', exeName)
    if (existsSync(bundled)) return bundled
    // dev / 资源缺失 → 回退到 PATH 中的 node（用户需自行安装）
    return 'node'
  }
}

/** 单例 */
export const dbClient = new DbClient()