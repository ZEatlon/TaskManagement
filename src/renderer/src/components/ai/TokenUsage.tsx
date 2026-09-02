/**
 * Token 用量显示
 *
 * 展示本次对话累计 input / output / 总和 token，自动按 K / M / B 单位格式化。
 *
 * 单位规则（与 Anthropic / OpenAI 仪表盘对齐）：
 *   - n < 1_000       → 原样显示        "123"        "123 token"
 *   - n < 1_000_000   → K，保留 1 位小数 "1.2K" / "12.5K"
 *   - n < 1_000_000_000 → M，保留 1 位小数 "1.2M" / "123.4M"
 *   - n ≥ 1_000_000_000 → B，保留 1 位小数 "1.2B"
 *
 * 显示：
 *   - ↓ input  ↑ output  Σ total
 *   - total 加 accent 色 + 加粗，作为「本次对话累计消耗」主指标
 *   - 数字 + 单位均使用等宽字体，便于对齐阅读
 */

interface Props {
  input: number
  output: number
}

/** 把整数格式化为 K/M/B 字符串。始终显式带单位。 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1000) {
    return `${Math.round(n)}`
  }
  if (abs < 1_000_000) {
    return `${trimZeros((n / 1000).toFixed(1))}K`
  }
  if (abs < 1_000_000_000) {
    return `${trimZeros((n / 1_000_000).toFixed(1))}M`
  }
  return `${trimZeros((n / 1_000_000_000).toFixed(1))}B`
}

/** 把 "1.0" / "12.5" 这种格式压缩成 "1" / "12.5"（去掉无意义的 .0） */
function trimZeros(s: string): string {
  if (s.includes('.')) {
    return s.replace(/\.0+$/, '')
  }
  return s
}

/** 完整带单位的标题文字（用于 title 与 aria-label） */
function describeTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 token'
  return `${n.toLocaleString()} token`
}

export function TokenUsage({ input, output }: Props) {
  const total = input + output
  return (
    <div
      className="ai-token-usage"
      title={`本次对话累计消耗：${describeTokens(total)}（输入 ${describeTokens(input)} · 输出 ${describeTokens(output)}）`}
      aria-label={`Token 用量：输入 ${describeTokens(input)}，输出 ${describeTokens(output)}，总计 ${describeTokens(total)}`}
    >
      <span className="ai-token-chip ai-token-in" title={`输入 ${describeTokens(input)}`}>
        <span className="ai-token-arrow" aria-hidden>
          ↓
        </span>
        <span className="ai-token-value">{formatTokens(input)}</span>
        <span className="ai-token-unit" aria-hidden>
          token
        </span>
      </span>
      <span className="ai-token-chip ai-token-out" title={`输出 ${describeTokens(output)}`}>
        <span className="ai-token-arrow" aria-hidden>
          ↑
        </span>
        <span className="ai-token-value">{formatTokens(output)}</span>
        <span className="ai-token-unit" aria-hidden>
          token
        </span>
      </span>
      <span
        className="ai-token-chip ai-token-total"
        title={`累计 ${describeTokens(total)}`}
      >
        <span className="ai-token-arrow" aria-hidden>
          Σ
        </span>
        <span className="ai-token-value">{formatTokens(total)}</span>
        <span className="ai-token-unit" aria-hidden>
          token
        </span>
      </span>
    </div>
  )
}

export default TokenUsage
