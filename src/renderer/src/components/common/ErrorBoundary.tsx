/**
 * 全局 ErrorBoundary（R7S-2 修复）
 *
 * 渲染端之前完全没有错误边界 —— 任何一个组件 render 抛错（IPC 异常 payload、
 * dangerouslySetInnerHTML 解析失败、深层 prop 链 undefined 访问）都会把整个
 * React 树卸载，用户看到空白窗口，无法恢复。
 *
 * 这里实现一个最小但够用的 ErrorBoundary：
 *   - getDerivedStateFromError 切换到「已捕获」视图
 *   - componentDidCatch 把错误详情上报主进程（用于 boot-trace）+ 控制台
 *   - 提供「复制详情」「重新加载」「回到首页」三种恢复路径
 */
import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  info: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info })
    // 把渲染端崩溃上报到主进程 boot-trace，便于事后定位。
    // 失败也仅 console.error，不影响主流程。
    try {
      void window.api?.invoke('app:error', {
        message: error.message,
        stack: error.stack ?? null,
        componentStack: info.componentStack ?? null,
      })
    } catch (err) {
      console.error('[ErrorBoundary] failed to report error', err)
    }
    console.error('[ErrorBoundary] caught render error:', error, info)
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleCopy = async (): Promise<void> => {
    const text = [
      `Error: ${this.state.error?.message ?? '(no message)'}`,
      '',
      'Stack:',
      this.state.error?.stack ?? '(no stack)',
      '',
      'Component stack:',
      this.state.info?.componentStack ?? '(none)',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      alert('错误详情已复制到剪贴板')
    } catch {
      // 回退：选中文本让用户手动复制
      console.log(text)
      alert('复制失败，请查看 DevTools console 获取详情')
    }
  }

  handleHome = (): void => {
    // 简易恢复：清掉 hasError 后回到根路由。比起 reload 更轻。
    this.setState({ hasError: false, error: null, info: null })
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="error-boundary" role="alert" aria-live="assertive">
        <div className="error-boundary-card">
          <h1>出了点问题</h1>
          <p>渲染层发生未捕获的错误，整个 UI 已经被中止以避免更严重的状态污染。</p>
          <pre className="error-boundary-detail">
            {this.state.error?.message ?? 'Unknown error'}
          </pre>
          <div className="error-boundary-actions">
            <button className="btn ghost" onClick={this.handleCopy}>复制详情</button>
            <button className="btn ghost" onClick={this.handleHome}>回到首页</button>
            <button className="btn primary" onClick={this.handleReload}>重新加载</button>
          </div>
        </div>
      </div>
    )
  }
}
