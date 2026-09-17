/**
 * AI Insight Dashboard Widget
 *
 * 作用：
 *   - 在 Dashboard 顶部番茄钟附近呈现一条 AI 提示卡，引导用户用 AI
 *     助手规划 / 复盘今日
 *   - 渲染逻辑：纯前端派生当前番茄钟状态 / 今日便签数 / 今日已完成番茄数，
 *     给出 3 条 prompt 建议（"规划本节"、"解释今日统计"、"写今日复盘"）
 *   - 点 prompt → 调 useAiStore.openWithPrompt(prompt) → 打开 CommandBar
 *
 * 跟 InlineAIButton 的差异：
 *   - InlineAIButton 是「便签 / 笔记 / 番茄钟面板内部」的上下文内触发器，
 *     菜单项是"拆解 / 润色 / 总结"等对**单个实体**的操作
 *   - AIInsightCard 是 Dashboard 全局视角的"软引导"卡片，提示语都是对
 *     全局状态（今天）而非单个便签。两者**职责不重叠**：
 *     - 内嵌按钮 = 当前实体的微观操作
 *     - 全局卡片 = 今天的宏观洞察
 *
 * 派生字段（不订阅每秒 tick）：
 *   - pomodoroRunning / pomodoroMode（用户视角：本节专注吗？）
 *   - todayStickies / todayDoneSteps（来自 useDashboardHook 父组件传入）
 *
 * 不做：
 *   - 不主动调 LLM（避免烧 token、避免冷启动时跳错误）
 *   - 不持久化选择历史
 */
import { useMemo } from 'react'
import { Sparkles, ChevronRight } from '@renderer/lib/icon'
import { useAiStore } from '../../stores/ai'
import { usePomodoroStore } from '../../stores/pomodoro'
import type { TodayStats } from './TodaySummary'

interface Props {
  /** 来自父组件路由，已经派生好的"今日"统计 */
  todayStats: TodayStats
}

interface Suggestion {
  /** 主标题（一行） */
  title: string
  /** 副标题（解释为什么 AI 推荐这条） */
  reason: string
  /** 点击触发后的 prompt 模板 */
  prompt: string
}

/**
 * 根据番茄钟状态 + 今日便签数派生 3 条建议。
 * 规则保持简单可解释 —— 用户能看懂"为什么 AI 推荐这条"。
 */
function pickSuggestions(input: {
  pomodoroRunning: boolean
  pomodoroMode: 'focus' | 'shortBreak' | 'longBreak'
  todayStickies: number
  todayDoneSteps: number
  overdue: number
}): Suggestion[] {
  const out: Suggestion[] = []

  if (input.pomodoroRunning && input.pomodoroMode === 'focus') {
    out.push({
      title: 'AI 规划本节做什么',
      reason: '正在专注 —— 让 AI 基于今日便签给出本节要做的 1-2 件事',
      prompt:
        '我正在专注一节番茄钟，请根据今天我的便签清单（任务 / 步骤）推荐本节最值得推进的 1-2 个具体动作，给出可执行清单。',
    })
  } else if (input.pomodoroRunning && input.pomodoroMode !== 'focus') {
    out.push({
      title: 'AI 解释今日统计',
      reason: '正在休息 —— 让 AI 解读今日已完成番茄 / 步骤进度',
      prompt:
        '我刚结束一节番茄正在休息。请基于今日番茄完成数、便签完成度，告诉我目前节奏是否合理，下一节专注建议做什么。',
    })
  } else {
    // idle 状态
    out.push({
      title: 'AI 规划今天做什么',
      reason: '当前没在专注 —— 让 AI 给我今天 1-3 件最重要的事',
      prompt:
        '今天我还没开始专注。请根据今天的便签（按优先级 / 截止 / 标签）推荐 1-3 件最值得做的具体任务，给出每项 25 分钟内的可执行版本。',
    })
  }

  // 第 2 条：永远推荐"复盘" —— 与番茄状态无关
  out.push({
    title: 'AI 写今日复盘',
    reason: '随时可触发 —— 让 AI 把今天已完成 / 未完成整理成短复盘',
    prompt:
      '请基于今天我完成的番茄数、便签步骤进度，给我写一段今日短复盘（150 字内），包括：今天做对了什么 / 卡在哪 / 明天改一件事。',
  })

  // 第 3 条：仅在有逾期时推"延期 / 重新规划"
  if (input.overdue > 0) {
    out.push({
      title: 'AI 重新规划逾期便签',
      reason: `你有 ${input.overdue} 条逾期便签 —— 让 AI 给出延期 / 重排建议`,
      prompt: `我有 ${input.overdue} 条逾期便签，请帮我逐条决定：延期到哪一天 / 缩小范围 / 直接取消。给出表格形式的结论。`,
    })
  } else if (input.todayStickies > 0 && input.todayDoneSteps === 0) {
    out.push({
      title: 'AI 拆解第一个便签',
      reason: '今日便签还没开始 —— 让 AI 拆解第一条作为起步',
      prompt:
        '我今天有便签但还没推进任何步骤。请挑出优先级最高的一条，把它拆成 3-5 个 25 分钟内可完成的步骤，给我第一步做什么。',
    })
  } else {
    out.push({
      title: 'AI 总结今日产出',
      reason: '今日已有产出 —— 让 AI 把成果整理成可对外讲的版本',
      prompt:
        '今天我已完成若干番茄 + 步骤。请基于今日数据写一段不超过 100 字的"今日成果"摘要，方便我贴到日报 / 周报里。',
    })
  }

  return out
}

export function AIInsightCard({ todayStats }: Props) {
  const openWithPrompt = useAiStore((s) => s.openWithPrompt)
  // AI 已配置任一 provider 即视为"启用"。providers 是后端从 settings
  // 读出的快照（loadProviders 触发）。空数组 = 未配置任何 provider，
  // 此时任何 openWithPrompt 都会落到"打开 CommandBar 让用户先选 provider"
  // 路径 —— 不报错但体验割裂（用户以为点卡片没反应）。
  const aiEnabled = useAiStore((s) => s.providers.length > 0)

  // 只订阅稳定字段，避免每秒 tick 触发重渲染
  const pomodoroRunning = usePomodoroStore((s) => s.control.running)
  const pomodoroMode = usePomodoroStore((s) => s.control.mode)

  const suggestions = useMemo(
    () =>
      pickSuggestions({
        pomodoroRunning,
        pomodoroMode,
        todayStickies: todayStats.todayStickies,
        todayDoneSteps: todayStats.todayDoneSteps,
        overdue: todayStats.overdue,
      }),
    [pomodoroRunning, pomodoroMode, todayStats],
  )

  const handleClick = (prompt: string) => {
    void openWithPrompt(prompt)
  }

  // AI 未启用时降级为引导卡片（不显示建议，点击走设置）
  if (!aiEnabled) {
    return (
      <section className="dashboard-card ai-insight-card is-disabled" aria-label="AI 洞察（未启用）">
        <header className="ai-insight-header">
          <Sparkles size={16} aria-hidden className="ai-insight-sparkles" />
          <h3 className="ai-insight-title">AI 洞察</h3>
        </header>
        <p className="ai-insight-empty muted small">
          AI 助手未启用 —— 在设置中开启后可获得每日个性化建议。
        </p>
      </section>
    )
  }

  return (
    <section className="dashboard-card ai-insight-card" aria-label="AI 洞察建议">
      <header className="ai-insight-header">
        <Sparkles size={16} aria-hidden className="ai-insight-sparkles" />
        <h3 className="ai-insight-title">AI 洞察</h3>
        <span className="ai-insight-subtitle muted small">
          基于今日便签 + 番茄状态
        </span>
      </header>
      <ul className="ai-insight-list">
        {suggestions.map((s, idx) => (
          <li key={idx} className="ai-insight-item">
            <button
              type="button"
              className="ai-insight-btn"
              onClick={() => handleClick(s.prompt)}
              aria-label={`${s.title}：${s.reason}`}
            >
              <span className="ai-insight-item-title">{s.title}</span>
              <span className="ai-insight-item-reason muted small">{s.reason}</span>
              <ChevronRight
                size={14}
                aria-hidden
                className="ai-insight-item-chevron"
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default AIInsightCard