/**
 * InlineAIButton —— 向后兼容的薄 shim
 *
 * 原 InlineAIButton 与 InlineAIMenu 已合并为 InlineAIPicker（单一组件
 * 同时拥有 trigger 按钮与菜单浮层，避免 prop drilling / 死分支 prop）。
 * 本文件保留 InlineAIButton 这个具名导出，让所有现有消费者
 * （StickyNoteCard / NoteEditor / PomodoroTimerPanel）无需改动即可继续
 * 使用，同时把 InlineAITarget / InlineAIMenuItem 类型一并 re-export，
 * 满足下游 typing 需求。
 *
 * 新代码请直接 import { InlineAIPicker } from './InlineAIPicker'。
 */
export {
  InlineAIPicker,
  InlineAIPicker as InlineAIButton,
  type InlineAITarget,
  type InlineAIMenuItem,
} from './InlineAIPicker'
