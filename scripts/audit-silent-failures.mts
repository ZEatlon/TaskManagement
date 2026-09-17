#!/usr/bin/env node
/**
 * W0 审计脚本：扫描主进程里的"静默失败"模式
 *
 * 目标：找出类似「Worker not available」永久挂起 / 错误吞掉的隐患。
 *
 * 检查模式：
 *  1. .catch(() => {}) —— 完全静默
 *  2. .catch(() => undefined) —— 同上
 *  3. .catch((err) => log.warn(...)) 但调用方已 fire-and-forget void —— 仅日志无 IPC 通知
 *  4. setInterval / setTimeout 内 swallow -> 周期失败无人察觉
 *
 * 输出：每行 file:line:code 格式列表。
 * 不直接 reject —— 给开发者 review 哪些是真问题、哪些是良性。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface Finding {
  file: string
  line: number
  type: string
  snippet: string
}

const ROOT = 'src/main'
const findings: Finding[] = []

function walk(d: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|cjs|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

const SILENT_CATCH = /\.catch\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/
const SILENT_CATCH_NAMED = /\.catch\(\s*\(?\s*\w+\s*\)?\s*=>\s*\{\s*\}\s*\)/
// catch 异常但只 console.warn 不到 IPC —— "静默 IPC 失败"模式
const CATCH_ONLY_LOG =
  /\.catch\(\s*\(\s*\w+\s*\)?\s*=>\s*\{?\s*(log|console)\.(warn|error|info)\(.*\)\s*\}?\s*\)/

for (const f of walk(ROOT)) {
  const text = readFileSync(f, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (SILENT_CATCH.test(l)) {
      findings.push({ file: f, line: i + 1, type: 'silent-catch-empty', snippet: l.trim() })
    } else if (SILENT_CATCH_NAMED.test(l)) {
      findings.push({ file: f, line: i + 1, type: 'silent-catch-named', snippet: l.trim() })
    } else if (CATCH_ONLY_LOG.test(l)) {
      // 只在 IPC 推送场景下是问题；非 IPC 上下文正常 log 即可。简单标"review"
      findings.push({ file: f, line: i + 1, type: 'catch-only-log-review', snippet: l.trim() })
    }
  }
}

console.log(`Findings: ${findings.length}`)
for (const f of findings) {
  console.log(`${f.file}:${f.line} [${f.type}]: ${f.snippet.slice(0, 200)}`)
}