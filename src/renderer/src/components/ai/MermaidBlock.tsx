/**
 * Mermaid 图表块
 *
 * - 首次挂载时调用 mermaid.render() 渲染 SVG
 * - 右上角提供"源码 / 渲染"切换，方便排查语法错误
 * - 渲染失败时展示友好的错误信息 + 可折叠的原始源码
 */
import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

type Mode = 'rendered' | 'source'

interface Props {
  source: string
}

let mermaidInited = false
/**
 * 全局只需 init 一次；多次调用 mermaid.init() 是安全的，但会重复挂事件，
 * 因此用 module 级 flag 节流。
 */
function ensureMermaidInit() {
  if (mermaidInited) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    // 字号略微缩小，匹配聊天窗口的紧凑布局
    fontSize: 13,
    securityLevel: 'strict',
    // flowchart 用 orthogonal 让边尽量走横平竖直，少占用空间
    flowchart: { curve: 'basis' }
  })
  mermaidInited = true
}

export function MermaidBlock({ source }: Props) {
  const [mode, setMode] = useState<Mode>('rendered')
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  // 用 ref 记录当前渲染任务对应的 source，新一轮渲染开始前丢弃旧结果
  const tokenRef = useRef(0)

  useEffect(() => {
    if (mode !== 'rendered') return
    ensureMermaidInit()
    const token = ++tokenRef.current
    // mermaid.render 是异步的，多个实例可能并行；用 id 保证每个图唯一
    const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`
    let cancelled = false

    mermaid
      .render(id, source)
      .then((res) => {
        if (cancelled || tokenRef.current !== token) return
        setSvg(res.svg)
        setError('')
      })
      .catch((err: unknown) => {
        if (cancelled || tokenRef.current !== token) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setSvg('')
        // eslint-disable-next-line no-console
        console.warn('[MermaidBlock] render failed:', err)
      })

    return () => {
      cancelled = true
    }
  }, [source, mode])

  return (
    <div className="ai-mermaid-block">
      <div className="ai-mermaid-block-header">
        <span className="mermaid-label">Mermaid</span>
        <div className="ai-mermaid-toggle" role="tablist" aria-label="Mermaid 视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            className={mode === 'source' ? 'active' : ''}
            onClick={() => setMode('source')}
          >
            源码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'rendered'}
            className={mode === 'rendered' ? 'active' : ''}
            onClick={() => setMode('rendered')}
          >
            渲染
          </button>
        </div>
      </div>

      {mode === 'rendered' ? (
        error ? (
          <div className="ai-mermaid-error">
            <div>渲染失败：{error}</div>
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer' }}>查看源码</summary>
              <pre className="ai-mermaid-source">{source}</pre>
            </details>
          </div>
        ) : svg ? (
          <div
            className="ai-mermaid-render"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="ai-mermaid-render" style={{ color: 'var(--text-secondary)' }}>
            渲染中…
          </div>
        )
      ) : (
        <pre className="ai-mermaid-source">{source}</pre>
      )}
    </div>
  )
}

export default MermaidBlock