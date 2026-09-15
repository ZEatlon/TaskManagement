/**
 * sticky-notes main 模块 barrel
 *
 * 暴露便签提醒派发服务的 start / stop + 手动触发。
 * 入口 main/index.ts 在 app ready 之后调用 startNotifier()，
 * 在 app before-quit 中调用 stopNotifier()。
 */
export { startNotifier, stopNotifier, runOnce } from './notifier'