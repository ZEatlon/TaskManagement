/// <reference types="vite/client" />

/**
 * 渲染端 window.api 类型声明
 *
 * 真正的 API 形态由 src/preload/index.ts 定义（带运行时约束：
 * channel 白名单、safeStorage 加密等）。这里通过 `import type`
 * 复用 preload 端导出的 TaskPilotApi —— TS 会在编译期擦除该
 * import，不会把 preload 的运行时副作用（contextBridge、ipcRenderer）
 * 拉进 renderer bundle。
 *
 * 历史：旧版本在 global.d.ts 里手抄 API surface，preload 加新方法后
 * 这里经常漏更新，导致 TS 报错与运行时方法对不上。改为单一来源
 * （preload/index.ts）后两边自动同步。
 */
import type { TaskPilotApi as PreloadTaskPilotApi } from '../../preload'

export type TaskPilotApi = PreloadTaskPilotApi

declare global {
  interface Window {
    api: TaskPilotApi
  }
}

export {}
