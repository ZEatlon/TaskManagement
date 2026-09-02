/**
 * Electron Fuses 配置脚本
 * 用于在打包前反转/设置关键 fuses，保护应用安全
 * 运行：npm run fuses
 *
 * 该脚本既可以由 `node scripts/fuses.ts` 直接调用（npm run fuses），
 * 也可以在 Electron 进程内通过 `require('./scripts/fuses')` 引入执行。
 */
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve as pathResolve } from 'node:path'

const require = createRequire(import.meta.url)

/** 判定当前模块是否被作为入口直接执行（而非被其它模块 import） */
function isDirectEntry(): boolean {
  // Electron 运行时：总是执行（通常是 build 后由 Electron 主进程加载）
  if (typeof process !== 'undefined' && process.versions?.electron) return true;

  // 普通 Node ESM 入口判定：process.argv[1] 即入口脚本绝对路径
  // 这里用 import.meta.url（当前模块 URL）与 argv[1] 比较。
  // Windows 下 argv[1] 已是绝对路径；为兼容 dev (TS) 与 prod (JS)，
  // 直接字符串相等即可（与 npm script 中 `node scripts/fuses.ts` 一致）。
  const entry = process.argv[1]
  if (!entry) return false
  const selfPath = fileURLToPath(import.meta.url)
  return pathResolve(entry) === selfPath || entry === selfPath
}

if (isDirectEntry()) {
  flipFuses(require('electron'), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })
    .then(() => {
      console.log('[fuses] Electron fuses flipped successfully.')
    })
    .catch((err: unknown) => {
      console.error('[fuses] Failed to flip fuses:', err)
      process.exit(1)
    })
} else {
  console.log(
    '[fuses] Skipped: not invoked as main module or inside an Electron process. Use `npm run fuses` after building.',
  )
}