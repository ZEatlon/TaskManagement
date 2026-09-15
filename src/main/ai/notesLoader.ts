/**
 * 安全加载 notes 目录下所有 .md 笔记
 *
 * 抽取背景：searchNotes（R29-Sec-2）与 summarizeNote（R31-Sec-1）都需要
 * 「realpath(notesDir) + readdir .md + per-file realpath + isRealPathInside
 * + readFile」这一整套防 symlink 越狱的加载逻辑。之前两份工具各自重复
 * ~40 行相同 setup，未来任何加固（如 readFile 前 stat size cap / mtime
 * 过滤）都容易只补一边而漏另一边。本模块把整套加载抽成一个权威入口，
 * 两份工具只保留各自的 per-file 业务逻辑（substring 搜索 / frontmatter
 * 正则匹配）。
 *
 * 安全语义（与 R29-Sec-2 / R31-Sec-1 完全等价，不能弱化）：
 *   1. notesDir 必须能 realpath，失败则视为「目录不可访问」，不抛错；
 *      调用方根据 `ok: false` 自行决定返回 error 还是空结果。
 *   2. 每个 .md 文件单独 realpath；realpath 失败 / 越界 / readFile 失败
 *      都跳过并 warn，但不影响其它文件继续加载。
 *   3. 越界检查用 pathSafety.isRealPathInside，禁止 symlink / junction
 *      把任意文件喂给上层。
 */
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isRealPathInside } from '../notes/pathSafety'
import log from '../log'

/** 加载成功时返回的单个笔记：filename 用于结果展示 / prompt 模板，
 *  realPath 用于需要 stat 或其它直接 I/O 的场景（已通过 isRealPathInside），
 *  text 是 utf-8 内容。
 *
 *  R-fix-searchNotes-id-leak-and-summarizeNote-unreachable (HIGH schema-description-mismatch)：
 *  summarizeNote.description 引导 LLM 「先用 searchNotes 取 id 字段」，
 *  但 searchNotes 此前只返 { filename, title, snippet }。新增 `id` 字段
 * （解析 YAML frontmatter 的 `id:` 行；找不到时为 null），让 LLM 走
 *  searchNotes → summarizeNote 这条唯一 lookup-first 路径。 */
export interface SecureNote {
  /** 原始 basename（如 "todo.md"），不含目录前缀 */
  filename: string
  /** realpath 后验证 isRealPathInside(notesDir) 的绝对路径 */
  realPath: string
  /** utf-8 文本内容 */
  text: string
  /** frontmatter 的 `id:` 字段值（UUID 字符串），未声明则 null */
  id: string | null
}

export type LoadNotesResult =
  | { ok: true; notes: SecureNote[] }
  | { ok: false; error: string }

/** notes 在库下的相对路径（与 notesManager / notes IPC 一致） */
const NOTES_SUBDIR = join('.taskpilot', 'notes')

/**
 * 加载 library 下 `.taskpilot/notes/*.md` 中所有通过 realpath 包含检查的
 * 笔记。返回 tagged union：调用方可区分「目录不可访问」与「目录下确实
 * 没有 .md 文件」。
 */
export async function loadNotesReal(library: string): Promise<LoadNotesResult> {
  const notesDir = join(library, NOTES_SUBDIR)
  let realNotesDir: string
  try {
    realNotesDir = await realpath(notesDir)
  } catch (rootErr) {
    log.warn(`[ai/notesLoader] realpath(notesDir) failed for ${notesDir}:`, rootErr)
    return { ok: false, error: 'notes 目录不可访问' }
  }

  let entries: string[]
  try {
    entries = (await readdir(notesDir)).filter((f) => f.endsWith('.md'))
  } catch (readErr) {
    log.warn(`[ai/notesLoader] readdir(notesDir) failed for ${notesDir}:`, readErr)
    return { ok: false, error: 'notes 目录不可访问' }
  }

  const notes: SecureNote[] = []
  for (const f of entries) {
    const full = join(notesDir, f)
    let realFull: string
    try {
      realFull = await realpath(full)
    } catch (realErr) {
      log.warn(`[ai/notesLoader] realpath failed for ${full}:`, realErr)
      continue
    }
    if (!isRealPathInside(realFull, realNotesDir)) {
      log.warn(
        `[ai/notesLoader] skipping ${full}: realpath ${realFull} escapes notesDir`,
      )
      continue
    }
    let text = ''
    try {
      // 单个文件读失败/损坏不能让整次加载失败，跳过该文件继续。
      text = await readFileSafe(realFull)
    } catch (fileErr) {
      log.warn(`[ai/notesLoader] readFile failed for ${f}:`, fileErr)
      continue
    }
    notes.push({ filename: f, realPath: realFull, text, id: parseNoteIdFromFrontmatter(text) })
  }
  return { ok: true, notes }
}

/** 局部 readFile —— 仅在 helper 内使用，避免在文件顶部再 import 一遍 fs。 */
async function readFileSafe(realPath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(realPath, 'utf-8')
}

/**
 * 从 markdown 顶部 YAML frontmatter 中提取 `id:` 字段（仅第一行匹配）。
 *
 * R-fix-searchNotes-id-leak-and-summarizeNote-unreachable (HIGH)：
 * summarizeNote.description 引导 LLM 「先用 searchNotes 取 id 字段」，
 * 但 searchNotes 此前不返 id 字段；LLM 拿到 { filename, title, snippet }
 * 后无法拼出 UUID 形态的 noteId，再调 summarizeNote 必然被 isUuid() 拒。
 * 这里轻量正则只取 `^id: <value>` 的 value 部分（不引入 yaml 解析器——
 * - 走简化的「第一行匹配」路径与 createNote 写入侧的 yamlSafeName 风
 *   格一致；解析失败 / 未声明都返回 null，LLM 据此可走 listTags 风格
 *   的兜底（不强制要求所有笔记都有 id）。 */
function parseNoteIdFromFrontmatter(text: string): string | null {
  // 仅在文本以 `---` 开头且紧随 frontmatter 闭合 `---` 时解析
  if (!text.startsWith('---')) return null
  const closeIdx = text.indexOf('\n---', 3)
  if (closeIdx === -1) return null
  const header = text.slice(3, closeIdx)
  // 只匹配首行 id: 值，避免正则跨行匹配到正文里偶然的 `id: foo` 字面量
  const m = header.match(/^id:\s*([^\s#].*?)\s*$/m)
  if (!m) return null
  const value = m[1].trim()
  // 去掉两端可选引号（双引号 / 单引号），与 yaml 解析口径对齐
  const stripped = value.replace(/^['"]|['"]$/g, '')
  return stripped.length > 0 ? stripped : null
}
