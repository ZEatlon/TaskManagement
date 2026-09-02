/**
 * Postinstall 钩子
 *
 * 策略：
 *   1. 运行 Electron 自己的 install.js：仅下载 Electron 二进制（@electron/get + extract-zip，纯 JS），
 *      不涉及原生模块编译。Electron 33+ 默认二进制也包含了一份 libnode，
 *      其 ABI 与 better-sqlite3 的 Node 24 prebuild 也不兼容——但我们用 sidecar
 *      跑 better-sqlite3，所以不在乎。
 *
 *   2. **不调用** `electron-builder install-app-deps`：
 *      - better-sqlite3 由独立 sidecar 进程（系统 Node 24）加载，使用 Node 24 ABI 的 prebuild
 *      - sharp 用 prebuild-install 下载预编译二进制
 *      - chokidar v4 / gray-matter / isomorphic-git 都是纯 JS
 *      因此无需为 Electron ABI 重建任何原生模块。
 *
 * 何时需要重建？
 *   - 如果遇到运行时 `Error: The module ... was compiled against a different Node.js version`
 *     说明 prebuild 与当前 Node ABI 不匹配，可手动执行：
 *     `npm run rebuild:native`
 *   - 但本项目 main 进程不直接 require 任何原生模块（better-sqlite3 通过子进程），
 *     因此正常情况下**不会**遇到该错误
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { readFileSync, writeFileSync, existsSync } = require('node:fs')

console.log('[postinstall] TaskPilot 使用 sidecar + prebuild 模式')

// 1) 下载 Electron 二进制（仅当缺失时 install.js 内部会跳过）
const electronInstall = path.resolve(__dirname, '../node_modules/electron/install.js')
try {
  console.log('[postinstall] 1/3 下载 Electron 二进制...')
  // 默认走 npmmirror，避开 github.com 在国内常见的不稳定；
  // 若用户已设置 ELECTRON_MIRROR 则尊重用户选择
  const childEnv = { ...process.env }
  if (!childEnv.ELECTRON_MIRROR) {
    childEnv.ELECTRON_MIRROR = 'https://cdn.npmmirror.com/binaries/electron/'
  }
  const r = spawnSync(process.execPath, [electronInstall], {
    stdio: 'inherit',
    env: childEnv,
  })
  if (r.status !== 0) {
    console.warn(`[postinstall] Electron install 退出码 ${r.status}（通常可忽略：已下载则跳过）`)
  }
} catch (err) {
  console.warn('[postinstall] Electron install 失败（可手动运行 npx electron）：', err.message)
}

// 2) 修复 path.txt：Electron 官方 install.js 写入时会带换行符，
//    electron-vite 的 spawn 会把换行也拼到可执行路径里，导致 ENOENT
const pathTxt = path.resolve(__dirname, '../node_modules/electron/path.txt')
try {
  if (existsSync(pathTxt)) {
    const content = readFileSync(pathTxt, 'utf8')
    if (content !== content.trim()) {
      writeFileSync(pathTxt, content.trim())
      console.log('[postinstall] 2/3 修复 path.txt 换行符')
    } else {
      console.log('[postinstall] 2/3 path.txt 已正常')
    }
  } else {
    console.log('[postinstall] 2/3 path.txt 尚未生成（Electron 二进制下载失败？）')
  }
} catch (err) {
  console.warn('[postinstall] 修复 path.txt 失败：', err.message)
}

// 3) 跳过 electron-builder install-app-deps
console.log('[postinstall] 3/3 跳过 electron-builder install-app-deps（无原生模块需要重建）')
console.log('[postinstall] 如需强制重建，运行: npm run rebuild:native')
console.log('[postinstall] ✓ 完成')