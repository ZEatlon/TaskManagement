/**
 * 库目录初始化器
 *
 * 职责：
 *   在用户选定的目录中创建 .taskpilot 子目录骨架，
 *   用于存放笔记、附件等用户内容文件。
 *
 * 目录结构：
 *   <libraryPath>/
 *     .taskpilot/
 *       tasks/
 *       notes/
 *       attachments/
 *       README.md
 *       .gitignore
 */
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { constants } from 'node:fs/promises'
import log from '../log'

/** .taskpilot 元目录名（隐藏目录，避免污染用户视图） */
export const TASKPILOT_DIR = '.taskpilot'

/** 子目录：任务相关导出文件 */
export const TASKS_DIR = 'tasks'
/** 子目录：笔记文件 */
export const NOTES_DIR = 'notes'
/** 子目录：附件（图片、PDF 等） */
export const ATTACHMENTS_DIR = 'attachments'

/** README 模板 */
const README_CONTENT = `# TaskPilot 库

这是 TaskPilot 为你创建的个人内容库目录。

## 目录结构

- \`tasks/\`     任务导出（按月组织，如 tasks/2026-08/）
- \`notes/\`     笔记文件（Markdown 格式）
- \`attachments/\` 任务与笔记的附件

## 说明

- 你可以随时把整个目录加入 Git、网盘或外部备份
- 直接在文件管理器中编辑 \`notes/\` 下的 Markdown 文件，TaskPilot 会自动同步
- \`attachments/\` 默认被 \`.gitignore\` 忽略，可按需修改
`

/** .gitignore 模板：默认忽略大文件 / 临时文件，但保留 notes/ 与 tasks/ */
const GITIGNORE_CONTENT = `# 大体积 / 二进制资源不入库
attachments/

# 系统临时文件
.DS_Store
Thumbs.db
*.tmp
*.swp

# 编辑器
.vscode/
.idea/
`

/**
 * 检查指定路径是否已存在
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (_) {
    return false
  }
}

/**
 * 初始化库目录骨架
 * - 若 <libraryPath>/.taskpilot 已存在则跳过创建
 * - 否则创建 .taskpilot/tasks/notes/attachments 子目录与说明文件
 *
 * 返回创建后 .taskpilot 的绝对路径
 */
export async function initializeLibrary(libraryPath: string): Promise<string> {
  if (!libraryPath) {
    throw new Error('libraryPath is empty')
  }

  const tpRoot = join(libraryPath, TASKPILOT_DIR)

  if (await exists(tpRoot)) {
    log.info(`[library] .taskpilot already exists at: ${tpRoot}`)
    // 即便存在，也确保子目录齐全（防止用户误删）
    await ensureSubdirs(tpRoot)
    return tpRoot
  }

  log.info(`[library] initializing library at: ${libraryPath}`)

  // 创建顶层 .taskpilot 目录
  await mkdir(tpRoot, { recursive: true })

  // 创建子目录
  await ensureSubdirs(tpRoot)

  // 写入 README 与 .gitignore（首次创建时）
  await writeFile(join(tpRoot, 'README.md'), README_CONTENT, 'utf-8')
  await writeFile(join(tpRoot, '.gitignore'), GITIGNORE_CONTENT, 'utf-8')

  log.info(`[library] library initialized at: ${tpRoot}`)
  return tpRoot
}

/**
 * 确保子目录存在（幂等）
 */
async function ensureSubdirs(tpRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(tpRoot, TASKS_DIR), { recursive: true }),
    mkdir(join(tpRoot, NOTES_DIR), { recursive: true }),
    mkdir(join(tpRoot, ATTACHMENTS_DIR), { recursive: true }),
  ])
}

/**
 * 判断库是否已经初始化（存在 .taskpilot 目录）
 */
export async function isLibraryInitialized(libraryPath: string): Promise<boolean> {
  const tpRoot = join(libraryPath, TASKPILOT_DIR)
  return exists(tpRoot)
}
