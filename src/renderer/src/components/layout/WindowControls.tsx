/**
 * 自定义窗口栏控制按钮（Windows 11 原生风格 · Segoe Fluent Icons）
 *
 * 平台策略：
 * - macOS 上 titleBarStyle: 'hiddenInset' 已经把系统三圆点放在左上角，
 *   我们再放一份会和系统原生控件重叠，因此这里检测到 darwin 时直接返回 null。
 * - Windows / Linux 上 frame: false → 没有系统按钮，必须自己画。
 *
 * 视觉：
 * - 46×32 的扁平矩形按钮，hover 时显示对应 accent 背景 + icon
 * - hover 颜色取自 Windows 11 系统强调色：
 *     min/max = #cce4f7 (light) / #2c2c2c (dark) + 文字色
 *     close   = #c42b1c (light) / #c42b1c (dark) + 白字
 * - 图标使用 Segoe Fluent Icons 风格（— ⬜ ✕），svg 自绘
 * - max/restore 图标根据 isMaximized 状态实时切换（订阅主进程推送）
 *
 * a11y：
 * - focus-visible 时显示 2px accent ring
 * - role="group" + aria-label 包裹三个按钮
 */
import { useEffect, useState } from 'react'

const isMac = window.api.platform === 'darwin'

export function WindowControls() {
  // R6R-2：必须先声明所有 hooks，再做 early-return —— 之前 isMac 早返会跳过
  // 后续的 useState/useEffect，违反 Rules of Hooks，未来 isMac 一旦变化（运行时
  // 切换或测试环境 mock）就会触发 "Rendered fewer hooks than expected" 崩溃。
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (isMac) return
    let alive = true
    // 初次获取当前状态
    window.api.window
      .isMaximized()
      .then((v) => {
        if (alive) setMaximized(v)
      })
      .catch(() => {
        /* ignore */
      })
    // 订阅主进程推送
    const off = window.api.window.onMaximizeChanged((_e, v) => {
      setMaximized(v)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // macOS 跳过订阅 + 不渲染 UI；保留 hooks 顺序稳定。
  if (isMac) return null

  const handleMin = () => {
    void window.api.window.minimize()
  }
  const handleMax = () => {
    void window.api.window.toggleMaximize()
  }
  const handleClose = () => {
    void window.api.window.close()
  }

  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="wc-btn wc-minimize"
        onClick={handleMin}
        title="最小化"
        aria-label="最小化"
      >
        <svg
          className="wc-glyph"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          fill="none"
        >
          <line
            x1="1"
            y1="5"
            x2="9"
            y2="5"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="square"
          />
        </svg>
      </button>
      <button
        type="button"
        className={`wc-btn wc-maximize${maximized ? ' is-maximized' : ''}`}
        onClick={handleMax}
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
      >
        {maximized ? (
          // 还原：两个交错的方框（Win11 Fluent 风格）
          <svg
            className="wc-glyph"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden
            fill="none"
          >
            <rect
              x="2.5"
              y="0.5"
              width="7"
              height="7"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
            <rect
              x="0.5"
              y="2.5"
              width="7"
              height="7"
              stroke="currentColor"
              strokeWidth="1"
              fill="var(--bg-elevated, #ffffff)"
            />
          </svg>
        ) : (
          // 最大化：单个方框
          <svg
            className="wc-glyph"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden
            fill="none"
          >
            <rect
              x="1.5"
              y="1.5"
              width="7"
              height="7"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="wc-btn wc-close"
        onClick={handleClose}
        title="关闭"
        aria-label="关闭"
      >
        <svg
          className="wc-glyph"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          fill="none"
        >
          <line
            x1="1"
            y1="1"
            x2="9"
            y2="9"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="square"
          />
          <line
            x1="9"
            y1="1"
            x2="1"
            y2="9"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="square"
          />
        </svg>
      </button>
    </div>
  )
}
