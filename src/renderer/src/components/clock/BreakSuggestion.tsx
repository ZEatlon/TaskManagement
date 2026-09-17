/**
 * 休息建议卡 —— Clock 页右侧栏的占位组件
 *
 * 当前实现：静态文案 + 简单的「上一阶段类型 → 下一步建议」逻辑，
 * 不调任何后端、不读 sticky store。
 *
 * 后续（W2-B）：接入 AI 助手 daemon 后，这个组件会被替换为：
 *   - 后台 daemon 推过来的 hint（久坐 / streak 里程碑 / 久编辑 / 反思请求）
 *   - 点「需要聊聊」按钮打开 chat 面板，复用现有 /ai 路由
 *
 * 现在的占位让 Clock 页不至于右侧空一坨；同时给出明确的迁移指引，
 * 避免未来 PR 把这里当成「真的」休息建议引擎做反向兼容。
 */
import { usePomodoroStore } from '../../stores/pomodoro'
import { Sparkles } from '@renderer/lib/icon'

const FALLBACK_TIPS: ReadonlyArray<{ match: (mode: string | undefined) => boolean; text: string }> = [
  {
    match: (m) => m === 'focus',
    text: '专注中 —— 把手机翻面放一边，关闭无关标签页；遇到分心立刻记到便签再回来。',
  },
  {
    match: (m) => m === 'shortBreak',
    text: '短休息 —— 离开座位活动 2 分钟，喝口水、看远处，让眼睛和肩膀松一下。',
  },
  {
    match: (m) => m === 'longBreak',
    text: '长休息 —— 可以离开屏幕走几步；下一轮专注前想一个最小可执行的「下一步」。',
  },
]

export function BreakSuggestion(): React.JSX.Element {
  // 仅订阅 control.mode（一个字符串）—— 比订阅整个 control.state 更省 re-render
  const mode = usePomodoroStore((s) => s.control.mode)
  const matched = FALLBACK_TIPS.find((t) => t.match(mode))
  const text = matched?.text ?? '开始一个番茄专注 25 分钟，看看这一轮能推进多少。'

  return (
    <div className="clock-break-suggestion" role="note" aria-label="休息建议">
      <header className="clock-break-suggestion__header">
        <Sparkles size={14} aria-hidden />
        <span>休息建议</span>
      </header>
      <p className="clock-break-suggestion__body">{text}</p>
      <p className="clock-break-suggestion__hint">
        AI 主动提醒将在后续版本接入。
      </p>
    </div>
  )
}
