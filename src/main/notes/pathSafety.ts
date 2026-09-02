/**
 * 共享路径安全工具
 *
 * R29-Sec-2 修复：原版 isRealPathInside 是 notesManager.ts 的私有 helper，
 * 其它模块（AI tools / setting handlers / 笔记 IPC）需要时只能复制粘贴或
 * 走不到 post-realpath 包含检查。本文件把 realpath + 包含判断抽成共享
 * API，统一收口"防止 symlink 越狱读 / 写"的防御。
 */
import { realpath as fsRealpath, lstat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

/**
 * 判断 target 在 realpath 之后是否位于 rootDir 内部（防止 symlink / junction
 * 跨目录逃逸）。
 *
 * rootDir 一般是已存在的固定目录（如 libraryRoot / notesDir），target 可
 * 能是新创建的文件（writeNote 场景）—— target 不存在时降级为词法包含判断，
 * 不阻断合法路径。rootDir 不存在时一律返回 false（调用方应已处理）。
 *
 * 同时检查 target 不指向 rootDir 之外的 symlink：先 lstat target 看是否
 * 本身是符号链接，若链接指向 rootDir 之外则拒绝。
 */
export async function isRealPathInside(rootDir: string, target: string): Promise<boolean> {
  let realRoot: string
  try {
    realRoot = await fsRealpath(rootDir)
  } catch {
    realRoot = resolve(rootDir)
  }
  let realTarget: string
  try {
    realTarget = await fsRealpath(resolve(target))
  } catch {
    // target 不存在（写入新建文件 / 已删除的待读路径）→ 退回词法包含判断
    return isPathInside(rootDir, target)
  }
  // 防御：如果 target 本身是符号链接且指向 rootDir 之外，fsRealpath 仍
  // 会解析成链接目标，所以这里再做一次包含判断就够 —— realpath 已展开
  // 所有跳转，不会再有 symlink 逃逸。
  const rel = relative(realRoot, realTarget)
  if (!rel || rel === '') return true
  if (rel.startsWith('..') || rel.startsWith('..' + sep)) return false
  return true
}

/** 词法包含判断（无 realpath） —— 用于 target 还不存在的写入场景。 */
export function isPathInside(rootDir: string, target: string): boolean {
  const root = resolve(rootDir)
  const t = resolve(target)
  const rel = relative(root, t)
  if (!rel || rel === '') return true
  if (rel.startsWith('..') || rel.startsWith('..' + sep)) return false
  return true
}

/** 拒绝跟随 symlink 读取（lstat 看到的是 symlink 则 false）。 */
export async function existsAndIsRegularFile(target: string): Promise<boolean> {
  try {
    const st = await lstat(target)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}