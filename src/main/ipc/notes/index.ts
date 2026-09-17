/**
 * W2-A note-handlers 拆分 —— 入口聚合
 *
 * 渲染端 preload + 主进程 router 仍调用 `registerNoteHandlers()`（保持接口
 * 不变），这里把它委托给子模块。每个子模块负责一组相关通道：
 *
 *   crud.ts     —— note:list / read / write / delete / search / tags /
 *                 tag-list / rename / set-starred
 *   folders.ts  —— note-folder:* / move-to-folder / list-by-folder(s)
 *   files.ts    —— note:watch-start/stop / report-edit / resolve / file-state(s) /
 *                 resolve-asset
 *   export.ts   —— note:export-pdf
 *   lifecycle.ts —— W2-A④ 回收站（trash / restore / purge / list-trash）+
 *                  版本历史（list-revisions / read-revision / restore-revision）
 *
 * 共用校验器（assertId / validateNotePayload / 字节常量）在 `_shared.ts`。
 */
import { registerNoteCrudHandlers } from './crud'
import { registerNoteFolderHandlers } from './folders'
import { registerNoteFileHandlers } from './files'
import { registerNoteExportHandlers } from './export'
import { registerNoteLifecycleHandlers } from './lifecycle'

export function registerNoteHandlers(): void {
  registerNoteCrudHandlers()
  registerNoteFolderHandlers()
  registerNoteFileHandlers()
  registerNoteExportHandlers()
  registerNoteLifecycleHandlers()
}
