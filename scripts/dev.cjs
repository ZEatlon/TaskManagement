/**
 * Dev 启动包装：绕开系统环境变量 + 自愈 zombie electron 进程
 *
 * 解决的三个历史坑：
 *
 * 1. ELECTRON_RUN_AS_NODE=1（用户机器上设的系统级环境变量）会让
 *    electron.exe 以纯 Node.js 模式启动 —— process.type=undefined、
 *    require('electron') 返回的是字符串而不是 API 对象 → 主进程在
 *    `electron.app.isPackaged` 第一次访问时崩 → 所有 IPC handler
 *    永远没注册 → 渲染端所有按钮「点击没反应」。
 *    → 这里用 delete（不是设空串，Windows + cmd.exe 链路上空串
 *    会被还原为 set 状态）显式清掉。
 *
 * 2. 上次 dev 进程被 Ctrl+C / 异常退出后，electron.exe 可能残留
 *    4+ 个 zombie 进程（每个 100-200 MB），继续持有单实例锁
 *    （`app.requestSingleInstanceLock()`）。下次 npm run dev 启动
 *    → 新进程拿不到锁 → 立刻 `app.quit()` 退出 → IPC handler 全部
 *    没注册 → 又是所有按钮没反应。
 *    → 启动前主动 taskkill 掉全部 electron.exe（exclude 当前 PID），
 *    把僵尸清干净。
 *
 * 3. 之前 `child.kill('SIGTERM')` 在 Windows 上对 electron 子进程
 *    不一定生效 → 进程树残留。改用 taskkill /T /F 强杀，确保退出
 *    时连同所有子进程一起清。
 */
const { spawn, execFile } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '..')
const electronVite = path.resolve(projectRoot, 'node_modules', '.bin', 'electron-vite')
const isWin = process.platform === 'win32'

/**
 * 杀光**本项目**残留的 electron.exe（zombie）。
 *
 * 历史：旧版本无差别 taskkill 系统里所有 electron.exe —— 在开发者
 * 同时开着 VS Code / Slack / Discord（它们都是 Electron）时会被一起
 * 误杀，丢未保存的代码 / 聊天记录。修复：只杀 MainWindowTitle 包含
 * "TaskPilot" 的进程；找不到就什么都不做（用户可以手动清理）。
 *
 * - 当前进程 PID 排除（避免自杀）
 * - 失败也吞掉 —— 没有 taskkill 时跳过（macOS / Linux）
 */
function killStaleElectron() {
  if (!isWin) return
  const currentPid = process.pid
  // /V 带上窗口标题；CSV 输出多一列 WindowTitle。tasklist 在没有可见
  // 窗口的进程上 WindowTitle 为空字串，可以借此过滤。
  execFile(
    'tasklist',
    ['/FI', 'IMAGENAME eq electron.exe', '/NH', '/FO', 'CSV', '/V'],
    (err, stdout) => {
      if (err || !stdout) return
      const pids = []
      const seen = new Set()
      for (const line of stdout.split(/\r?\n/)) {
        // CSV 列: ImageName,PID,SessionName,SessionNum,MemUsage,Status,UserName,CPU,WindowTitle
        // WindowTitle 可能含逗号 / 双引号转义，所以匹配从行尾倒数第一个
        // 完整 CSV 字段开始往前推。这里用更稳的方式：只匹配 PID 与最后
        // 一个字段（去除首尾引号）。
        const m = line.match(/^"electron\.exe","(\d+)"(.*)$/)
        if (!m) continue
        const pid = Number(m[1])
        if (pid === currentPid || seen.has(pid)) continue
        const rest = m[2]
        // WindowTitle 是 CSV 的最后一个字段，可能带引号；剥掉末尾的引号后
        // 判断是否含 TaskPilot。
        const titleMatch = rest.match(/,"TaskPilot"$/i) || rest.match(/,"?TaskPilot"?$/i)
        if (!titleMatch) continue
        seen.add(pid)
        pids.push(pid)
      }
      if (pids.length === 0) {
        console.log('[dev wrapper] no stale TaskPilot electron.exe to clean up')
        return
      }
      console.log(`[dev wrapper] killing ${pids.length} stale TaskPilot electron.exe: ${pids.join(', ')}`)
      // /T = 连子进程一起杀；/F = 强制
      execFile(
        'taskkill',
        ['/F', '/T', ...pids.flatMap((p) => ['/PID', String(p)])],
        (killErr) => {
          if (killErr) {
            console.log('[dev wrapper] taskkill error (ignored):', killErr.message)
          } else {
            console.log('[dev wrapper] stale TaskPilot electron.exe cleaned up')
          }
        },
      )
    },
  )
}

// 启动前先清 zombie
killStaleElectron()
// 等 taskkill 真正生效（避免新旧锁竞争）
setTimeout(spawnElectronVite, 800)

function spawnElectronVite() {
  // 强制覆盖：即使父进程被 set ELECTRON_RUN_AS_NODE=1，这里也清掉
  // 关键：必须用 delete 而不是设为 '' —— 空字符串在 Windows 上会被
  // cmd.exe 还原为 set 状态，spawn + shell:true 的链路上 '' 不一定生效。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  console.log(
    `[dev wrapper] ELECTRON_RUN_AS_NODE cleared (was: ${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'})`,
  )

  const child = spawn(electronVite, ['dev'], {
    stdio: 'inherit',
    env,
    shell: isWin,
  })

  child.on('exit', (code, signal) => {
    console.log(`[dev wrapper] electron-vite exited code=${code} signal=${signal}`)
    process.exit(code ?? 0)
  })

  // Ctrl+C / 关终端时也要强杀 electron 子进程树
  // 单纯 child.kill(SIGTERM) 在 Windows 上不可靠 —— electron main
  // 经常 trap 不响应；taskkill /F /T 才是稳的。
  function killChildTree() {
    if (isWin && child.pid) {
      execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => {})
    } else {
      child.kill('SIGTERM')
    }
  }
  process.on('SIGINT', () => {
    console.log('[dev wrapper] SIGINT received, killing child tree')
    killChildTree()
    // 给 taskkill 一点时间落盘再退出
    setTimeout(() => process.exit(130), 500)
  })
  process.on('SIGTERM', () => {
    console.log('[dev wrapper] SIGTERM received, killing child tree')
    killChildTree()
    setTimeout(() => process.exit(143), 500)
  })
}
