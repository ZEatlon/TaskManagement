/**
 * W2-A note-handlers 拆分 —— 入口聚合
 *
 * 渲染端 preload + 主进程 router 仍调用 `registerNoteHandlers()`（保持接口
 * 不变），这里把它委托给子模块。每个子模块负责一组相关通道：
 *
 *   crud.ts    —— note:list / read / write / delete / search / tags /
 *                tag-list / rename / set-starred
 *   folders.ts —— note-folder:* / move-to-folder / list-by-folder(s)
 *   files.ts   —— note:watch-start/stop / report-edit / resolve / file-state(s) /
 *                resolve-asset
 *   export.ts  —— note:export-pdf
 *
 * 共用校验器（assertId / validateNotePayload / 字节常量）在 `_shared.ts`。
 *
 * 历史：原 note-handlers.ts 612 行单文件，含上述全部 handler。按子域拆为
 * 5 个文件后单文件最大 200 行以下，搜索定位成本降低。子模块可独立单测
 * （无须整个 CRUD 表才能跑）。
 */
import { registerNoteCrudHandlers } from './crud'
import { registerNoteFolderHandlers } from './folders'
import { registerNoteFileHandlers } from './files'
import { registerNoteExportHandlers } from './export'

export function registerNoteHandlers(): void {
  registerNoteCrudHandlers()
  registerNoteFolderHandlers()
  registerNoteFileHandlers()
  registerNoteExportHandlers()
}
