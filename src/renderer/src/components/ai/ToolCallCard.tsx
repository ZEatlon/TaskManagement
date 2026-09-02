/**
 * 工具调用卡片
 *
 * 渲染一次工具调用：
 *   - 工具名
 *   - 入参（折叠）
 *   - 状态 (calling / done / error)
 *   - 结果（折叠）
 */
import { useState } from 'react'

interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result?: unknown
  status: 'calling' | 'done' | 'error'
}

interface Props {
  tool: ToolCall
}

export function ToolCallCard({ tool }: Props) {
  const [open, setOpen] = useState(false)
  const statusLabel =
    tool.status === 'calling' ? '调用中…' : tool.status === 'done' ? '完成' : '出错'
  const statusClass = `ai-tool-status ai-tool-${tool.status}`

  return (
    <div className={`ai-tool-card ${tool.status}`}>
      {/* R12 修复 (high)：原版 role="button" 但没有 tabIndex / aria-expanded /
          onKeyDown，键盘与屏幕阅读器无法展开/折叠。补齐 a11y。 */}
      <button
        type="button"
        className="ai-tool-head"
        aria-expanded={open}
        aria-controls={`ai-tool-body-${tool.id}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ai-tool-name">
          <span className="ai-tool-icon" aria-hidden>⚙</span>
          {tool.name}
        </span>
        <span className={statusClass}>{statusLabel}</span>
        <span className="ai-tool-toggle" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ai-tool-body" id={`ai-tool-body-${tool.id}`}>
          <div className="ai-tool-section">
            <div className="ai-tool-label">参数</div>
            <pre className="ai-tool-pre">{JSON.stringify(tool.args, null, 2)}</pre>
          </div>
          {tool.result !== undefined && (
            <div className="ai-tool-section">
              <div className="ai-tool-label">结果</div>
              <pre className="ai-tool-pre">
                {typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ToolCallCard
