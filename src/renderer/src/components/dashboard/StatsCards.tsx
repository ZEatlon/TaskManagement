/**
 * 统计卡片三栏 —— 便签总数 / 本周完成 / AI Token
 *
 * 数据来源：
 *   - 便签总数 + 状态分布：父组件通过 props 传入派生值（避免组件内 IPC）
 *   - 本周完成（番茄完成数）：completionsApi.total(start, end)
 *   - AI Token（input/output 累计）：conversationsApi.getTotalTokens()
 */
import { useEffect, useState } from 'react'
import type { StickyNote } from '@shared/types'
import { completionsApi, conversationsApi } from '../../lib/ipc'
import { dayKeyOf } from '../../lib/date'

export interface StickyStatusBreakdown {
  todo: number
  inProgress: number
  done: number
  total: number
}

interface Props {
  stickies: StickyNote[]
  /** 由父组件 useMemo 派生的状态分布；不传时本组件自行遍历 stickies */
  breakdown?: StickyStatusBreakdown
}

function computeBreakdown(stickies: StickyNote[]): StickyStatusBreakdown {
  let todo = 0
  let inProgress = 0
  let done = 0
  for (const n of stickies) {
    if (n.archived) continue
    if (n.status === 'todo') todo++
    else if (n.status === 'in_progress') inProgress++
    else if (n.status === 'done') done++
  }
  return { todo, inProgress, done, total: stickies.filter((n) => !n.archived).length }
}

interface AiTokens {
  input: number
  output: number
}

function formatToken(n: number | null): string {
  if (n === null) return '—'
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}w`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function StatsCards({ stickies, breakdown }: Props) {
  const stats = breakdown ?? computeBreakdown(stickies)

  // 本周完成（completions 总数）
  const [weekDone, setWeekDone] = useState<number | null>(null)
  const stickiesCount = stickies.length
  useEffect(() => {
    let cancelled = false
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? 6 : day - 1
    const start = new Date(now)
    start.setDate(now.getDate() - diff)
    start.setHours(0, 0, 0, 0)
    const end = new Date(now)
    completionsApi
      .total(dayKeyOf(start), dayKeyOf(end))
      .then((n) => {
        if (!cancelled) setWeekDone(n ?? 0)
      })
      .catch(() => {
        if (!cancelled) setWeekDone(0)
      })
    return () => {
      cancelled = true
    }
  }, [stickiesCount])

  // AI Token 累计
  const [tokens, setTokens] = useState<AiTokens | null>(null)
  useEffect(() => {
    let cancelled = false
    conversationsApi
      .getTotalTokens()
      .then((t) => {
        if (!cancelled) setTokens(t ?? { input: 0, output: 0 })
      })
      .catch(() => {
        if (!cancelled) setTokens({ input: 0, output: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Token 输入 / 输出的相对比例（按总量归一）
  const totalTokens = (tokens?.input ?? 0) + (tokens?.output ?? 0)
  const inputRatio =
    totalTokens === 0 ? 0.5 : (tokens?.input ?? 0) / totalTokens
  const outputRatio = 1 - inputRatio

  return (
    <div className="stats-cards">
      {/* 便签总数 —— 顶部 accent 色带 + 状态堆叠条 + legend */}
      <article className="stats-card is-sticky" aria-label="便签总数">
        <div className="stats-card-head">
          <span className="stats-card-head-icon" aria-hidden />
          <span>便签</span>
        </div>
        <div className="stats-num">{stats.total}</div>
        <div className="stats-subtitle">总条数</div>
        <div className="stats-bar" aria-hidden>
          <span
            className="stats-bar-seg is-todo"
            style={{ flexGrow: Math.max(stats.todo, 0.001) }}
            title={`待办 ${stats.todo}`}
          />
          <span
            className="stats-bar-seg is-in-progress"
            style={{ flexGrow: Math.max(stats.inProgress, 0.001) }}
            title={`进行中 ${stats.inProgress}`}
          />
          <span
            className="stats-bar-seg is-done"
            style={{ flexGrow: Math.max(stats.done, 0.001) }}
            title={`已完成 ${stats.done}`}
          />
        </div>
        <div className="stats-legend">
          <span className="stats-legend-item">
            <span className="stats-legend-dot is-todo" />
            <span className="stats-legend-num">{stats.todo}</span>
            <span>待办</span>
          </span>
          <span className="stats-legend-item">
            <span className="stats-legend-dot is-in-progress" />
            <span className="stats-legend-num">{stats.inProgress}</span>
            <span>进行</span>
          </span>
          <span className="stats-legend-item">
            <span className="stats-legend-dot is-done" />
            <span className="stats-legend-num">{stats.done}</span>
            <span>完成</span>
          </span>
        </div>
      </article>

      {/* 本周完成 —— success accent + 大数字 + 副标题 */}
      <article className="stats-card is-pomodoro" aria-label="本周完成">
        <div className="stats-card-head">
          <span className="stats-card-head-icon" aria-hidden />
          <span>本周完成</span>
        </div>
        <div className="stats-num">
          {weekDone === null ? <span className="muted">…</span> : weekDone}
        </div>
        <div className="stats-subtitle">本周番茄完成数</div>
      </article>

      {/* AI Token —— purple accent + 输入/输出迷你比例条 */}
      <article className="stats-card is-tokens" aria-label="AI Token 用量">
        <div className="stats-card-head">
          <span className="stats-card-head-icon" aria-hidden />
          <span>AI Token</span>
        </div>
        <div className="stats-num">
          {tokens === null ? (
            <span className="muted">…</span>
          ) : (
            formatToken(tokens.input + tokens.output)
          )}
        </div>
        <div className="stats-subtitle">累计用量</div>
        <div className="stats-tokens" aria-hidden>
          <div className="stats-tokens-row">
            <span className="stats-tokens-label">输入</span>
            <span className="stats-tokens-track">
              <span
                className="stats-tokens-fill"
                style={{ width: `${inputRatio * 100}%` }}
              />
            </span>
            <span className="stats-tokens-value">
              {formatToken(tokens?.input ?? null)}
            </span>
          </div>
          <div className="stats-tokens-row">
            <span className="stats-tokens-label">输出</span>
            <span className="stats-tokens-track">
              <span
                className="stats-tokens-fill"
                style={{ width: `${outputRatio * 100}%` }}
              />
            </span>
            <span className="stats-tokens-value">
              {formatToken(tokens?.output ?? null)}
            </span>
          </div>
        </div>
      </article>
    </div>
  )
}

export default StatsCards