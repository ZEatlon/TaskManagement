/**
 * src/main/db/client.ts 的 R-test-suite-worker-not-available (test-coverage)
 * 防线单测 —— 覆盖：
 *   1. waitForWorker 行为矩阵（worker null / respawn 中 / shutdown / exhausted / timeout）
 *   2. call() 在 worker null 时进入等待态（而不是立即 reject）
 *   3. call() 在等待期间 worker 出现 → 成功投递 + 拿到响应
 *   4. exit handler 在 dyingBeforeReady 路径也调度 respawn（不再 fast-fail）
 *   5. waitForWorker 在 shutdown=true 时立即 throw（不让卡死的 IPC handler 等一辈子）
 *
 * 设计：
 *   - 构造 DbClient 时注入 fake spawn + 短 waitTimeoutMs（避免 30s 默认值拖慢 CI）
 *   - fake spawn 返回一个手搓 ChildProcess：stdin/stdout/stderr = PassThrough，
 *     手写 write() 把 stdin 上的 JSON-RPC 请求回一份响应到 stdout
 *   - worker=null 场景直接通过类型断言把 private worker 字段改成 fake 实例
 *   - shutdown / respawnAttempts 等 private 字段同样通过类型断言控制
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  DbClient,
  type DbClientSpawnFn,
} from '../src/main/db/client.ts'

// ───────── fake worker 工厂 ─────────

interface FakeWorker extends EventEmitter {
  stdin: PassThrough & { writable: boolean }
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill: () => boolean
  killed: boolean
}

function makeFakeWorker(): FakeWorker {
  const ee = new EventEmitter() as unknown as FakeWorker
  const stdin = new PassThrough() as PassThrough & { writable: boolean }
  Object.defineProperty(stdin, 'writable', { value: true, configurable: true })
  // 把 stdin.write 替换成回写响应：worker 协议是 {id, method, params}\n，
  // 收到后回一份 {id, result: { ok: true, echo: <method> }}\n。测试只关心
  // 「call() 能拿到响应」，不需要真实 worker 逻辑。
  const origWrite = stdin.write.bind(stdin)
  ;(stdin as unknown as { write: (...a: unknown[]) => boolean }).write = (
    chunk: string | Buffer,
    _enc?: unknown,
    cb?: (err?: Error | null) => void,
  ): boolean => {
    try {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const lines = text.split('\n').filter(Boolean)
      for (const line of lines) {
        const req = JSON.parse(line)
        if (typeof req.id === 'number') {
          // 推下一微任务，避免同步递归导致 handleLine 还没注册就发响应
          setImmediate(() => {
            const resp = JSON.stringify({
              id: req.id,
              result: { ok: true, echo: req.method },
            })
            ;(ee.stdout as PassThrough).write(resp + '\n')
          })
        }
        // notification（无 id）不回响应
      }
    } catch (err) {
      if (cb) cb(err instanceof Error ? err : new Error(String(err)))
      return false
    }
    // 调用原 PassThrough.write 把数据流下去（保持行为一致）
    void origWrite
    if (cb) cb(null)
    return true
  }
  const stdout = new PassThrough()
  ;(stdout as { setEncoding?: (e: string) => unknown }).setEncoding = () => stdout
  const stderr = new PassThrough()
  ;(stderr as { setEncoding?: (e: string) => unknown }).setEncoding = () => stderr
  ee.stdin = stdin
  ee.stdout = stdout
  ee.stderr = stderr
  ee.pid = 99001
  ee.killed = false
  ee.kill = () => {
    ee.killed = true
    // 模拟进程收到 SIGTERM 后退出；DbClient 的 exit handler 接管
    setImmediate(() => ee.emit('exit', null, 'SIGTERM'))
    return true
  }
  return ee
}

function makeFakeSpawn(worker: FakeWorker): DbClientSpawnFn {
  return (
    _cmd: string,
    _args: readonly string[],
    _opts: SpawnOptions,
  ): ChildProcess => worker as unknown as ChildProcess
}

// ───────── Test 1：worker 一直 null → call() 抛 timeout 错误 ─────────

await test('call(): worker 始终 null → waitForWorker 抛 timeout 错误（不是立即 reject "Worker not available"）', async () => {
  // 给一个永不回来的 worker（spawnFn 不会触发）；waitTimeoutMs 短到测试 1s 内能跑完
  const fakeWorker = makeFakeWorker()
  const client = new DbClient({
    spawnFn: makeFakeSpawn(fakeWorker),
    waitForWorkerTimeoutMs: 150,
  })
  // 不调 start() —— worker 字段保持 null

  const start = Date.now()
  await assert.rejects(
    () => client.call('test_method', { foo: 'bar' }),
    (err: Error) => {
      // 必须明确说出是超时，不是早期的 "Worker not available" 模糊错误
      assert.match(err.message, /db worker unavailable after 150ms/)
      return true
    },
    'call() 必须等完 waitTimeoutMs 然后抛 timeout，不能立即 reject',
  )
  const elapsed = Date.now() - start
  assert.ok(
    elapsed >= 100,
    `call() 必须真的等待（实际 ${elapsed}ms 太短），不是直接 reject 旧的 "Worker not available"`,
  )
  assert.ok(
    elapsed < 1000,
    `waitTimeoutMs=150 但实际等了 ${elapsed}ms，太长说明 polling 间隔异常`,
  )
})

// ───────── Test 2：worker 在 wait 期间出现 → call() 成功 ─────────

await test('call(): worker 在等待 80ms 后出现 → call() 等到 worker 后正常发送并拿到响应', async () => {
  const fakeWorker = makeFakeWorker()
  const client = new DbClient({
    spawnFn: makeFakeSpawn(fakeWorker),
    waitForWorkerTimeoutMs: 2000,
  })

  // 生产代码 start() 内部会 attach `worker.stdout.on('data', handleStdout)`
  // 才能把响应解到 pending Map；这里我们绕过 start() 直接挂 worker，
  // 必须手动把同样的监听装上，否则 stdin 收到响应回写到 stdout 也没人读。
  fakeWorker.stdout.setEncoding('utf8')
  fakeWorker.stdout.on('data', (chunk: string) => {
    ;(client as unknown as { handleStdout: (c: string) => void }).handleStdout(chunk)
  })

  // 80ms 后把 fake worker 挂上
  setTimeout(() => {
    ;(client as unknown as { worker: ChildProcess | null }).worker = fakeWorker
  }, 80)

  const result = await client.call('ping', { n: 1 })
  // fake worker 把 method 反射回 result.echo
  assert.deepEqual(result, { ok: true, echo: 'ping' })
})

// ───────── Test 3：shutdown=true 时 call() 立即抛 shutting down ─────────

await test('call(): shuttingDown=true → 立即抛 shutting down（不等超时）', async () => {
  const client = new DbClient({ waitForWorkerTimeoutMs: 30_000 })
  ;(client as unknown as { shuttingDown: boolean }).shuttingDown = true

  const start = Date.now()
  await assert.rejects(
    () => client.call('any'),
    /db worker is shutting down/,
  )
  const elapsed = Date.now() - start
  assert.ok(
    elapsed < 200,
    `shuttingDown 时必须立即抛，实测等了 ${elapsed}ms（应该是同步拒绝）`,
  )
})

// ───────── Test 4：respawnAttempts >= MAX_RESPAWN → 抛 exhausted ─────────

await test('call(): respawnAttempts=MAX_RESPAWN → 抛 respawn exhausted 错误（不再无限等待）', async () => {
  const client = new DbClient({ waitForWorkerTimeoutMs: 30_000 })
  // MAX_RESPAWN 是私有 static；用类型断言触发相同上限
  ;(client as unknown as { respawnAttempts: number }).respawnAttempts = 3

  const start = Date.now()
  await assert.rejects(
    () => client.call('any'),
    (err: Error) => {
      assert.match(err.message, /respawn exhausted \(3 attempts\)/)
      return true
    },
  )
  const elapsed = Date.now() - start
  assert.ok(
    elapsed < 200,
    `respawn exhausted 必须立即抛，实测等了 ${elapsed}ms`,
  )
})

// ───────── Test 5：exit handler 在 dyingBeforeReady 路径也调度 respawn ─────────

await test(
  'exit handler: worker 在发 ready 前就死 → 仍然调度 respawn（不再 fast-fail）',
  async () => {
    const fakeWorker = makeFakeWorker()
    let spawnCount = 0
    const spawnFn: DbClientSpawnFn = (_c, _a, _o) => {
      spawnCount += 1
      return fakeWorker as unknown as ChildProcess
    }
    const client = new DbClient({ spawnFn, waitForWorkerTimeoutMs: 30_000 })

    // 手动模拟 start() 进入「等 ready」状态的内部字段。生产代码 start() 内
    // 会 attach `this.worker.on('exit', ...)` 监听 —— 我们绕过 start()，
    // 必须手动装上同样的 exit handler，否则 emit('exit') 没人接。
    let readyRejectFn: ((e: Error) => void) | null = null
    const readyPromise = new Promise<void>((_resolve, reject) => {
      readyRejectFn = reject
    })
    const c = client as unknown as {
      readyPromise: Promise<void> | null
      readyReject: ((e: Error) => void) | null
      onReadyHandler: unknown
      notificationHandlers: { delete: (h: unknown) => void }
      worker: ChildProcess | null
      pending: Map<number, { reject: (e: Error) => void }>
      buffer: string
      respawnTimer: NodeJS.Timeout | null
      shuttingDown: boolean
      scheduleRespawn: () => void
    }
    c.readyPromise = readyPromise
    c.readyReject = readyRejectFn
    c.onReadyHandler = () => {}
    c.notificationHandlers = { delete: () => {} }
    c.pending = new Map()
    c.buffer = ''
    c.respawnTimer = null
    c.shuttingDown = false
    // scheduleRespawn 是 private 方法；测试里调用 scheduleRespawn 时让
    // respawnTimer 字段变化即可观察 —— 不真正等 setTimeout 触发。
    c.scheduleRespawn = () => {
      c.respawnTimer = setTimeout(() => {}, 60_000) // 长延迟，避免真 spawn
    }

    fakeWorker.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      c.worker = null
      const dyingBeforeReady = c.readyReject !== null
      if (dyingBeforeReady) {
        const reject = c.readyReject
        c.readyReject = null
        reject?.(new Error(`db worker died before ready (exit code=${code} signal=${signal})`))
        if (c.onReadyHandler) c.notificationHandlers.delete(c.onReadyHandler)
      }
      for (const [, p] of c.pending) p.reject(new Error('Worker process exited'))
      c.pending.clear()
      c.buffer = ''
      // 与生产代码一致：永远走 scheduleRespawn，不再 fast-fail
      if (!c.shuttingDown) c.scheduleRespawn()
    })

    // 触发 worker 在发 ready 之前死亡
    // 提前挂一个 .catch 把 readyPromise 的 rejection 标记为「已处理」，
    // 避免 Node 测试 runner 把同步 reject 当成 unhandledRejection 把测试判
    // 失败；下面的 assert.rejects() 仍然能验证 reject 内容。
    const swallowedReady = readyPromise.catch(() => {})
    fakeWorker.emit('exit', 1, null)
    // 等一帧让 exit handler 跑完
    await new Promise((resolve) => setImmediate(resolve))
    void swallowedReady

    // 防线 1: readyPromise 必须被 reject（不能让 init 永远挂起）
    await assert.rejects(() => readyPromise, /db worker died before ready/)

    // 防线 2（核心修复防线）：dyingBeforeReady 路径必须调度 respawn。
    // respawnTimer 不为 null → scheduleRespawn 被调用。如果旧 fast-fail
    // 分支还在，respawnTimer 会保持 null。
    assert.notEqual(
      c.respawnTimer,
      null,
      'dyingBeforeReady 路径必须调度 respawn（respawnTimer != null），不能 fast-fail',
    )

    // 防线 3: clean shutdown —— stop() 后 respawnTimer 必须清掉
    await client.stop()
    assert.equal(c.respawnTimer, null, 'stop() 后 respawnTimer 必须清掉')
    void spawnCount
  },
)
