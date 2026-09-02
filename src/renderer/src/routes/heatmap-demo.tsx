/**
 * 热力图演示路由（Module 10 测试页）
 *
 * 用于展示 GitHub 风格的贡献热力图，并提供：
 * - 时间窗口切换（90 / 180 / 365 天）
 * - 一周起始日切换（周日 / 周一）
 * - 紧凑模式切换
 * - 手动触发回填
 */
import { useState } from 'react'
import { Heatmap } from '../components/heatmap'
import { heatmapApi } from '../lib/ipc'

export function HeatmapDemoRoute() {
  const [days, setDays] = useState(365)
  const [firstDayOfWeek, setFirstDayOfWeek] = useState<0 | 1>(0)
  const [compact, setCompact] = useState(false)
  const [backfillStatus, setBackfillStatus] = useState<string>('')

  async function handleBackfill(force: boolean) {
    setBackfillStatus('回填中...')
    try {
      const res = await heatmapApi.backfill(force)
      setBackfillStatus(
        `完成 · 任务: 扫描 ${res.completions.scanned} 插入 ${res.completions.inserted} · ` +
          `笔记: 扫描 ${res.noteEvents.scanned} 插入 ${res.noteEvents.inserted}`,
      )
    } catch (err) {
      setBackfillStatus(`失败: ${(err as Error).message}`)
    }
  }

  return (
    <div className="page heatmap-demo-page">
      <header className="page-header">
        <div>
          <h1>贡献热力图</h1>
          <p className="muted">GitHub 风格 · 基于任务完成 + 笔记事件</p>
        </div>
      </header>

      <section className="section">
        <div className="toolbar">
          <div className="toolbar-group">
            <label>时间窗口</label>
            <select value={days} onChange={(e) => setDays(parseInt(e.target.value, 10))}>
              <option value={90}>90 天</option>
              <option value={180}>180 天</option>
              <option value={365}>365 天</option>
            </select>
          </div>

          <div className="toolbar-group">
            <label>一周起始</label>
            <select
              value={firstDayOfWeek}
              onChange={(e) => setFirstDayOfWeek(parseInt(e.target.value, 10) as 0 | 1)}
            >
              <option value={0}>周日</option>
              <option value={1}>周一</option>
            </select>
          </div>

          <div className="toolbar-group">
            <label>
              <input
                type="checkbox"
                checked={compact}
                onChange={(e) => setCompact(e.target.checked)}
              />
              紧凑模式
            </label>
          </div>

          <div className="toolbar-group" style={{ marginLeft: 'auto' }}>
            <button className="btn" onClick={() => handleBackfill(false)}>
              增量回填
            </button>
            <button className="btn" onClick={() => handleBackfill(true)}>
              强制回填
            </button>
          </div>
        </div>

        {backfillStatus && <p className="muted" style={{ marginTop: 8 }}>{backfillStatus}</p>}
      </section>

      <section className="section">
        <div className="heatmap-card">
          <Heatmap days={days} firstDayOfWeek={firstDayOfWeek} compact={compact} />
        </div>
      </section>

      <section className="section">
        <h2>说明</h2>
        <ul className="muted" style={{ lineHeight: 1.8 }}>
          <li>每格代表一天，颜色深浅表示当天完成的任务数。</li>
          <li>鼠标悬浮可查看日期与具体计数。</li>
          <li>首次启动时会自动回填历史完成记录（基于 tasks.completed_at）。</li>
          <li>数据来源：`completions` 表（任务完成）+ `note_events` 表（笔记事件）。</li>
        </ul>
      </section>
    </div>
  )
}
